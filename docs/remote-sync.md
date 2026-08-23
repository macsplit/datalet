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


![The sync panel before pairing: not connected, with a button to create a sync
vault and a field to join an existing one.](images/sync-unpaired.png)

![The sync panel once paired: connected, with the pairing code hidden behind a
Show button and a warning that anyone holding it can read and write the
vault.](images/sync-paired.png)

*Before and after pairing, at **Settings → Manage datalets**.*

## What it does

- Each browser stores its data locally (`localStorage`) and works fully
  offline — this doesn't change.
- Pairing a **sync vault** with one checksummed `LG1` code makes a browser also
  push/pull patches to a shared server. The client decodes it locally to the
  vault id and secret token the unchanged API uses.
- A connected device displays that code as a QR. A joining device can scan it
  when the browser provides `BarcodeDetector` over HTTPS or localhost; the
  manual code field remains available everywhere, including plain-HTTP LANs.
- For remote pairing, a connected device can create a `PAIR-XXXXXXXX-XXXXXXXX-X` code
  that expires after ten minutes and works once. Redeeming it returns the same
  durable vault credentials; rotation invalidates any outstanding codes.
- Creating a vault carries the active local datalet's records into it. Joining
  an existing vault does not upload the local records over that vault; export
  before joining and import afterward when the datasets should be combined.
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

- **Redis**, per vault: `meta` (token hash and lifecycle timestamps), `seq` (counter), `store`
  (current record per subject), `bytes` (the atomically maintained store-byte
  total), `hlc` (per-field last-write timestamps), `stream` (the ordered patch
  log), `tombstones` (deleted-subject → deletion timestamp). A global
  `vaults:index` set lists all vault ids. A write that would grow `store` past
  the configured 8 MiB default quota is refused as a whole.
- **Neo4j**: one `:Record` node per `(graph, subject)`. Six metadata types keep
  shared labels and every user-defined type shares `Type_User`; the exact type
  remains in the indexed `r.type` property. A deleted record keeps its node
  with a `:Deleted` label instead of being removed.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /sync/health` | liveness check |
| `POST /sync/vaults` | create a vault, returns `{ vaultId, vaultToken }` once |
| `DELETE /sync/vaults?vault=` | permanently delete an authenticated vault from Redis and Neo4j; reached from the interface as **Remove permanently** on an archived datalet |
| `POST /sync/vaults/rotate?vault=` | issue a new token, invalidate the old one |
| `POST /sync/pair-code?vault=` | issue an authenticated, one-use ten-minute pairing code |
| `POST /sync/pair-redeem` | rate-limited exchange of a temporary code for vault credentials |
| `POST /sync/patches?vault=` | submit a patch batch |
| `GET /sync/snapshot?vault=` | full current state, from Neo4j |
| `POST /sync/stream-ticket?vault=` | exchange bearer auth for a one-hour stream-only ticket |
| `GET /sync/stream?vault=&since=&ticket=` | live + replayed patches, SSE |
| `GET /sync/admin/vaults` | operator-only per-vault stats; see below |
| `POST /sync/clone-codes?vault=` | issue a revocable, 30-day copy code |
| `GET /sync/clone-codes?vault=` | list this vault's live copy codes |
| `DELETE /sync/clone-codes?vault=&code=` | withdraw one copy code |
| `POST /sync/clone` | exchange a copy code for a *new* vault holding a copy |
| `POST /sync/invite-token` | wrap a COPY or PAIR code in a single-use, 7-day link token |
| `POST /sync/invite-redeem` | exchange a link token for the code it wraps; single-use |

All endpoints except `/sync/health`, vault creation, temporary-code redemption,
and copy-code redemption are bearer-protected. Those redemption routes are
protected by their capability code and a per-IP rate limit; temporary pairing
codes additionally have exact-once consumption and expiry.
Other HTTP requests use `Authorization: Bearer <vaultToken>`; the SSE endpoint
accepts only the short-lived ticket returned by `/sync/stream-ticket`.

### Copying a vault

A **copy code** (`COPY-XXXXXXXX-XXXXXXXX-X`, the same Crockford encoding and
check symbol as a pair code, 80 bits of payload) is a revocable, 30-day
capability to take a copy — neither read nor write access in the ongoing
sense. `POST /sync/clone` creates a **new** vault, fills it from the source,
and returns the new vault's own credentials. The source's token is never
issued to the redeemer and is unaffected by having been copied.

Unlike a pair code it is long-lived and multi-use, so the list and the
withdrawal are part of the feature: a code that cannot be found again cannot be
revoked. Withdrawing stops future copies and does nothing about copies already
taken. Redemption is rate-limited per IP, because it creates a vault.

Entropy and TTL were both raised together (from 40 bits/no expiry to 80
bits/30 days): 40 bits was too weak for a code with no expiration, and a code
that never expires is a permanent liability if it leaks. Neither change alone
would have been enough.

### Invite links: wrapping a code in a disposable token

A COPY or PAIR code is a human-typable secret, meant to be read aloud or typed
in. Sharing it as a raw link (`?code=COPY-...`) would put the actual secret in
browser history, referrer headers, and server logs anywhere the link passes
through. Instead, `POST /sync/invite-token` mints a single-use UUID token that
*wraps* a code without exposing it, valid for 7 days. The resulting link is
`https://<host>/join?token=<uuid>`.

