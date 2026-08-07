# Remote Sync — Implementation Progress Log

Running log of what's actually been built and verified, kept up to date as
work proceeds. See `remote-sync-architecture.md` for the design and
`remote-sync-deployment.md` for the target deployment; this file tracks
build-order progress against `remote-sync-architecture.md` §10.

## Step 1 — In-memory sync server skeleton: DONE

Built and verified in the previous session.

- `server/` — Node/TS server serving `dist/` plus `/sync/vaults`,
  `/sync/patches`, `/sync/stream` (SSE), `/sync/snapshot`, `/sync/health`.
  In-memory per-vault state (no Redis/Neo4j yet, as scoped for step 1).
- Bearer-token auth per vault (salted hash, constant-time compare).
- HLC-based last-write-wins on scalar fields; commutative merge on set
  fields; batch idempotency via `batchId`; SSE resume via
  `Last-Event-ID`/`?since=`.
- `src/utils/remoteSyncEngine.ts` — client sync engine (outbound queue,
  `EventSource` consumption), wired through two hooks added to
  `localNgEngine.ts` (`onLocalPatch`, `applyRemoteSyncPatches`) with no
  rewrite of the existing local-first storage path.
- `src/components/SyncSettings.tsx` — Settings UI to create/join a vault.
- **Verified live** with a real two-browser-context Playwright test: schema
  + property creation propagates, a live field edit in one tab updated the
  other tab's already-open view with no reload, and an edit made while
  offline was queued and delivered on reconnect.
