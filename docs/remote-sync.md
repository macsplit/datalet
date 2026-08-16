# Remote Sync — Reference

Plain-language reference for the sync layer that lets multiple browsers
share one graph: what the endpoints are, how conflicts resolve, and how each
failure mode behaves.

For how the sync tier fits into the system as a whole, see
[`architecture.md`](architecture.md) §3. For the original design reasoning and
the trade-offs weighed, see
[`remote-sync-architecture.md`](remote-sync-architecture.md). For what was
built when, and the defects found doing it, see
[`build-history.md`](build-history.md).

## What it does

- Each browser stores its data locally (`localStorage`) and works fully
  offline — this doesn't change.
- Pairing a **sync vault** with one checksummed `LG1` code makes a browser also
  push/pull patches to a shared server. The client decodes it locally to the
  vault id and secret token the unchanged API uses.
- A connected device displays that code as a QR. A joining device can scan it
  when the browser provides `BarcodeDetector` over HTTPS or localhost; the
  manual code field remains available everywhere, including plain-HTTP LANs.
- For remote pairing, a connected device can create a `PAIR-XXXX-XXXX-X` code
  that expires after ten minutes and works once. Redeeming it returns the same
  durable vault credentials; rotation invalidates any outstanding codes.
- Pairing switches the active graph; it does not automatically migrate an
  existing unpaired graph. Export before pairing and import afterward to seed
  a new vault with existing local data.
- Multiple devices paired to the same vault converge to the same state.
- No user accounts, no login — possession of the pairing code (and therefore
  its embedded vault token) is the only credential.

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
  full current state from Neo4j. The client validates and reconciles that
  graph into its mounted subscriptions without reloading the page, advances
  its cursor, reconnects SSE, and flushes its untouched outbox.

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
- **Within one batch**, patches are an ordered sequence rather than
  competitors: they all carry the batch's single HLC, so the last patch for a
  field wins, exactly as the same list applies locally. Without this a batch
  that removes a field and then restores it — which is precisely the shape an
  undo submits — would arrive at the vault as a bare deletion.

## Data model

- **Redis**, per vault: `meta` (token hash), `seq` (counter), `store`
  (current record per subject), `hlc` (per-field last-write timestamps),
  `stream` (the ordered patch log), `tombstones` (deleted-subject →
  deletion timestamp). A global `vaults:index` set lists all vault ids.