`POST /sync/invite-redeem` exchanges the token for the code it wraps, using
`GETDEL` so the exchange is atomic and the token cannot be redeemed twice. The
client's `/join` page performs this exchange, shows a confirmation step naming
what the code does, and then proceeds exactly as if the code had been typed in
by hand. `codeType` (`COPY` or `PAIR`) is explicit on both endpoints, so a
token minted for one kind cannot be redeemed as the other.

The token's 7-day lifetime is deliberately shorter than a copy code's 30 days:
a code may be shared multiple times over its life, but each individual link
should go stale quickly if unused. Redemption is rate-limited the same way
pair/clone redemption is.

Two implementation details worth keeping. The copy reads the **accepted** state
from Redis rather than `snapshot()`, which reads the Neo4j mirror — that mirror
trails accepted writes and is empty if the materializer is stopped, so cloning
from it would hand over a stale or empty datalet. And the copy is written
through `applyBatch` rather than straight into Redis, because a direct write
would never reach the stream and so never reach Neo4j, producing a clone that
looked complete and came back empty the first time it was opened.

### Operator statistics

`GET /sync/admin/vaults` reports the numbers a multi-tenant deployment needs
and nothing else can see: without it, the storage quota and the write rate
limit are invisible until a tenant complains.

It authenticates against `ADMIN_TOKEN`, a shared secret **separate from every
vault token**, compared in constant time. A vault token is never accepted —
holding one grants full read/write over that vault's data and no visibility
into any vault's numbers, including its own. When `ADMIN_TOKEN` is unset the
route answers `404`: a deployment with no operator to serve has no admin API,
which is the correct default for single-tenant use.

| Parameter | Meaning |
|---|---|
| `?vault=<id>` | one vault's stats; `404` if unknown |
| `?cursor=&limit=` | page through every vault; `limit` clamps to 500 |

Listing pages through `vaults:index` with `SSCAN` rather than reading it
whole, and echoes the cursor back — `"0"` means every vault has been seen. An
observability endpoint that itself fell over at tenant scale would defeat its
own purpose. `SSCAN` guarantees full coverage across a cycle, not ordering or
a fixed page size.

Each entry reports `records`, `tombstones`, `bytes` against `quotaBytes`,
`acceptedBatches` (the vault's monotonic sequence number), `streamEntries`,
`materializerLag` and `materializerPending`, `createdAt`, `lastActiveAt`, and
`deleting`.

Two deliberate choices in that payload. `acceptedBatches` is a **counter, not
a rate**: a scraper differencing two samples gets a correct rate across any
window, where a server-computed one would fix the window for every caller.
And the materializer backlog is read from the consumer group rather than
inferred — `lag` counts entries the group has never read, `pending` counts
entries it read but has not acknowledged, so the pair separates "not started"
from "started and stuck". Redis reports a null `lag` when trimming has made it
uncomputable; that null is passed through rather than flattened to zero,
because an unknown backlog is not a healthy one.

The materializer emits the same object for each vault it owns as a single-line
JSON log (`"event": "vault-stats"`) during its maintenance sweep, so the fleet
can be scraped from logs without polling the endpoint.

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
- Authenticated writes are limited per vault to 600 batches per minute by
  default. A 429 leaves the browser's durable outbox untouched and retries with
  exponential backoff; it is not treated like a terminal conflict refusal.
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
- **One vault flooding writes** — authenticated batches have a per-vault fixed
  window. Rate-limited batches remain queued locally and resume automatically.
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