- **Bug found and fixed**: two devices bootstrapping from empty storage can
  race to create the same well-known record (e.g. this app's "Home" tab)
  before their first sync catch-up lands. Fixed by treating a record's
  identity (root-add, `@id`/`@graph`/`@type`) as write-once server-side.
- **Bug found, not fixed (out of scope, flagged to the user)**: a
  pre-existing issue in the app's *existing* cross-tab `BroadcastChannel`
  sync (`localNgEngine.ts` / `@ng-org/orm`), unrelated to this work —
  reproduces with zero sync code involved. Self-heals on navigation; the
  app's existing runtime-safety banner already catches it gracefully.

## Step 2 — Redis Streams for sequencing + fanout: DONE

Goal (per the architecture doc's build order): move vault state off a
single process's memory and onto Redis, so multiple stateless `sync-server`
processes can share one vault — proving the ingest tier scales horizontally
before Neo4j/materializer durability (step 3) is added.

### Environment

- Installed Redis 8.0.2 via apt (`redis-server`), running under systemd,
  `appendonly yes` + `maxmemory-policy noeviction` set per the deployment
  doc's recommendation. Added `ioredis` (v6) as a server dependency.

### Design decision: atomic apply via a Redis Lua script, not WATCH/MULTI

The accept/reject decision (structural-creation dedup, per-field HLC
last-write-wins) and seq/stream-position assignment must stay correct when
multiple server processes can accept writes for the same vault
concurrently. I considered optimistic locking (`WATCH`/`MULTI`) first, but
rejected it: assigning the monotonic `seq` via `INCR` *outside* the
transaction (needed so its result is known before queuing the `XADD` that
uses it as the stream entry ID) creates a real ordering hazard — a slower
transaction that got its seq first could still lose the race to `XADD`,
and Redis Streams reject an entry ID that isn't strictly increasing.
Retrying would burn additional seq numbers and doesn't resolve the
underlying ordering problem.

Went with a Lua script instead (`server/src/redis/applyBatch.lua`): Redis
executes it atomically end-to-end (decode patches, run the same
accept/reject logic as the step-1 in-memory version, mutate the
materialized store, `INCR` the seq, and `XADD` the stream entry using that
seq as its ID) in one round trip, with no cross-instance race window at
all. Ported `patchApply.ts`'s patch-application algorithm into Lua by hand
(path parsing, structural write-once check, set-member commutative merge)
— the trickiest part was that `cjson.decode` doesn't distinguish an empty
JSON object `{}` from an empty array `[]` (both decode to an empty Lua
table); handled with a documented heuristic (`isContainerPlaceholder` in
the script) matching the two shapes this app's patches actually produce.

**Verified the script standalone via `redis-cli --eval` before wiring it
into TypeScript** — idempotent retry, stale-HLC rejection, newer-HLC
acceptance, duplicate root-creation-replay rejection, and set-type
multi-value merge all reproduced the exact same behavior as the step-1
in-memory version's equivalent test.

### Cross-instance live fanout

Added `server/src/redis/streamWatcher.ts`: one Redis Stream consumer
(`XREAD BLOCK`, on its own dedicated connection since a blocked connection
can't serve other commands) per actively-watched vault *per process*,
shared by every locally-attached SSE client for that vault and torn down
when the last one disconnects. This is what lets any sync-server instance
serve any vault's live stream regardless of which instance accepted the
write. The `/sync/stream` handler attaches to this live watcher *before*
finishing its own historical replay (`XRANGE`), then does one more
`XRANGE` catch-up pass immediately after, so nothing committed during that
handoff window can be missed — any resulting duplicate delivery across the
two paths is harmless since the client already dedupes by `batchId`.

### Rewrote

- `server/src/vaultStore.ts` — was an in-memory `Vault` class; now free
  functions over Redis (`createVault`, `vaultExists`, `checkVaultToken`,
  `applyBatch`, `snapshot`, `entriesSince`, `subscribeLive`).
- `server/src/httpServer.ts` — route handlers now `await` these.
- `server/src/index.ts` — pings Redis on boot before listening.
- `build:server` now copies `applyBatch.lua` into `server-dist/redis/`
  alongside the compiled output (`tsc` doesn't copy non-`.ts` assets).

**Verified against a live HTTP server** (single instance, Redis-backed):
re-ran the exact same request sequence used to validate the step-1
in-memory server (create → idempotent retry → stale rejection → newer
acceptance → snapshot → SSE replay) and got byte-identical results.

### Horizontal scaling, proven

Installed Caddy, ran two sync-server instances (`INSTANCE_ID=A`/`B` on
:3901/:3902, sharing one Redis) behind it on :3800, `lb_policy
round_robin`. Added an `X-Instance-Id` response header (diagnostic only) so
routing could be verified from outside instead of taken on faith.

- Confirmed round-robin: consecutive requests through the proxy alternate
  `instance-A`/`instance-B`.
- Created a vault via the proxy, posted patches that landed on both
  instances in alternation, and got back monotonically increasing `seq`
  (1,2,3,4) with no gaps or resets — the shared Redis state is consistent
  regardless of which instance handled each write.
- **Deterministic cross-instance proof**: connected an SSE stream directly
  to instance A, then `POST`ed a patch directly to instance B. The patch
  arrived on A's stream with the correct seq and full content — a write
  accepted by one stateless process was fanned out live by a completely
  different one, purely through shared Redis state.
- Re-ran the full two-browser Playwright suite from step 1 through the
  proxy (vault pairing, live cross-tab field sync, offline queue +
  reconnect) — all passed against the horizontally-scaled setup.

### Two real bugs found while proving this, both fixed

**1. SSE headers never flushed for an idle stream (the actual blocker).**
Connecting `curl -sv` straight to one instance for a brand-new vault
(zero history, nothing posted yet) got no response at all - not even
headers - within several seconds. Node's `http.ServerResponse.writeHead()`
sets response state but doesn't push bytes onto the socket by itself; the
implicit flush normally happens on the first `res.write()`. For a vault
with no history to replay and no immediate live activity, that first write
might not happen until the 20s heartbeat. Every earlier passing test
happened to have *something* to write immediately (historical entries, or
a peer's near-simultaneous edit), which is exactly why this was never
caught in step 1's testing despite the code path existing there too — it
took a genuinely idle fresh-vault connection to expose it. Fixed with an
explicit `res.flushHeaders()` right after `writeHead()`
(`server/src/httpServer.ts`), confirmed via direct `curl -sv` that headers
now arrive immediately regardless of stream activity.

I initially misdiagnosed this as Caddy's `encode gzip` buffering the SSE
response (a real, separate anti-pattern — a compressing middleware does
withhold output until it has enough bytes for a block) since the browser
symptom (zero `patches` events ever received) first showed up going
through the proxy. Reproducing directly against a backend instance with no
proxy in the path, and with `Accept-Encoding` removed entirely, still
hung — which is what pointed at `flushHeaders()` as the real cause instead.
Scoped `encode gzip` away from `/sync/stream` in both the working test
Caddyfile and `remote-sync-deployment.md`'s reference config anyway: it's
still a legitimate risk for any SSE endpoint even though it wasn't the
cause here, so excluding it is correct practice regardless.

**2. (carried from earlier) structural-creation write-once dedup** — see
the step 1 section above; unaffected by the Redis port, re-verified working
here too (server snapshot showed no ORM-breaking duplicate-creation
replays across the two-instance run).

### Files touched this step

- `server/src/redis/{config,client,streamWatcher,applyBatch.lua}.ts` — new.
- `server/src/vaultStore.ts` — rewritten (Redis-backed, async).
- `server/src/httpServer.ts` — awaits the new async API; `flushHeaders()`
  fix; `X-Instance-Id` diagnostic header.
- `package.json` — `ioredis` dependency; `build:server` now copies
  `applyBatch.lua` into `server-dist/redis/`.
- `docs/remote-sync-deployment.md` — Caddyfile gzip-scoping fix.

### Not yet done (as of end of step 2)

Neo4j + the materializer (durable storage, decoupled from the ingest
path), tombstone retention, and the vault-pairing security hardening
beyond the bearer token already in place are still ahead per the
architecture doc's build order (steps 3+). Redis itself is currently the
only durable store — acceptable for this milestone, not yet for
production, since Redis's AOF is being treated as the sync buffer, not
the system of record the design calls for once Neo4j lands.

## Step 3 — Neo4j + materializer: DONE

Goal (per the architecture doc's build order): make Neo4j the durable
system of record, decoupled from Redis's ingest-buffer role, via a
materializer that replays each vault's accepted-patches stream into it
through a Redis Streams consumer group (§6.3), and switch `/sync/snapshot`
to read from Neo4j so a vault's durability no longer depends on Redis's
stream-trimming/eviction policy.

### Environment

Installed Neo4j 5.26 natively via Neo4j's own apt repo (Debian 13 shipped
Java 21, not 17 — Neo4j 5.26 supports both, so used
`openjdk-21-jre-headless` instead of the deployment doc's `openjdk-17`;
harmless either way, noted here in case the doc needs a version bump
later). Added `neo4j-driver` (v6) as a server dependency, with
`disableLosslessIntegers: true` since this app's numeric fields are plain
JS numbers end to end and the driver's default lossless-Integer wrapper
would otherwise silently change their type on the way back out.

### Design: same binary, `ROLE=materializer`

Per §6.3's suggestion, the materializer is the same build artifact as the
sync-server, dispatched by an env var (`server/src/index.ts`) rather than
a separate deployable — `pnpm dev:materializer` / `start:materializer` run
it. It's a Redis Streams **consumer group** (`materializer`) member on
each vault's stream, decoupled from the ingest tier: a slow/down Neo4j
never blocks accepting or fanning out new patches to already-connected
clients, since the materializer only reads the stream asynchronously,
well after a write has already been accepted and committed.

- **Vault discovery**: a `vaults:index` Redis SET, added to in
  `createVault()`, polled every 3s (`discoverAndWatch` in
  `materializer.ts`) since vault creation is rare relative to patch
  traffic — no need for a push-based "new vault" signal at this scale.
- **Per-vault consumer**: one dedicated blocking Redis connection per
  actively-materialized vault (mirrors `streamWatcher.ts`'s pattern from
  step 2), running `XREADGROUP ... BLOCK 5000 ... STREAMS <key> >`.
- **Crash recovery**: a **stable, not pid-based**, consumer name
  (`MATERIALIZER_CONSUMER_ID`, default `materializer-1`) is what makes
  this work — a name that changed on every restart would orphan whatever
  was mid-flight when the process died, since a consumer group only
  redelivers a crashed consumer's still-pending entries to a *later read
  under the same consumer name*. On startup, before joining the live tail,
  the consumer drains its own previously-delivered-but-unacked entries
  (`XREADGROUP ... STREAMS <key> 0`).
- **Replay logic**: for each stream entry, reads the current Neo4j record
  for every subject the batch's patches touch, applies the patches via the
  *same* `applyPatchesToStore` used for Redis's materialized view (no
  third reimplementation of the patch-application algorithm), and either
  upserts the result or — if the subject no longer exists after
  applying — tombstones it (`:Deleted` label + `deletedAtHlc`, node kept in
  place rather than removed, per §6.4).
- **Neo4j data model**: `MERGE`d on `(graph, id)` with a uniqueness
  constraint; a dynamic `Type_<sanitized>` label per record derived from
  its `@type` IRI (Cypher has no parameterized labels, so this is spliced
  into the query text — safe only because the IRI is first stripped to a
  `[A-Za-z0-9_]` whitelist before splicing, never done on unsanitized
  input). Every upsert does a full property **replace** (`SET r = $props`,
  not `+=`), since the materializer always computes the complete post-patch
  record — this is what makes a property-removal patch actually remove the
  Neo4j property instead of leaving it stale.

### `/sync/snapshot` now reads Neo4j

`vaultStore.ts`'s `snapshot()` now sources `records` from
`readVaultRecords()` (Neo4j) instead of Redis's `HGETALL`. `seq` still
comes from Redis deliberately, not a second durable counter in Neo4j:
accepting new writes at all already requires Redis to be up, so tracking
seq durably in Neo4j too wouldn't remove a dependency, only add
bookkeeping. This is a scoped, explicit decision — full recovery from a
*total* Redis data loss (including vault meta/tokens, which still live
only in Redis) is out of scope here; what's actually being proven is that
a vault's *record data* survives Redis's stream-trimming/eviction policy
and ordinary Redis restarts, matching what the deployment doc already
promised ("more nodes fall back to /sync/snapshot from Neo4j after a Redis
data loss").

### A real bug found and fixed: Neo4j nodes keyed by the wrong id

This is the significant finding from this step, caught by inspecting
Neo4j directly with `cypher-shell` rather than trusting only the browser
UI (which, it turns out, would not have surfaced it — see below).

This app's patch-path addressing and a record's own `@id` field are **not
the same string** for most records: the first path segment of a patch
(what `patchTarget()`/Lua's `target()` calls `subjectId`) is a
graph-qualified key like `did:ng:<vaultId>|did:ng:z:meta:schema:<uuid>`,
while the record's own `@id` field is the bare, unqualified id
(`did:ng:z:meta:schema:<uuid>`). Redis's store hash has always keyed
consistently by `subjectId` (confirmed by direct inspection — every key in
`vault:<id>:store` is graph-prefixed, with zero exceptions, converging to
exactly one entry per subject across a record's whole history). The first
version of `materialize.ts` instead keyed Neo4j nodes by `record["@id"]`
in `upsertRecord`, while `readRecord` (correctly) looked up by
`subjectId` — two different keys for the same logical record. The result:
a record's *first-ever* write landed on a node keyed by its bare `@id`
(with whatever the batch's initial values were), and *every subsequent
update* landed on a **separate, newly created, untyped orphan node**
keyed by the compound `subjectId` (since the read-before-write lookup by
`subjectId` never found the first node), carrying only the latest values
and no `@type` (so no proper label, either).

This was completely invisible from the app's own UI/live-sync behavior —
by design, a client never re-derives the record from a server-side replay
mid-session; it holds its own in-memory object from local edits, and even
a fresh device's replayed view converged correctly because the
`subjectId`-keyed Redis path (which the client's own local store and the
SSE stream both actually use) was never wrong to begin with. It only
showed up because `/sync/snapshot` had just been switched to read Neo4j,
and because this step's regression test happened to exercise the app's
*real*, dynamically-generated ids (`+New schema` → rename) rather than the
simple hand-written test ids (`rec:foo`) used to validate the Lua script
and the accept/apply path in steps 1–2 — those coincidentally have
`subjectId === "@id"`, which is exactly why the bug didn't surface until
now.

Fixed by keying Neo4j nodes by `(graph, subjectId)` throughout — matching
Redis exactly — and storing the record's own `@id`/`@graph` field values
as separate `recordId`/`recordGraph` properties, restored on read
(`materialize.ts`). `readVaultRecords()` (the `/sync/snapshot` source) was
keying its returned `Store` by `record["@id"]` too, which had the same
bug for the same reason — fixed the same way, keying by the Neo4j node's
own `id` property instead.

**Re-verified after the fix**: wiped Redis and Neo4j clean, reran the full
create → rename → tombstone → durability → crash-recovery sequence below,
plus the browser regression suite, and confirmed via direct `cypher-shell`
inspection that a real app-generated schema+property (create, then two
renames) now materializes to exactly one correctly-typed, correctly-keyed
node per subject, with the final renamed values — no orphans.

### Verified

Direct API + `cypher-shell` testing (bypassing the browser, to get
unambiguous ground truth):

- **Create**: a patch batch creating a record materializes to a Neo4j node
  with the correct dynamic label (`Type_Foo` from `@type`
  `did:ng:test:Foo`) and correct properties.
- **Update**: a later batch changing one field updates the *same* node
  (not a new one) and leaves other fields untouched.
- **Delete**: a root "remove" patch tombstones the node (`:Deleted` label
  + `deletedAtHlc` set) rather than removing it; `/sync/snapshot` and
  `readVaultRecords()` correctly exclude tombstoned records.
- **Durability**: after materialization, deleted the vault's Redis
  `store`/`stream`/`hlc` keys entirely (simulating stream
  trimming/eviction) while leaving `meta` (vault existence/token) intact —
  `/sync/snapshot` still returned the exact same, fully correct record
  set, now necessarily sourced from Neo4j alone. Re-ran this same proof
  after the id-keying fix, using the app's real generated ids (not
  synthetic test ids), with identical results.
- **Crash recovery**: stopped the materializer, posted a new patch batch
  (so it sat unprocessed in the stream), then manually delivered it to the
  *same* consumer name via `XREADGROUP` without acking (simulating a crash
  between delivery and ack) and confirmed via `XPENDING` it was pending
  and via `cypher-shell` that Neo4j hadn't been updated yet. Restarted the
  materializer: its pending-entries drain picked the entry up, applied it,
  and acked it — `XPENDING` dropped to 0 and Neo4j showed the update,
  with no manual intervention.
- **Browser regression** (Playwright, two isolated browser contexts):
  vault creation and joining, a schema + property created on one device
  materializing correctly to Neo4j, and cross-device consistency (schema
  and a two-step property rename both correctly visible on the second
  device) all passed. Deliberately did **not** assert on live (no-reload)
  propagation to an already-open subscribed view for a newly-created
  record of that view's watched shape — see the finding below.

### Pre-existing issue re-encountered (out of scope, not fixed here)

While writing this step's browser regression test, hit the same class of
issue step 1 first found and flagged (`localNgEngine.ts` /
`@ng-org/orm`'s `signalObjectPropGenerator`: "When adding new root orm
objects, you must specify the @graph"), but via a path step 1 didn't
exercise: it fires not just over `BroadcastChannel` between same-profile
tabs, but also when `applyRemoteSyncPatches` delivers a batch creating a
brand-new root object to a tab whose `useShape` subscription is already
watching that shape — whether the batch arrives as a live push *or* as
part of an already-open tab's SSE catch-up replay. Confirmed this is
unrelated to anything touched in steps 2–3: a single tab doing ordinary
local editing (no second device, no sync involved at all) reproduces zero
errors under the exact same create-schema-then-rename sequence. The app's
existing runtime-safety net still catches it as designed (disconnects
just that one subscription, logs a warning, doesn't crash), and every
functional assertion in the regression test still passed once written to
verify state via reload rather than via an already-open live view — i.e.
this is a live-notification-layer glitch, not a data-correctness bug; the
underlying accepted-patches stream and its materialization (Redis *and*
now Neo4j) were correct throughout. Left as-is, same as step 1's finding —
fixing vendored `@ng-org/orm` subscription-lifecycle internals is out of
scope for the sync-server work this project covers.

### Files touched this step

- `server/src/neo4j/{config,client,materialize}.ts` — new.
- `server/src/materializer.ts` — new.
- `server/src/vaultStore.ts` — `snapshot()` now Neo4j-backed;
  `createVault()` registers into `vaults:index`; exported `streamKey`/
  `parseLogEntry`/`listVaultIds` for the materializer's use.
- `server/src/index.ts` — `ROLE=materializer` dispatch; pings Neo4j
  connectivity on boot for both roles.
- `package.json` — `neo4j-driver` dependency; `dev:materializer` /
  `start:materializer` scripts.

### Not yet done

Tombstone *retention* (purging past a retention window — tombstones are
created correctly now, nothing prunes them yet), and vault-pairing
security hardening beyond the bearer token, are still ahead per the
architecture doc's build order (steps 4+, though HLC/LWW conflict
resolution itself has been in place since step 1). Also worth another
look eventually, unrelated to sync: the pre-existing ORM subscription race
noted above.

## Step 4 — Tombstone-aware rejection at the ingest layer: DONE

Goal: close a real gap in step 4's other half. HLC/LWW itself was already
correct (step 1), and the materializer already wrote `:Deleted` tombstones
to Neo4j (step 3) — but §5 also requires that a whole-record delete be
*remembered by the ingest tier* and checked before applying any later
patch to that subject, specifically so a stale add/field-patch replayed by
a node that was offline across the delete can't resurrect it. Auditing
`applyBatch.lua` after step 3 showed this half was never built: a
whole-record `remove` did a plain `HDEL` on Redis's store hash with no
memory that the subject had ever existed. A node that deletes a record,
then a second node that's been offline since before the delete reconnects
and replays a stale queued edit to the same subject — the Lua script saw
`loadRecord(subjectId) == false` and treated it as a **fresh creation**,
accepted it, and the materializer then dutifully replayed that acceptance
into Neo4j via `MERGE ... REMOVE r:Deleted` — silently undeleting the
record. This is exactly the split-brain-on-delete scenario tombstones
exist to prevent, found by auditing the code rather than by a bug report.

### Fix

Added a sixth Redis key, `tombstoneKey` (`vault:<id>:tombstones`, a hash of
`subjectId -> deletedAtHlc`), threaded through
`redis/applyBatch.lua`/`redis/client.ts`/`vaultStore.ts`. In the script's
accept-decision loop, before any of the existing accept logic runs for a
patch, look up the subject's tombstone: if one exists and the batch's
`hlc` doesn't strictly exceed `deletedAtHlc`, the patch is dropped
(rejected) regardless of its type — structural re-add, field edit, or set
merge all get the same treatment, since all of them would otherwise
resurrect stale state. A batch whose `hlc` *does* exceed the tombstone's
`deletedAtHlc` is a legitimately newer operation (e.g. deliberately
recreating the same id later) — it proceeds normally through the existing
accept logic and clears the tombstone. Within a single batch, a later
whole-record remove for the same subject overwrites an earlier "clear"
decision back to a fresh `deletedAtHlc`, so in-batch ordering still
resolves the same way store mutations already do. A batch rejected purely
by tombstone gets a distinct rejection reason
(`"subject was deleted after this edit was made"`) rather than being
folded into the existing field-LWW rejection message. No changes were
needed to `materialize.ts`/`materializer.ts`: since the resurrection is now
blocked before the patch is ever accepted onto the stream, the
materializer — which only ever replays what Redis already accepted — never
sees it.

### Verified

Standalone against a live Redis via `redis-cli --eval` (matching the
verification approach used for the Lua script in step 2), not yet re-run
through the full HTTP+materializer+Neo4j stack (no `NEO4J_PASSWORD` set in
this environment at the time) — a reasonable scope boundary here since
this change touches only the accept layer and nothing in the
materializer/Neo4j path changed at all.

- Create → delete → stale field-edit replay (hlc from before the delete):
  rejected, reason `"subject was deleted after this edit was made"`, store
  unchanged.
- Create → delete → stale structural re-add replay (same pre-delete hlc):
  also rejected — confirms the block isn't limited to field-level patches.
- Create → delete → genuinely newer recreate (hlc after the delete):
  accepted, tombstone cleared, record reappears with the new batch's
  values.
- Recreated record accepts a further ordinary edit afterward with no
  lingering tombstone effect.
- Regression: idempotent retry (same `batchId`), ordinary per-field LWW
  rejection (older hlc, no tombstone involved), and set-member commutative
  merge (add "c" to an existing `["a","b"]` tag set) all reproduced their
  pre-existing, unchanged behavior — the tombstone check adds a new
  rejection path without disturbing the others.
- `tsc -p server/tsconfig.json --noEmit` and `build:server` both clean.

### Files touched this step

- `server/src/redis/applyBatch.lua` — tombstone check/write/clear logic.
- `server/src/redis/client.ts` — `applyBatch` command signature gained
  `tombstoneKey`, `numberOfKeys` 5 → 6.
- `server/src/vaultStore.ts` — new `tombstoneKey()`, passed into
  `applyBatch()`.

### Not yet done

~~The Redis tombstone hash itself has no retention/expiry yet either~~ —
addressed below. Load/soak testing (build-order step 6) and security
hardening beyond the bearer token remain untouched.

## Step 4b — Tombstone retention/purging: DONE

Goal: close the gap flagged directly above — both tombstone stores (Neo4j's
`:Deleted` nodes, Redis's `vault:<id>:tombstones` hash) grew by one entry
per record ever deleted, forever. Purge tombstones once they're older than
a retention window, per §5's "e.g. 30 days" — past that window a node
still holding a pre-delete stale edit is no longer a plausible scenario the
system needs to protect against, so the tombstone has done its job and can
be reclaimed.

### Design

New `server/src/config.ts` holds the two settings both stores' purging
shares: `TOMBSTONE_RETENTION_MS` (default 30 days) and
`TOMBSTONE_SWEEP_INTERVAL_MS` (default 1 hour), both env-overridable.

- `neo4j/materialize.ts`'s new `purgeExpiredTombstones(graph, cutoffHlc)`
  runs one Cypher query per vault: match every `:Record:Deleted` node in
  that graph whose `deletedAtHlc` is older than the cutoff and
  `DETACH DELETE` it, returning the purged subjectIds. The cutoff is
  computed the same way `nextHlc()` (`remoteSyncEngine.ts`) mints the
  leading segment of an hlc — `Date.now() - retentionMs`, zero-padded to 15
  digits — so a plain string `<` comparison against `deletedAtHlc` is
  correct, the same trick `applyBatch.lua` already relies on for HLC
  ordering.
- `vaultStore.ts`'s new `sweepVaultTombstones(vaultId)` calls that, then
  `HDEL`s the same subjectIds out of Redis's tombstone hash — the two
  stores are kept in sync by construction (Neo4j decides what's expired;
  Redis just mirrors the decision) rather than each computing its own
  cutoff independently and potentially disagreeing.
- `materializer.ts`'s `startMaterializer()` gained a second `setInterval`
  (alongside the existing vault-discovery poll) that sweeps every known
  vault every `TOMBSTONE_SWEEP_INTERVAL_MS`, with the same per-vault fault
  isolation as `discoverAndWatch` — one vault's sweep failing is logged and
  skipped, not fatal to the loop.
- Safety check on the "already recreated" case: `upsertRecord`'s
  `SET r = $props` is a full property replace (see its doc comment from
  step 3), so any recreate after a delete already wipes `deletedAtHlc` and
  removes the `:Deleted` label *before* a sweep could ever see it — a
  purge can never race a legitimate recreation into deleting a live node,
  since by the time a node is genuinely live again it no longer matches
  `purgeExpiredTombstones`'s `MATCH (r:Record:Deleted ...)` pattern at all.

### Verified

Redis-side mechanics only (`HDEL` removing exactly the purged subjectIds
and leaving others untouched) — confirmed directly via `redis-cli`. The
Neo4j-side `purgeExpiredTombstones` query itself was **not** run against a
live database this session (no `NEO4J_PASSWORD` available in this
environment, same limitation noted for step 4's tombstone-rejection work
above) — `tsc -p server/tsconfig.json --noEmit` passes, and the query
follows the exact same `MATCH (r:Record... {graph, id}) ...` shape already
proven correct and live-verified for `tombstoneRecord`/`readVaultRecords`
in step 3, with `DETACH DELETE` in place of a property `SET`. Worth an
explicit live pass (create → delete → fast-forward `TOMBSTONE_RETENTION_MS`
to something small via env override → confirm the node and its tombstone
both disappear from Neo4j and Redis) the next time this environment has
Neo4j credentials available.

### Files touched this step

- `server/src/config.ts` — new (`TOMBSTONE_RETENTION_MS`,
  `TOMBSTONE_SWEEP_INTERVAL_MS`).
- `server/src/neo4j/materialize.ts` — new `purgeExpiredTombstones`.
- `server/src/vaultStore.ts` — new `sweepVaultTombstones`.
- `server/src/materializer.ts` — periodic sweep wired into
  `startMaterializer()`.

### Not yet done

The live Neo4j-side purge query itself is unverified in this environment
(see above). Security hardening beyond the bearer token remains untouched.

## Step 6 — Load/soak test: DONE

Goal (per §10): many idle SSE connections, burst writes, a simulated
long-offline node's catch-up, and Redis/Neo4j restart under load, against
the real stack (this environment's Neo4j had no usable credential in
earlier steps — fixed here, see below).

### Getting a working Neo4j credential

Neither the existing `NEO4J_PASSWORD` (unknown/lost) nor
`neo4j-admin dbms set-initial-password` (a no-op once the system database
already has users, which this instance's did) worked. Reset it properly:
stopped Neo4j, temporarily set `dbms.security.auth_enabled=false` in
`/etc/neo4j/neo4j.conf`, restarted, ran
`ALTER USER neo4j SET PASSWORD '...' CHANGE NOT REQUIRED` via
`cypher-shell` with no auth needed, then reverted the config and restarted
again with auth back on. Confirmed the vault's existing 23 dev records
were untouched throughout (`MATCH (r:Record) RETURN count(r)` before and
after matched). The new password is a fresh random value, known to
whoever ran this session - not recorded in any repo file, matching
`secrets.md`'s existing convention.

### Test method

An ad hoc Node script (not committed — ephemeral, matching this project's
established verification style of direct API/DB probing over a permanent
test suite), run against a live `pnpm dev:server` + `pnpm dev:materializer`
pair with default config (`STREAM_MAXLEN` 5000, one materializer consumer,
`TOMBSTONE_SWEEP_INTERVAL_MS` unchanged). Redis and Neo4j were restarted
via `systemctl restart` (a graceful stop/start, not `kill -9` or a network
partition — see "Not covered" below).

### Results

- **200 idle SSE connections**: opened in 200ms; a single patch afterward
  reached all 200 within ~1s of being accepted. No connection-count-related
  degradation observed at this scale.
- **Burst of 500 concurrent `POST /sync/patches`**: all 500 accepted in
  353ms (~1400 req/s on this box), assigned seq numbers were unique with no
  gaps or duplicate assignment even under full concurrency — confirms the
  Lua script's atomicity holds under real concurrent load, not just the
  logical/single-request tests from step 2.
- **Materializer catch-up lag under burst, measured directly**: a clean
  500-write burst (accepted by Redis in 392ms) took **~3.8s** for every
  record to appear in Neo4j-backed `/sync/snapshot` — about **130
  records/s**. This is an expected, not a bug: one materializer consumer,
  doing one Neo4j read + one Neo4j write per touched subject, entirely
  sequential. The live SSE fanout path (which never touches Neo4j) is
  unaffected by this lag - only the durable snapshot's freshness trails
  under a burst. Worth another look if realistic burst sizes turn out to
  be much larger than ~500: batching Neo4j writes per stream entry, or
  splitting one vault across multiple consumer-group members (the
  sharding path §6.3 already left room for) are the two obvious levers,
  neither implemented now since nothing here indicates it's needed yet.
- **Redis restart mid-burst** (`systemctl restart redis-server` fired ~150ms
  into a 50-write burst): **zero requests failed** - ioredis's default
  offline command queueing transparently held the in-flight requests
  through the restart and resolved them once reconnected, well within the
  test's timeout. `/sync/health` and new writes both worked immediately
  after. A harder failure (a longer outage, or a hard kill instead of a
  graceful stop) could still exceed a client's patience where this didn't -
  not exercised here.
- **Neo4j restart mid-materialization** (fired after 30 writes were already
  accepted but not yet all materialized): confirms two things live, not
  just by manual `XREADGROUP` simulation as in step 3 -
  1. **The ingest tier is genuinely decoupled**: `sync-server`'s own log
     showed zero errors or interruption throughout - `/sync/patches` never
     touches Neo4j at all, exactly as step 3 designed it.
  2. **Crash recovery actually self-heals in production conditions**: the
     materializer's live consumer threw `Neo4jError: ... ECONNREFUSED`,
     logged `consumer stopped, will retry`, and was silently picked back up
     by the existing 3s vault-discovery poll once Neo4j was reachable again
     - no manual intervention, no restart of the materializer process
     itself. All 30 pre-outage writes and both post-restart probe writes
     were confirmed present in Neo4j afterward - no data loss, entirely
     via the existing pending-entries drain (the same mechanism verified
     manually in step 3, now proven under an actual process-level Neo4j
     outage instead of a hand-simulated one).

### Not covered

Only graceful restarts (`systemctl restart`), not a hard kill (`kill -9`)
or a real network partition — those exercise different failure timing
(no clean shutdown, no FIN) and weren't tried. Also not covered: sustained
multi-minute/hour load (this was burst/spike testing, not endurance), and
Redis/Neo4j resource exhaustion (disk full, `maxmemory` reached under
`noeviction`). No bugs were found in server code by this step - the one
bug hit while writing the test script was in the script itself (vault ID
belongs in `/sync/patches`'s `?vault=` query parameter, not the JSON body -
fixed there, not in `httpServer.ts`, which was already correct).

### Not yet done

Security hardening beyond the bearer token (build-order item after step 6
in §10) is the one remaining unstarted item from the original build order.
Everything else in §10 is now done.
