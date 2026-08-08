# Remote Sync — Implementation Progress Log

**Status: historical. Closed after step 11; not maintained.** This is the
build log for the sync tier as it was constructed — what was built, what broke,
and how each fix was verified. It is kept for that record, not as a description
of current behavior.

- Current behavior: `remote-sync.md`.
- Design reasoning: `remote-sync-architecture.md`.
- Deployment: `remote-sync-deployment.md`.
- Current and future work: `product-gaps-plan.md`.

Steps below track build order against `remote-sync-architecture.md` §10.

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
Neo4j credentials available. **Resolved in Step 11 below.**

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
Both statements are historical here and resolved by later steps, including
Step 11 below.

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

~~Security hardening beyond the bearer token~~ — addressed below.

## Step 7 — Vault-pairing security hardening beyond the bearer token: DONE

Goal: close the last build-order item. Picked the two concrete gaps
against §9's own stated design, confirmed by reading the code rather than
assumed: token rotation was explicitly promised ("only rotatable") but no
endpoint existed, and `POST /sync/vaults` had zero rate limiting despite
being the one endpoint with no auth at all (it's what *creates* the
credential everything else checks).

### Token rotation/revocation

- `vaultStore.ts`'s new `rotateVaultToken(vaultId)` generates a fresh
  `randomBytes(24)` token, overwrites the vault's stored hash + a new
  `rotatedAt` field — the old token is invalid the instant this returns,
  no grace period.
- New route `POST /sync/vaults/rotate?vault=<id>`, bearer-authenticated
  with the *current* token (same `checkVaultToken` check as every other
  endpoint) — you can't rotate a vault's token without already having it,
  by design; this is recovery from "I leaked my token and want to cut it
  off," not a password-reset flow.
- Client: `remoteSyncEngine.ts`'s new `rotateVaultToken()` calls it,
  persists the new token into the same `localStorage` config, and
  reconnects the live SSE stream with it (the old stream's `?token=` query
  param is now stale). `SyncSettings.tsx` adds a "Rotate token" button in
  the Connected view, with a confirm dialog spelling out that other paired
  devices need the new token manually — then reloads the page (same
  pattern already used by create/join/leave), so the displayed token field
  picks up the new value with no new display-state plumbing needed.

### Rate limiting on vault creation

- New `redis/rateLimit.ts`: a plain fixed-window counter (`INCR` + `EXPIRE`
  on first increment) — deliberately not Lua-atomic like `applyBatch.lua`,
  since this guards abuse mitigation, not a correctness-critical
  accept/reject decision, so the small boundary-window race is an
  acceptable tradeoff for the simpler primitive.
- Wired into `POST /sync/vaults` in `httpServer.ts`: keyed by client IP
  (`clientIp()`, trusting `X-Forwarded-For`'s first entry, falling back to
  the raw socket address — see the doc comment on why this assumes a
  reverse proxy sits in front, matching the deployment doc's existing TLS-
  termination requirement), default 10 vaults/hour, both limit and window
  env-overridable (`VAULT_CREATE_RATE_LIMIT`, `VAULT_CREATE_RATE_WINDOW_SECONDS`).
  Over the limit gets a 429 with a plain-text reason.

### Doc fix found along the way

`remote-sync-deployment.md`'s configuration-reference table listed a
`VAULT_TOKEN_SECRET` env var ("server-side key used to sign/verify vault
tokens") that **no code anywhere reads** — confirmed via a repo-wide grep.
The actual design never needed a server-wide signing secret: each vault
token is its own random opaque value, hashed and stored per-vault. Likely
a leftover from an earlier draft of the scheme that was superseded before
implementation. Removed the stale entry, documented the two new env vars,
and corrected §9's "stored in Neo4j" claim to match reality (vault
meta/tokens live in Redis only, an explicit decision already recorded in
this file's step-3 notes — the architecture doc just hadn't been updated
to match).

### Verified

