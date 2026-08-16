-- Consume a short-lived pair code exactly once and only if it still belongs
-- to the vault's current token generation. Redis runs the script atomically,
-- so token rotation cannot interleave with the generation check.

local serialized = redis.call('GET', KEYS[1])
if not serialized then
  return nil
end

redis.call('DEL', KEYS[1])
local payload = cjson.decode(serialized)
local currentTokenHash = redis.call('HGET', KEYS[2], 'token')
if not currentTokenHash or currentTokenHash ~= payload.tokenHash then
  return nil
end

return {payload.vaultId, payload.vaultToken}