- **Neo4j**: one `:Record` node per `(graph, subject)`. Six metadata types keep
  shared labels and every user-defined type shares `Type_User`; the exact type
  remains in the indexed `r.type` property. A deleted record keeps its node
  with a `:Deleted` label instead of being removed.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /sync/health` | liveness check |
| `POST /sync/vaults` | create a vault, returns `{ vaultId, vaultToken }` once |
| `POST /sync/vaults/rotate?vault=` | issue a new token, invalidate the old one |
| `POST /sync/pair-code?vault=` | issue an authenticated, one-use ten-minute pairing code |
| `POST /sync/pair-redeem` | rate-limited exchange of a temporary code for vault credentials |
| `POST /sync/patches?vault=` | submit a patch batch |
| `GET /sync/snapshot?vault=` | full current state, from Neo4j |
| `POST /sync/stream-ticket?vault=` | exchange bearer auth for a one-hour stream-only ticket |
| `GET /sync/stream?vault=&since=&ticket=` | live + replayed patches, SSE |

All endpoints except `/sync/health`, vault creation, and temporary-code
redemption are bearer-protected. Redemption is protected by the temporary
credential itself, exact-once consumption, expiry, and a per-IP rate limit.
Other HTTP requests use `Authorization: Bearer <vaultToken>`; the SSE endpoint
accepts only the short-lived ticket returned by `/sync/stream-ticket`.

---

## Non-functional requirements

**Durability**

- Neo4j is the system of record; Redis is a buffer, not durable storage
  on its own.
- Redis persistence: AOF (`appendonly yes`, `appendfsync everysec`) — up
  to ~1s of very recent writes can be lost in a hard crash, not more.
- Vault identity and token hashes are mirrored into Neo4j. If Redis loses a
  vault's metadata, the next authenticated request reconstructs the Redis
  entry and vault index from Neo4j before serving the request.

**Security**

- Shared-secret bearer token per vault, high-entropy and random — only a
  hash of it is stored server-side (never the plaintext), compared in
  constant time.
- Token rotation available (`/sync/vaults/rotate`) for a leaked token.
- Stream tickets are bound to the token generation, so rotation also rejects
  old tickets when a stream connects or reconnects (an already-open SSE socket
  remains open until it disconnects).
- The browser never puts the long-lived vault token in the SSE URL. It uses
  bearer auth once to obtain a short-lived, stream-only ticket, limiting the
  credential exposed to ordinary proxy URL logging.
- Vault creation is rate-limited per client IP (abuse/DoS mitigation —
  it's the one endpoint with no auth, since it's what issues the
  credential).
- Temporary-code redemption is limited to ten attempts per client IP per
  minute by default. Codes carry 40 random bits plus a check symbol, expire in
  ten minutes, work once, and stop redeeming after token rotation.
- TLS is terminated at the reverse proxy, not in the app itself.
- Explicitly out of scope: user accounts, per-record permissions,
  multi-user sharing, encryption at rest.

**Scalability**

- `sync-server` is stateless — proven with 2 instances behind a
  round-robin proxy sharing one Redis, no per-instance state.
- The materializer multiplexes up to 64 vault streams onto each blocking Redis
  connection. The batch size is tunable. Materializer processes scale out by
  deterministic FNV-1a vault sharding; a short Redis lease rejects duplicate
  shard indexes, and stable per-shard consumer names recover pending work after
  restart.

**Performance (measured on a dev box, not a production SLA)**

- Ingest: ~1,400 requests/s for a 500-write concurrent burst.
- Materialization: ~130 records/s with a single materializer consumer
  (one sequential Neo4j read + write per touched subject) — a burst's
  *durable* copy trails its *live* copy by a few seconds under load.
- Multi-tenant materialization: the A1 completion run used four blocking
  connections for 200 vaults and materialized all 50 active vaults, with
  243 ms p95 observed lag on that development run.
- Sustained load (1,790 writes over 3 minutes, 50 idle SSE connections
  held open): zero errors, memory usage plateaued rather than growing.

---

## Edge cases

- **Two offline nodes create the same record independently** — the
  second create is deduped (write-once identity), not double-applied.
- **Two nodes edit the same field concurrently** — HLC decides the
  winner; the losing batch gets `409` with a "superseded" reason. The server
  also reports accepted/submitted counts for a batch where only some patches
  lose. The client resolves either outcome without retrying it and raises a
  visible warning containing the dropped count and reason; the winning value
  still arrives through SSE.
- **A node replays a stale edit to an already-deleted record** — rejected
  at the point of acceptance (a Redis-side tombstone check), so it can't
  resurrect the record. A genuinely *newer* write to that same subject
  (after the deletion) is allowed through and clears the tombstone.
- **A client's resume cursor falls outside Redis's retained stream**
  (long offline gap, or a busy vault trimming its stream) — the server
  detects the gap and tells the client to fetch a full `/sync/snapshot`
  instead of replaying deltas. Reconciliation happens in place; open editors
  and page state remain mounted while records converge.
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
  entirely was found and fixed during step 9 of the build (Redis had no AOF
  enabled despite being documented as configured).
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
- **A pre-existing, unrelated dependency bug**: `@ng-org/orm` has a
  subscription-lifecycle race — an old shape's signal is torn down well after
  its replacement opens, so two subscriptions can briefly watch the same
  records. Reproduces with zero sync code involved. The local engine now drops
  patch batches that change nothing, which makes the write path indifferent to
  it; the app's error boundary catches whatever else surfaces.

---

## How this was built

Built incrementally, each step verified end to end before the next began —
mostly by probing the API and databases directly rather than through the
browser, which is what caught most of the real defects.

[`build-history.md`](build-history.md) records the sequence, every bug found
(including the two significant ones: Neo4j nodes keyed by the wrong id, and
Redis running without AOF so accepted writes could vanish), and the load
measurements.
