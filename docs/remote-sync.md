# Remote Sync — Reference

Plain-language reference for the sync layer that lets multiple browsers
share one graph. For the original design reasoning and trade-off
discussions, see `remote-sync-architecture.md`. For the step-by-step build
log (what was built, what broke, how it was fixed), see
`remote-sync-progress.md`. This document is the current-state summary of
both.

## What it does

- Each browser stores its data locally (`localStorage`) and works fully
  offline — this doesn't change.
- Pairing a **sync vault** (an id + a secret token, created once) makes a
  browser also push/pull patches to a shared server.
- Multiple devices paired to the same vault converge to the same state.
- No user accounts, no login — a vault's token is the only credential.

## Components

- **Client** (`src/utils/remoteSyncEngine.ts`) — queues local edits,
  pushes them, listens for a live stream of remote edits.
- **sync-server** (`server/src/httpServer.ts`) — stateless HTTP/SSE
  ingest tier. Any number of instances can run behind a reverse proxy.
- **Redis** — sequencing, fanout, and short-term buffering. Not the
  durable store.
- **materializer** (`server/src/materializer.ts`) — replays accepted
  patches into Neo4j. A separate process/role, same build artifact.
- **Neo4j** — durable system of record. What `/sync/snapshot` reads from.

![System topology](diagrams/topology.png)

## Write path

1. Client `POST /sync/patches` with a bearer token and a batch of patches.
2. `sync-server` runs a Redis Lua script (`applyBatch.lua`) that atomically
   decides what to accept and assigns the batch a sequence number.
3. Accepted patches are written to Redis (materialized-view hash) and
   appended to that vault's Redis Stream.
4. The client gets `{ accepted, seq }` back immediately.
5. Two things happen from the stream, independently:
   - Already-connected clients get it pushed live over SSE.
   - The materializer (a separate consumer) reads it and upserts/
     tombstones the affected records in Neo4j.

![Write path](diagrams/write-path.png)

## Read / resync path

- A client resumes its SSE connection with `?since=<last seq>` —
  Redis replays anything missed, then live updates continue.
- If Redis has trimmed its stream past that point (long offline gap), the
  server tells the client to `GET /sync/snapshot` instead, which reads the
  full current state from Neo4j.

## Conflict resolution

- **Scalar fields** (most fields, and record create/delete): last-write-
  wins, ordered by a Hybrid Logical Clock (HLC) on each batch, not by
  arrival order — so network jitter or clock skew doesn't flip the result.
- **Set-type fields** (multi-value): add/remove merge commutatively,
  regardless of what order two nodes' edits arrive in.
- **Record creation**: write-once — a duplicate create of the same
  identity (e.g. two offline nodes both create the same well-known
  record) is silently deduped, not overwritten.
- **Record deletion**: tombstoned, not just removed, so a stale edit from
  before the deletion can't resurrect it later (see Edge cases).

## Data model

- **Redis**, per vault: `meta` (token hash), `seq` (counter), `store`
  (current record per subject), `hlc` (per-field last-write timestamps),
  `stream` (the ordered patch log), `tombstones` (deleted-subject →
  deletion timestamp). A global `vaults:index` set lists all vault ids.