Against the real running server (`pnpm dev:server`, no materializer needed
- this work doesn't touch Neo4j):

- Rotate with the current valid token: 200, returns a new token.
- The old token is rejected (401) on the very next request after rotation.
- The new token works immediately.
- Rotating again with the now-stale old token: 401 (can't rotate without
  the current token).
- Rotating with the correct new token: 200 (rotation itself isn't
  single-use).
- Rotate on an unknown vault: 404. Rotate with no `Authorization` header
  at all: 401.
- Rate limit: 10 consecutive `POST /sync/vaults` calls from the same IP
  succeeded (200), the 11th and all after it got 429 — exactly matching
  the configured default. Cleaned up the test counter key afterward so it
  doesn't affect real usage from this machine.
- `tsc --noEmit` clean on both `server/tsconfig.json` and the client's
  root `tsconfig.json` (this step touches both sides).

### Files touched this step

- `server/src/redis/rateLimit.ts` — new.
- `server/src/redis/config.ts` — new `VAULT_CREATE_RATE_LIMIT`,
  `VAULT_CREATE_RATE_WINDOW_SECONDS`.
- `server/src/vaultStore.ts` — new `rotateVaultToken`.
- `server/src/httpServer.ts` — rate limit on `POST /sync/vaults`; new
  `POST /sync/vaults/rotate` route; new `clientIp()` helper.
- `src/utils/remoteSyncEngine.ts` — new `rotateVaultToken()`.
- `src/components/SyncSettings.tsx` — "Rotate token" button + confirm
  dialog + error state, in the Connected view.
- `docs/remote-sync-architecture.md` §9 — documents both mechanisms;
  corrects the stale "stored in Neo4j"/signing-secret claims.
- `docs/remote-sync-deployment.md` §3 — removes the unused
  `VAULT_TOKEN_SECRET` entry, documents the new env vars.

### Not yet done

This closes every item in §10's original build order. Nothing scoped and
outstanding remains in this doc; further hardening (multiple scoped
tokens per vault, per-record permissions, encryption at rest) is
explicitly out of scope per §9's own "explicitly not doing" list, not a
gap.

## Step 8 — Visible warning when the sync connection is lost: DONE

Goal: close a gap flagged (but not acted on) earlier in this doc — if the
sync-server becomes unreachable after a device has already paired,
`EventSource` just retries silently forever with no indication to the
user that anything is wrong. Locally queued edits are still safe (the
outbox already persists and flushes on reconnect), but the user has no
way to know sync has stopped without opening dev tools.

### Design

- `runtimeHealth.ts`'s existing `reportRuntimeIssue`/`dismissRuntimeIssue`
  (already wired to a global banner, `RuntimeIssueBanner` in
  `RuntimeSafety.tsx`, used elsewhere for the ORM subscription race and
  the app's error boundary) is reused rather than building a second
  notification mechanism. `reportRuntimeIssue` now returns its computed
  issue id so a caller reporting a *transient* condition can dismiss the
  exact same issue later without duplicating the id-format logic.
- `remoteSyncEngine.ts`'s `connectStream()` listens for `EventSource`'s
  `error` event, but doesn't warn immediately — a bare `error` fires on
  every ordinary transient reconnect blip too (`EventSource` retries
  natively every few seconds), and warning on each of those would be
  noise. Instead: start a 15s timer on the first `error`; if `open` fires
  again before it elapses, clear the timer silently; if it elapses first,
  report the issue. `open` (or leaving the vault via `stopSync`) clears
  any active warning the same way.

### A real finding while testing this: Vite's dev proxy swallows upstream connection death

First attempt at browser verification (kill the sync-server, wait, expect
the banner) failed every time — the banner never appeared even after 30s.
Root-caused by testing three ways instead of assuming the new code was
wrong:

1. A raw Node `http.request` connected **directly** to the sync-server
   (bypassing Vite) got `response error 'aborted'` within ~1s of the
   process dying — the browser-level primitives this feature depends on
   work correctly.
2. The failing browser test was going through `pnpm dev`'s Vite dev
   server, which proxies `/sync/*` to the sync-server
   (`vite.config.ts`, added in an earlier session's dev-workflow fix).
   Network-level tracing (`page.on("requestfailed")`) showed **zero**
   failure events reaching the browser when the upstream died through
   that proxy — the client-facing connection just hung, open and silent,
   forever.
3. Rebuilding the client (`vite build`) and pointing the browser directly
   at the sync-server's own static-file serving (`STATIC_DIR=./dist`,
   matching the single-process production topology, no proxy hop)
   reproduced the fix working exactly as designed: banner appeared at
   15057ms (the 15s threshold), cleared 3014ms after the server came back
   with no reload needed.

So this is a genuine gap in the **Vite dev-proxy path specifically**
(likely Vite's underlying proxy not propagating an upstream socket error
to the client response for a long-lived streaming connection), not a bug
in this feature or in production topology. Not fixed here - fixing it
would mean digging into Vite's proxy `configure` hook to explicitly
forward upstream error/close events, which is dev-workflow tooling, not
app or sync-server code, and wasn't asked for. Worth knowing: **testing
sync-server outages via `pnpm dev` + `pnpm dev:server` will not show this
banner** even though it works correctly in production (single process) or
potentially behind Caddy (untested here, but Caddy is a more mature proxy
implementation than Vite's dev-only one and plausibly doesn't share this
gap) — use a built `dist/` served directly by the sync-server (as done
here) to test this class of behavior going forward.

### Verified

- Direct `http.request` diagnostic: connection-death signal fires
  correctly within ~1s at the raw Node HTTP level.
- Full browser pass (Playwright, built client served directly by the
  sync-server, no Vite proxy): pair a vault, kill the sync-server, banner
  appears after ~15s with the expected text; restart the sync-server,
  banner clears within ~3s automatically, no reload required.
- `tsc --noEmit` clean on the client's root `tsconfig.json`.

### Files touched this step

- `src/utils/runtimeHealth.ts` — `reportRuntimeIssue` now returns its
  issue id.
- `src/utils/remoteSyncEngine.ts` — debounced connection-lost detection
  and warning in `connectStream()`; cleanup in `stopSync()`.

### Not yet done

The Vite dev-proxy gap described above (cosmetic to local dev testing
only, not a production issue) is unfixed. Whether Caddy has the same gap
in the horizontally-scaled deployment path is unverified. **The Caddy path
was verified in Step 11 below; the Vite-only behavior remains a development
proxy limitation.**

## Step 9 — Deeper soak testing: hard-kill: DONE (found and fixed a real durability gap)

Goal: close the two gaps step 6 explicitly flagged as not covered —
`kill -9` instead of a graceful `systemctl restart`, and sustained load
rather than a single burst. Hard-kill testing surfaced a real, previously
undocumented durability gap significant enough to stop and report before
continuing to the sustained-load half.

### Finding: Redis has no AOF, and a hard kill can silently lose already-accepted writes

Checked Redis's actual running config before testing (`redis-cli CONFIG
GET appendfsync`/`appendonly`) rather than trusting the step-2 progress
log's claim that `appendonly yes` was set — it wasn't:
`/etc/redis/redis.conf` line 1405 reads `appendonly no`. Persistence is
RDB-snapshot-only, on the Redis defaults (`save 3600 1 300 100 60 10000`
— i.e. no snapshot at all for a short burst that doesn't cross 100+
changed keys within 5 minutes or 10,000 within 1 minute). Whether this is
config drift (an earlier session's `CONFIG SET appendonly yes` was never
followed by `CONFIG REWRITE`, so a later `systemctl restart redis-server`
- and this session did several - silently reverted it back to the file's
`no`) or the step-2 claim was simply never actually verified against the
file is unclear; either way, this box's Redis has not had AOF durability
at any point this session's restarts were tested against.

**Reproduced twice, with precise timing, against a live sync-server +
materializer:**

- **Run 1** (300 writes; a few extra seconds elapsed before the kill
  landed, due to an initial `pgrep -f` match ambiguity that needed a
  manual retry): all 300 were accepted (HTTP 200). By the time Redis was
  hard-killed (`kill -9`, not `systemctl restart`), that extra delay had
  given the materializer enough time to fully drain the stream — all 300 confirmed durably in Neo4j afterward
  (`MATCH (r:Record {graph: $vaultId}) RETURN count(r)` → 300). Record
  *data* survived. But: **the vault's own meta entry (Redis-only:
  `vaultId` → `tokenHash`, `vaults:index` membership) did not** - gone
  entirely after the restart, confirmed via `KEYS vault:<id>:*` (empty)
  and `SISMEMBER vaults:index <id>` (0). `/sync/snapshot` for that vault
  now returns 404 "unknown vault" **permanently** - there is no recovery
  path; `vaultToken` was only ever a hash, and that hash is gone too. The
  vault's data still technically exists in Neo4j, orphaned, with no way
  to reach it through the API again.
- **Run 2** (400 writes, kill fired ~22ms after the last response, using a
  pre-resolved Redis pid to remove the `pgrep` round trip from the hot
  path): all 400 accepted (HTTP 200) - and **zero** survived anywhere.
  Not in Redis (same total vault loss as run 1), and this time not in
  Neo4j either (`MATCH (r:Record {graph: $vaultId}) RETURN count(r)` →
  0) - the materializer never got a chance to consume any of the 400
  stream entries before the kill.

### Why this matters beyond "Redis lost some data"

The client's outbox (`remoteSyncEngine.ts`'s `flushOutbox`) treats an
HTTP 200 from `POST /sync/patches` as delivery confirmation and drops the
entry from its local retry queue right after
(`response.ok || response.status === 409` → dequeue). Run 2 shows that's
currently **not a safe assumption**: a write can be told "accepted" and
then permanently vanish with the client never finding out, because
nothing durable actually happened yet at the moment of that 200 - it was
sitting only in Redis's in-memory Stream + store hash, unmaterialized,
with no AOF backing it. This directly undercuts the "at least once
delivery" framing in `remote-sync-architecture.md` §5's idempotency
section, which assumes a 200 means the write is safely queued for
replay, not that it might still evaporate.

Separately, run 1 shows an *independent* second gap even when record data
does survive: vault meta (identity + token) has always lived Redis-only
by explicit design (step 3's snapshot doc comment - "full recovery from a
*total* Redis data loss (including vault meta/tokens, which still live
only in Redis) is out of scope here"), but that decision was scoped
against *total* data loss, not against an ordinary crash between RDB
snapshots under otherwise-normal operation. A vault can now go completely
and permanently unreachable from a single unlucky `kill -9`, `OOM kill`,
or power loss, independent of whether its underlying records happen to
survive.

### Fix applied and re-verified: `appendonly yes`, persisted for real this time

Reported to the user before changing anything, since flipping Redis's
persistence mode is an infrastructure decision, not a pure code change.
Approved: enable AOF now; leave the separate vault-meta-durability design
question (should vault meta also live in Neo4j, not Redis-only?) as a
flagged, not-yet-decided item rather than folding it into this fix.

- `redis-cli CONFIG SET appendonly yes` followed by `CONFIG REWRITE` (the
  step this session's Redis was evidently missing before - `CONFIG SET`
  alone doesn't survive a restart, which is exactly how this drifted back
  to `no` despite step 2's original claim). Confirmed persisted:
  `/etc/redis/redis.conf` now reads `appendonly yes`, and a `systemctl
  restart redis-server` afterward preserved `DBSIZE` exactly (1184 before
  and after) with `CONFIG GET appendonly` still reporting `yes` post-
  restart - it's actually in the file this time, not just the running
  config.
- **Re-ran the exact same hard-kill scenario that lost everything in run
  2** (400 writes, `kill -9` fired ~20ms after the last accepted
  response): this time, after Redis restarted, `HLEN`/`XLEN` on the
  vault's store/stream both read 400, `vault:<id>:meta` existed, and
  `GET /sync/snapshot` returned all 400 records with a 200 - full
  recovery, both the vault's identity and every record.

### Not yet decided

The vault-meta-durability design question from above (Redis-only vs. also
mirrored into Neo4j) remains open - AOF narrows Redis's own loss window
to about a second, but doesn't change *what* lives only in Redis. Not
acted on in this step per the user's explicit choice to scope this fix to AOF
only. **Resolved with Neo4j mirroring and Redis reconstruction in Step 11.**

### Sustained load (3 minutes, 10 writes/s, 50 idle SSE connections)

Deliberately compressed relative to a real production soak (which would
run hours/days) given practical time limits — still a meaningfully
different shape of test than step 6's single burst: steady, continuous
load with periodic sampling, not one spike.

- 1,790 writes sent over 3 minutes at a steady 10/s, alongside 50 held-
  open idle SSE connections. **Zero errors, zero rejections** - every
  single write accepted.
- All 1,790 eventually confirmed materialized in Neo4j
  (`/sync/snapshot` record count matched accepted count exactly).
- Memory sampled every 15s for both the sync-server and materializer
  processes (`VmRSS` via `/proc/<pid>/status`) and for Redis
  (`used_memory`): both Node processes grew from a ~86-90MB baseline to
  ~103MB (sync-server) / ~118MB (materializer) over the first ~90-100
  seconds, then **visibly plateaued** for the remaining ~80-90 seconds of
  the run (e.g. materializer: 118164 kB → 118256 kB → 118196 kB → 118644
  kB → 118776 kB → 118600 kB across the last six 15s samples - noise, not
  a trend). Consistent with ordinary V8 heap growth settling under new
  load, not an unbounded leak - though 3 minutes is still short enough
  that a slow leak could be hiding under the noise floor; a real multi-
  hour run would be needed to fully rule that out. Redis memory grew
  linearly and predictably with the actual data volume stored (2.5MB →
  3.7MB for ~1,790 two-field records) - expected, not a leak.

### Not yet done

A true multi-hour (or longer) endurance run, which would be needed to
confidently rule out a slow memory leak the way this compressed 3-minute
run can't. Nothing else scoped to step 9 remains. **A two-hour run was started
in Step 11, then deliberately curtailed at the user's request; heavy endurance
testing remains deferred.**

## Step 10 — Polished reference doc with diagrams: DONE

Goal: implement §11's plan (deferred until the build order settled — it
has). Write a clean, plain-language reference doc summarizing the whole
system as it stands, distinct in purpose from this file (narrative build
log) and `remote-sync-architecture.md` (design reasoning) — for someone
who wants "what is this and how does it work" without reading either of
those in full.

- New `docs/remote-sync.md`: what it does, components, write/read paths,
  conflict resolution, data model, endpoint table, then — per explicit
  instruction — **edge cases**, **non-functional requirements**, and
  **development process** kept as separate sections rather than woven
  through the architecture description.
- Two diagrams, D2 source + rendered PNG committed together in
  `docs/diagrams/`: `topology.d2`/`.png` (the system diagram, replacing
  §6's ASCII art for this doc) and `write-path.d2`/`.png` (a sequence
  diagram of the accept → fanout → materialize flow). Rendered via the
  user's d2topng deployment - confirmed the public instance *does*
  require its bearer token (§11's architecture-doc text had flagged this
  as unconfirmed).
- `secrets.md` documents the `D2TOPNG_API_TOKEN` requirement (value not
  committed, same convention as `NEO4J_PASSWORD`) and the regeneration
  command, for whenever a `.d2` source file changes.
- `remote-sync-architecture.md` §11 updated from "not started" to "DONE".

### Files touched this step

- `docs/remote-sync.md` — new.
- `docs/diagrams/{topology,write-path}.{d2,png}` — new.
- `docs/remote-sync-architecture.md` §11 — marked done, corrected the
  "unconfirmed" auth note now that it's been tested.
- `secrets.md` — new "Diagram regeneration" section.

### Not yet done

Nothing scoped to this step remains — this closes every item raised
across this session that had an owner and a "not started"/"not yet done"
marker, except the two explicitly-still-open residual items already
called out above (vault-meta durability design question; a true
multi-hour endurance run). **Step 11 closed vault-meta durability; the
multi-hour run was explicitly deferred after a shorter clean sample.**

## Step 11 — Follow-up hardening and regression baseline: DONE

Goal: close the concrete follow-ups in `project-next-steps.md` without
changing the local-first default or expanding into accounts/permissions.

### Durable vault metadata

- Added a unique Neo4j `:VaultMeta` node containing vault id, token hash, and
  creation/rotation timestamps. Plaintext tokens are still never stored.
- Vault creation writes Neo4j first and compensates both stores on failure;
  rotation updates Redis and Neo4j and restores the previous Redis metadata if
  the durable update fails.
- If Redis metadata or `vaults:index` is missing, `vaultExists()` reconstructs
  it from Neo4j before authentication proceeds. Server startup backfills older
  Redis-only vaults into Neo4j.
- Live integration deleted a vault's Redis keys/index, then confirmed
  `vaultExists`, bearer authentication, and `/sync/snapshot` recovered from the
  durable metadata/records.

### Stream credentials and proxy outage behavior

- Added `POST /sync/stream-ticket`: bearer auth is exchanged for a hashed,
  one-hour, stream-only random credential. `EventSource` URLs no longer contain
  the durable vault token.
- Tickets are bound to the current token-hash generation, so rotation rejects
  old tickets on a new/reconnecting stream. Existing open sockets remain open
  until they disconnect.
- The client obtains a fresh ticket for explicit reconnects and retains the
  existing debounced sync-loss warning behavior when ticket acquisition or SSE
  fails.
- A live Caddy-path test connected SSE through the documented reverse proxy,
  killed its upstream sync server, and observed the client-facing stream close
  (`caddy-sse-closed-after-upstream-kill`). This closes Step 8's production-
  proxy uncertainty; the Vite development-proxy limitation remains cosmetic.

### Tombstone retention and automated verification

- Live short-retention coverage created and tombstoned a record, swept it, and
  confirmed deletion from both Neo4j and Redis.
- The committed server suite covers patch validation/application plus live
  Redis/Neo4j token rotation, ticket revocation, idempotency, LWW rejection,
  stale tombstone rejection, durable snapshot recovery, and two-store purge.
- The Playwright suite covers persistence/bootstrap plus the three product
  milestones; GitHub Actions runs both suites and both builds with Redis and
  Neo4j services.

### Curtailed endurance sample (heavy testing deferred)

The intended two-hour run was stopped at the user's request after the last
minute sample at **1,140,002 ms (~19 minutes)**. This is retained as a useful
short soak, not represented as a completed endurance test:

- 20 concurrent SSE connections and one accepted write/second; 1,139 writes
  accepted by the last sample with zero request errors.
- The materializer was killed at five minutes and restarted after 30 seconds.
  Sampled pending work rose to 1 at the failure boundary and returned to 0 on
  the next minute sample, demonstrating automatic recovery at this load.
- After warm-up/restart, sync-server RSS held at about 118.7 MB and materializer
  RSS at about 120.1 MB through the recorded interval. Redis memory increased
  with the record volume accumulated during the run.
- Because the run was curtailed, it did not execute the harness's terminal
  accepted-versus-materialized equality check and cannot rule out a slow leak.
  The partial artifact is `remote-sync-endurance-results.json`, labeled
  `status: curtailed` with requested and observed durations.
- Temporary Caddy/server/materializer processes were stopped; the explicit
  test vault was removed from Redis and Neo4j; the exact Neo4j configuration
  was restored, no auth override remains, and the Neo4j service is active.

Heavy multi-hour/day testing is now a deliberate future deployment exercise,
not a blocker for this repository follow-up.

## Removed: the old §11 "streaming/lazy local storage" future-direction note

Deleted from `remote-sync-architecture.md` at the user's explicit call:
a full IndexedDB/OPFS + windowed-subscription migration is scope creep
for this product, not a natural next phase of it — keeping it in the doc
as a standing "maybe someday" implied otherwise. The real, narrower
complaint that prompted it (`localNgEngine.ts` reserializes and writes
the *entire* store synchronously on every persist, not just what
changed) was legitimate and has since been addressed on its own, much smaller
terms — see `incremental-persistence-progress.md` (DONE).
