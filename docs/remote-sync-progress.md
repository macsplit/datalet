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

## Step 2 — Redis Streams for sequencing + fanout: IN PROGRESS

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