- **Neo4j**: one `:Record` node per `(graph, subject)`, carrying a dynamic
  label derived from the record's type (e.g. `Type_Task`). A deleted
  record keeps its node with a `:Deleted` label instead of being removed.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /sync/health` | liveness check |
| `POST /sync/vaults` | create a vault, returns `{ vaultId, vaultToken }` once |
| `POST /sync/vaults/rotate?vault=` | issue a new token, invalidate the old one |
| `POST /sync/patches?vault=` | submit a patch batch |
| `GET /sync/snapshot?vault=` | full current state, from Neo4j |
| `GET /sync/stream?vault=&since=` | live + replayed patches, SSE |

All endpoints except `/sync/health` and vault creation require
`Authorization: Bearer <vaultToken>`.

---

## Non-functional requirements

**Durability**

- Neo4j is the system of record; Redis is a buffer, not durable storage
  on its own.
- Redis persistence: AOF (`appendonly yes`, `appendfsync everysec`) — up
  to ~1s of very recent writes can be lost in a hard crash, not more.
- A vault's *identity* (its token hash) currently lives in Redis only —
  losing it makes the vault permanently unreachable even if its record
  data survived in Neo4j. Known residual risk, not yet addressed (see
  Edge cases).

**Security**

- Shared-secret bearer token per vault, high-entropy and random — only a
  hash of it is stored server-side (never the plaintext), compared in
  constant time.
- Token rotation available (`/sync/vaults/rotate`) for a leaked token.
- Vault creation is rate-limited per client IP (abuse/DoS mitigation —
  it's the one endpoint with no auth, since it's what issues the
  credential).
- TLS is terminated at the reverse proxy, not in the app itself.
- Explicitly out of scope: user accounts, per-record permissions,
  multi-user sharing, encryption at rest.

**Scalability**

- `sync-server` is stateless — proven with 2 instances behind a
  round-robin proxy sharing one Redis, no per-instance state.
- The materializer is a Redis Streams consumer group — more workers can
  be added later to shard one vault's stream across them, without a
  redesign.

**Performance (measured on a dev box, not a production SLA)**

- Ingest: ~1,400 requests/s for a 500-write concurrent burst.
- Materialization: ~130 records/s with a single materializer consumer
  (one sequential Neo4j read + write per touched subject) — a burst's
  *durable* copy trails its *live* copy by a few seconds under load.
- Sustained load (1,790 writes over 3 minutes, 50 idle SSE connections
  held open): zero errors, memory usage plateaued rather than growing.

---

## Edge cases

- **Two offline nodes create the same record independently** — the
  second create is deduped (write-once identity), not double-applied.
- **Two nodes edit the same field concurrently** — HLC decides the
  winner; the loser gets `409` with a "superseded" reason, not silently
  dropped without explanation.
- **A node replays a stale edit to an already-deleted record** — rejected
  at the point of acceptance (a Redis-side tombstone check), so it can't
  resurrect the record. A genuinely *newer* write to that same subject
  (after the deletion) is allowed through and clears the tombstone.
- **A client's resume cursor falls outside Redis's retained stream**
  (long offline gap, or a busy vault trimming its stream) — the server
  detects the gap and tells the client to fetch a full `/sync/snapshot`
  instead of replaying deltas.
- **The materializer crashes mid-batch** — it's a Redis Streams consumer
  group member with a stable (not process-id-based) name, so on restart
  it re-reads its own still-unacknowledged entries before rejoining the
  live tail. No manual intervention, no data loss.
- **A `POST` is retried after a dropped response** (client never saw the
  first reply) — deduped server-side by `batchId` within a 24h window;
  the retry gets the same `seq` back rather than double-applying.
- **A hard Redis crash** (`kill -9`, OOM, power loss) — up to ~1s of very
  recent writes can be lost (see Durability above). A prior, worse bug
  where *all* recent writes and the vault's own identity could be lost
  entirely was found and fixed this session (Redis had no AOF enabled
  despite being documented as configured).
- **A leaked vault token** — rotate it; the old one stops working
  immediately. Every other device paired to that vault needs the new
  token entered manually — there's no way around that with a shared-
  secret scheme and no per-device identity.
- **The sync-server becomes unreachable after a device has already
  paired** — edits keep queuing locally and the client keeps retrying
  silently; after 15s of no reconnect, a visible warning appears in the
  app. It clears automatically once the connection returns, no reload
  needed.
- **Vault-creation flooding** — rate-limited per client IP; trusts a
  reverse proxy's `X-Forwarded-For`, so it's only meaningful with one in
  front (already required for TLS anyway).
- **Testing sync-server outages via `pnpm dev`** — Vite's dev proxy
  doesn't propagate an upstream connection dying to the browser, so the
  reconnect warning above won't appear in that specific dev setup even
  though it works in production. Test against a built client served
  directly by the sync-server to see it.
- **A pre-existing, unrelated bug**: a vendored ORM dependency
  (`@ng-org/orm`) has a subscription-lifecycle race when a live view
  witnesses a remote-sync-delivered creation of a new object for a shape
  it's already watching. Reproduces with zero sync code involved (pure
  local editing triggers it too); the app's existing error boundary
  catches it gracefully. Out of scope for this project's own code.

---

## Development process

Built incrementally, one build-order step at a time, each verified
end-to-end before moving on (direct API/database inspection, not just
browser testing — this is what caught most of the real bugs below).

1. **In-memory sync-server skeleton** — proved the client integration and
   wire protocol on a single process, no Redis/Neo4j yet.
2. **Redis Streams for sequencing + fanout** — moved state off one
   process's memory so multiple stateless instances can share a vault;
   proved horizontal scaling behind a reverse proxy.
3. **Neo4j + materializer** — added the durable system of record,
   decoupled from Redis's ingest role. Found and fixed a real bug here:
   Neo4j nodes were keyed by the wrong id, silently creating orphan
   duplicates on every update after a record's first write.
4. **Tombstones** — HLC last-write-wins was already in place; added the
   missing half, rejecting stale edits to already-deleted records at
   accept time.
5. **Tombstone retention** — periodic purge of expired tombstones from
   both Redis and Neo4j, so neither grows unbounded.
6. **Load/soak test (burst)** — idle connections, concurrent write
   bursts, and Redis/Neo4j restarts under load, against the real stack.
7. **Vault-pairing security hardening** — token rotation and
   vault-creation rate limiting, closing the last documented-but-
   unbuilt gaps.
8. **Visible sync-lost warning** — a debounced UI banner when the
   connection to the sync-server is lost.
9. **Deeper soak testing (hard-kill + sustained load)** — found and
   fixed the Redis AOF/durability gap described above; sustained load
   ran clean.

See `remote-sync-progress.md` for the full narrative, including every bug
found, how it was diagnosed, and how it was verified fixed.
