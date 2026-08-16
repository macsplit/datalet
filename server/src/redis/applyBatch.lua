-- Atomically accept/reject and apply one patch batch for a vault, so the
-- accept decision (structural-creation dedup + per-field HLC last-write-wins)
-- and the seq/stream-position assignment stay correct under concurrent
-- writes from multiple stateless sync-server processes sharing this Redis.
-- Mirrors server/src/patchApply.ts's applyPatchesToStore and
-- server/src/vaultStore.ts's (now-removed) in-memory applyBatch — keep the
-- two in sync if either changes.
--
-- KEYS[1] seqKey       (string, INCR'd per accepted batch)
-- KEYS[2] storeKey      (hash: subjectId -> JSON record)
-- KEYS[3] hlcKey        (hash: "subjectId propKey" -> hlc string)
-- KEYS[4] streamKey     (stream: entry id "<seq>-0")
-- KEYS[5] batchKey       (string: batchId's assigned seq, for idempotency)
-- KEYS[6] tombstoneKey   (hash: subjectId -> deletedAtHlc, for a whole-record remove)
--
-- ARGV[1] nodeId
-- ARGV[2] hlc
-- ARGV[3] shape
-- ARGV[4] patches JSON array
-- ARGV[5] batch dedup key TTL, seconds
-- ARGV[6] stream MAXLEN (approximate trim)
-- ARGV[7] batchId
--
-- Returns {accepted (0/1), seq, reason, accepted patch count, submitted patch count}

local seqKey, storeKey, hlcKey, streamKey, batchKey, tombstoneKey =
  KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6]
local nodeId, hlc, shape, patchesJson, batchTtl, streamMaxLen, batchId =
  ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5]), tonumber(ARGV[6]), ARGV[7]

local function currentSeq()
  local s = redis.call('GET', seqKey)
  return tonumber(s) or 0
end

local existingResult = redis.call('GET', batchKey)
if existingResult then
  local decodedOk, decoded = pcall(cjson.decode, existingResult)
  if decodedOk and type(decoded) == 'table' then
    return { 1, decoded.seq, decoded.reason or '', decoded.acceptedCount, decoded.submittedCount }
  end
  -- Compatibility with idempotency entries written before counts existed.
  return { 1, tonumber(existingResult), '', 0, 0 }
end

local ok, patches = pcall(cjson.decode, patchesJson)
if not ok or type(patches) ~= 'table' then
  return { 0, currentSeq(), 'malformed patch batch', 0, 0 }
end

local MAX_BATCH = 5000
local MAX_PATH = 16384
if #patches > MAX_BATCH then
  return { 0, currentSeq(), 'batch too large', 0, #patches }
end
for i = 1, #patches do
  local p = patches[i]
  if type(p) ~= 'table' or (p.op ~= 'add' and p.op ~= 'remove')
      or type(p.path) ~= 'string' or #p.path > MAX_PATH then
    return { 0, currentSeq(), 'malformed patch in batch', 0, #patches }
  end
end

local function splitPath(path)
  local parts = {}
  for part in string.gmatch(path, '[^/]+') do
    table.insert(parts, part)
  end
  return parts
end

local function decodeSeg(seg)
  seg = string.gsub(seg, '~1', '/')
  seg = string.gsub(seg, '~0', '~')
  return seg
end

-- Returns subjectId, propKey (propKey is nil for a whole-record patch).
local function target(patch)
  local path = patch.path
  if string.sub(path, 1, 1) ~= '/' then return nil end
  local parts = splitPath(path)
  if #parts == 0 then return nil end
  local subjectId = decodeSeg(parts[1])
  local propKey = nil
  if parts[2] ~= nil then propKey = decodeSeg(parts[2]) end
  return subjectId, propKey
end

local function isSetPatch(patch)
  return patch.type == 'set' or patch.valType == 'set'
end

local STRUCTURAL = { ['@id'] = true, ['@graph'] = true, ['@type'] = true }

-- Lazily loaded per-subject record cache. `false` means "confirmed absent".
local storeCache = {}
local function loadRecord(subjectId)
  local cached = storeCache[subjectId]
  if cached ~= nil then return cached end
  local raw = redis.call('HGET', storeKey, subjectId)
  if raw then
    storeCache[subjectId] = cjson.decode(raw)
  else
    storeCache[subjectId] = false
  end
  return storeCache[subjectId]
end

local accepted = {}
local touchedOrder = {}
local touchedSet = {}
-- Seeded from any tombstone this batch's hlc supersedes (deletedAtHlc <
-- hlc); committed in the final loop below. A later whole-record remove for
-- the same subject in this same batch overwrites this back to a fresh
-- deletedAtHlc in the apply loop, so within-batch ordering still resolves
-- correctly.
local tombstoneState = {}
local anyTombstoneRejected = false
local anySupersededRejected = false
-- Fields this batch has already claimed. Patches inside one batch are an
-- ordered sequence, not competitors: they all carry the batch's single hlc,
-- so once the first one stores that hlc every later patch for the same field
-- would fail the strict `prevHlc < hlc` test and be dropped as "superseded"
-- by its own batch. An undo sends exactly that shape -- remove the field,
-- then add the previous value back -- which would otherwise arrive at the
-- vault as a bare removal. Within a batch the last patch for a field wins,
-- matching how the same list applies locally.
local claimedThisBatch = {}
local anyMalformedTarget = false

for i = 1, #patches do
  local patch = patches[i]
  local subjectId, propKey = target(patch)
  if subjectId ~= nil then
    -- A whole-record remove is remembered as a tombstone (deletedAtHlc) so a
    -- stale add/field-patch replayed later by a node that was offline
    -- across the delete can't resurrect the record (remote-sync-
    -- architecture.md §5) -- reject anything whose batch hlc doesn't
    -- strictly exceed the deletion's hlc. A strictly newer batch touching a
    -- tombstoned subject is a legitimate later write (e.g. deliberate
    -- recreation of the same id), so it proceeds normally and clears the
    -- tombstone below.
    local deletedHlc = redis.call('HGET', tombstoneKey, subjectId)
    local tombstoned = deletedHlc ~= false and hlc <= deletedHlc
    if tombstoned then
      anyTombstoneRejected = true
    else
      local take = false
      if isSetPatch(patch) then
        take = true
      elseif patch.op == 'add' and (propKey == nil or STRUCTURAL[propKey]) then
        -- Root/identity creation is write-once: drop a duplicate replay of a
        -- subject two racing nodes both tried to create (see the doc comment
        -- on STRUCTURAL_PROPS in the step-1 in-memory version this replaces).
        if loadRecord(subjectId) == false then take = true end
      elseif propKey == nil then
        take = true -- whole-record remove, unconditional for now
      else
        local hkey = subjectId .. ' ' .. propKey
        local prevHlc = redis.call('HGET', hlcKey, hkey)
        if prevHlc == false or prevHlc < hlc or claimedThisBatch[hkey] then
          redis.call('HSET', hlcKey, hkey, hlc)
          claimedThisBatch[hkey] = true
          take = true
        end
      end
      if take then
        table.insert(accepted, patch)
        if not touchedSet[subjectId] then
          touchedSet[subjectId] = true
          table.insert(touchedOrder, subjectId)
        end
        if deletedHlc ~= false then
          tombstoneState[subjectId] = 'clear'
        end
      else
        anySupersededRejected = true
      end
    end
  else
    anyMalformedTarget = true
  end
end

if #accepted == 0 then
  if anyTombstoneRejected then
    return { 0, currentSeq(), 'subject was deleted after this edit was made', 0, #patches }
  end
  if anyMalformedTarget then
    return { 0, currentSeq(), 'malformed patch target', 0, #patches }
  end
  return { 0, currentSeq(), 'superseded by a newer edit to the same field', 0, #patches }
end

local partialReason = ''
if #accepted < #patches then
  if anyTombstoneRejected then
    partialReason = 'subject was deleted after this edit was made'
  elseif anyMalformedTarget then
    partialReason = 'malformed patch target'
  elseif anySupersededRejected then
    partialReason = 'superseded by a newer edit to the same field'
  end
end

-- A JSON value's emptiness makes {} and [] indistinguishable after
-- cjson.decode. Both realistic shapes this app produces for a non-array,
-- non-set "add" value are "an object" (a container-creation placeholder, or
-- a populated non-array table) -- an empty table is treated as the former.
local function isContainerPlaceholder(v)
  if type(v) ~= 'table' then return false end
  if next(v) == nil then return true end
  return v[1] == nil
end

for i = 1, #accepted do
  local patch = accepted[i]
  local subjectId, propKey = target(patch)

  if propKey == nil then
    if patch.op == 'add' then
      if loadRecord(subjectId) == false then
        storeCache[subjectId] = { ['@id'] = subjectId, ['@graph'] = '' }
      end
      tombstoneState[subjectId] = 'clear'
    elseif patch.op == 'remove' then
      storeCache[subjectId] = false
      tombstoneState[subjectId] = hlc
    end
  else
    local record = loadRecord(subjectId)
    if record == false then
      record = { ['@id'] = subjectId, ['@graph'] = '' }
    end

    if isSetPatch(patch) then
      local current = record[propKey]
      if type(current) ~= 'table' then current = {} end
      local raw = patch.value
      local values = {}
      if raw ~= nil and raw ~= cjson.null then
        if type(raw) == 'table' then values = raw else values = { raw } end
      end
      if patch.op == 'add' then
        for _, v in ipairs(values) do
          local exists = false
          for _, cv in ipairs(current) do
            if cv == v then exists = true break end
          end
          if not exists then table.insert(current, v) end
        end
      elseif patch.op == 'remove' then
        for _, v in ipairs(values) do
          for idx, cv in ipairs(current) do
            if cv == v then table.remove(current, idx) break end
          end
        end
      end
      record[propKey] = current
    elseif patch.op == 'add' then
      if isContainerPlaceholder(patch.value) then
        if record[propKey] == nil then record[propKey] = patch.value end
      else
        record[propKey] = patch.value
      end
    elseif patch.op == 'remove' then
      record[propKey] = nil
    end

    storeCache[subjectId] = record
  end
end

for i = 1, #touchedOrder do
  local subjectId = touchedOrder[i]
  local record = storeCache[subjectId]
  if record == false then
    redis.call('HDEL', storeKey, subjectId)
  else
    redis.call('HSET', storeKey, subjectId, cjson.encode(record))
  end
  local tstate = tombstoneState[subjectId]
  if tstate == 'clear' then
    redis.call('HDEL', tombstoneKey, subjectId)
  elseif tstate ~= nil then
    redis.call('HSET', tombstoneKey, subjectId, tstate)
  end
end

local seq = redis.call('INCR', seqKey)
local entry = {
  seq = seq,
  nodeId = nodeId,
  batchId = batchId,
  hlc = hlc,
  shape = shape,
  patches = accepted,
}
redis.call('XADD', streamKey, 'MAXLEN', '~', streamMaxLen, seq .. '-0', 'data', cjson.encode(entry))
redis.call('SET', batchKey, cjson.encode({
  seq = seq,
  reason = partialReason,
  acceptedCount = #accepted,
  submittedCount = #patches,
}), 'EX', batchTtl)

return { 1, seq, partialReason, #accepted, #patches }
