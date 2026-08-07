# Remote Sync Layer — Architecture Design

Status: proposal / not yet implemented.

## 1. Goals and non-goals

Goals:

- Continuous, near-real-time bi-directional sync between N local-first app
  instances (browser tabs, devices) through one central server.
- The same server process that serves the static build (`dist/`) also serves
  the sync endpoint(s) — one deployable artifact.
- Survive flaky connectivity: a node can go offline for seconds or days and
  catch up correctly on reconnect.
- Scale horizontally on the server side (multiple server processes behind a
  load balancer), with Redis and Neo4j as shared, reproducible open-source
  infrastructure.
- No accounts, no per-user login. The app must keep working fully offline if
  sync is never configured, exactly as it does today.

Non-goals:

- Multi-user access control, permissions, or per-record ownership. Out of
  scope per the prompt.
- End-to-end encryption of synced data (notable open question, see §9).
- Real NextGraph broker/wallet protocol compatibility. This design keeps the
  *shape* of `@ng-org/orm`'s patch interface (so `localNgEngine.ts` barely
  changes) but is a bespoke transport, not NextGraph's actual CRDT wire
  format.

## 2. Current state (recap)

- `src/utils/ngSession.ts` generates a random `private_store_id` on first
  load and persists it to `localStorage`. `usePrivateNuri` turns that into
  `did:ng:<private_store_id>`, which is the `@graph` value used to scope
  every subscription (`MetaStoreContext.tsx`).
- `src/utils/localNgEngine.ts` is the entire storage/sync engine today: an
  in-memory `Store` keyed by `graph|id`, persisted to `localStorage`
  (debounced 120ms), and mirrored across tabs of the *same origin* via
  `BroadcastChannel`. It exposes exactly two functions
  (`orm_start_graph`, `graph_orm_update`) that `@ng-org/orm` calls — this is
  the seam to extend.
- Patches: `{ op: "add" | "remove", path: "/<subjectId>/<propKey>", value, type? }`.
  `type: "set"` patches merge member-by-member (add/remove one value from an
  array) — already commutative. Everything else overwrites the field
  (last-write-wins, currently ordered only by local call order).
- There is no server. `run.sh` runs `vite dev --host`.

**Consequence for sync design**: because `private_store_id` is randomly
generated per browser profile, two browser installs today have disjoint
`@graph` values by construction. For "N instances syncing to each other" to
mean anything, the app needs a stable, user-controlled identity that can be
deliberately shared across a user's own devices — see §3.

## 3. Decision point: sync vault identity

Introduce a **Sync Vault**: a stable id + secret pair, independent of the
random per-browser `private_store_id`, that a user creates once and then
enters into every device/browser they want kept in sync.

- `vaultId`: a UUID, server-assigned when a vault is first created (or
  client-generated and registered — either works; server-assigned avoids
  collisions with zero coordination).
- `vaultToken`: a bearer secret returned at creation time, entered manually
  (or via a pairing link/QR code) on each additional device. Stored in
  `localStorage` alongside the existing session data.
- All records a node wants synced are written under `@graph = vaultId`
  instead of the random `private_store_id`. The simplest migration is to
  make the *private store's* graph become the vault id once sync is
  configured: on first successful pairing, the client renames its local
  `@graph` values from the old random id to the vault id in one local
  transaction, then proceeds as normal. Until a vault is configured, nothing
  changes — the app is exactly as local-only as it is today.

This is *not* user authentication (no accounts, no login, no per-user
records) — it's a shared-secret pairing so the server knows which nodes
belong to which sync group, and so the sync endpoint isn't a fully open
relay for anyone on the network. I'm flagging it explicitly because "no
auth" was a stated constraint; this is the minimum needed for "N instances
sync to each other" to be a well-defined, non-open-relay operation. See §9
for the security posture this implies.

## 4. Wire protocol

### 4.1 Transport: SSE down, HTTP POST up

True bidirectional streaming over a single connection would be a WebSocket.
I recommend **SSE for server→client push, plain HTTP POST for client→server
writes** instead, because:

- `EventSource` has automatic reconnection and `Last-Event-ID` resume built
  into the browser — exactly the "robust to flaky connectivity" behavior
  this needs, for free, no client-side reconnect/backoff logic to write.
- It's plain HTTP, so it passes through ordinary reverse proxies, corporate
  proxies, and load balancers without special upgrade handling (unlike
  WebSocket, which some intermediaries mishandle).
- Writes (patch submission) are small, infrequent relative to reads, and
  don't need sub-frame latency — a POST is simpler to retry, batch, and
  reason about than a duplex frame stream.

Trade-off: two connections/requests instead of one, and slightly higher
latency for the write's own acknowledgment (a POST response) versus a
WebSocket frame. For this app's usage pattern (occasional field edits, not
a real-time multiplayer cursor), that's the right trade. If sub-100ms
collaborative-cursor-style latency becomes a requirement later, revisit with
WebSocket (`ws` + Redis pub/sub adapter, same server-side fanout design
below still applies).

### 4.2 Endpoints

All under a `/sync` prefix on the same server that serves `dist/`.

```
GET  /sync/stream?vault=<vaultId>&since=<seq>
     Authorization: Bearer <vaultToken>
     -> text/event-stream, one event per committed patch batch, id: <seq>
     Resumes from `since` (or from Last-Event-ID header on reconnect).

POST /sync/patches
     Authorization: Bearer <vaultToken>
     Body: { vault, nodeId, baseSeq, batchId, patches: Patch[] }
     -> { accepted: true, seq: <newSeq> } | { accepted: false, reason }

GET  /sync/snapshot?vault=<vaultId>
     Authorization: Bearer <vaultToken>
     -> { seq, records: { "<graph>|<id>": OrmRecord, ... } }
     Full materialized state, for first bootstrap or a resume gap too large
     to replay incrementally.

POST /sync/vaults            (create a new vault -> { vaultId, vaultToken })
GET  /sync/health            (liveness/readiness for the LB)
```

### 4.3 Patch envelope

Extend (don't replace) the existing `Patch` shape so `applyPatchesToStore`
in `localNgEngine.ts` keeps working unmodified on the client:

```ts
type SyncedPatch = Patch & {
  seq: number;       // server-assigned, monotonic per vault — the resume cursor
  hlc: string;        // hybrid logical clock: "<wallMs>-<counter>-<nodeId>"
  nodeId: string;      // originating node, for loop suppression + debugging
  batchId: string;     // groups patches committed together (one edit action)
};
```

`seq` is assigned once, at commit time, by the server (see §6.3) — it is the
single source of truth for "what have I already applied," used as the SSE
`Last-Event-ID` / `?since=` cursor. `hlc` is assigned client-side when the
patch is generated and travels with it, used for conflict resolution (§5).

### 4.4 Reconnect/resume flow

1. Client boots, reads its last-applied `seq` for this vault from
   `localStorage`.
2. Opens `GET /sync/stream?vault=...&since=<seq>`.
3. Server checks whether `seq` is still within the retained replay window
   (Redis Stream, §6.2). If yes: streams the gap, then live-tails. If the
   gap is too large (node offline longer than the retention window) or
   `seq` is absent (first run): server responds with a distinguished
   `resync` SSE event telling the client to call `/sync/snapshot`, replace
   its local store for that vault wholesale, and reopen the stream from the
   snapshot's `seq`.
4. Client always keeps writing to its own local `localStorage`/store first
   (unchanged from today) — sync is additive latency, never a blocker for
   local reads/writes.

## 5. Conflict resolution

Two categories of patch already exist in the codebase, and they get
different treatment:

- **Set patches** (`type: "set"`, used for multi-value fields): add/remove
  of individual members. These are already commutative and
  order-independent — the existing `applyPatchesToStore` merge logic
  (dedupe on add, index-remove on remove) is a correct CRDT (grow/shrink
  set) as-is. No server-side change needed beyond replaying them in any
  order to any node.
- **Scalar patches** (everything else — single-value field overwrite,
  including `@type` and record-creation/removal): these are last-write-wins
  today, implicitly ordered by "whichever call happened last in this
  process." Across nodes, "last" needs a real definition, or two offline
  edits to the same field resolve differently on different nodes depending
  on arrival order — a classic split-brain bug.

  Fix: use the `hlc` on each patch. The server keeps, per `(subject, path)`,
  the HLC of the last-applied scalar patch. An incoming patch is applied and
  forwarded only if its HLC is strictly greater; otherwise it's dropped and
  the submitting node is told (in the POST response) that it was superseded,
  so the UI *could* surface that later if desired (not required for v1 — a
  silently-dropped stale write is an acceptable default given "no accounts,
  best-effort local-first"). This gives deterministic LWW regardless of
  network arrival order or clock skew (HLC bounds skew by design).

- **Tombstones**: a whole-record `remove` needs to be remembered for a
  retention window (e.g. 30 days) so a stale `add`/field-patch from a node
  that's been offline longer than that doesn't resurrect a deleted record.
  Store tombstones in Neo4j alongside live records (a `Deleted` label +
  `deletedAtHlc`), checked before applying any patch to that subject.

- **Idempotency / at-least-once delivery**: `batchId` lets both server and
  clients de-duplicate a patch batch that's retried after a dropped
  response (client POSTs, network dies before the ack arrives, client
  retries). Server: `SETNX` the batchId in Redis with a TTL before
  committing: 6.2. Client: ignore an incoming SSE batch whose `batchId` it
  already applied locally (it will have arrived locally already via the
  local engine's own `broadcastToLocalSubscriptions`/BroadcastChannel path
  before the round trip completes) — track a small ring buffer of recently
  applied batchIds, matching the existing `recentlyClosedSubscriptions`
  pattern already used in `localNgEngine.ts`.

## 6. Server architecture

```
                     ┌─────────────────────────────────────────┐
                     │      reverse proxy (Caddy/nginx)         │
                     │   TLS, SSE-safe (buffering off), LB      │
                     └───────────────┬───────────────────────────┘
                                      │
                 ┌────────────────────┼────────────────────┐
                 ▼                    ▼                    ▼
          ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
          │ sync-server  │      │ sync-server  │      │ sync-server  │   (stateless,
          │  instance 1  │      │  instance 2  │      │  instance N  │    scale out)
          │ - serves /   │      │              │      │              │
          │ - SSE stream │      │              │      │              │
          │ - POST /sync │      │              │      │              │
          └──────┬───────┘      └──────┬───────┘      └──────┬───────┘
                 │                     │                     │
                 └──────────┬──────────┴──────────┬──────────┘
                            ▼                     ▼
                     ┌─────────────┐       ┌───────────────┐
                     │    Redis     │       │  materializer  │  (one logical
                     │ Streams +    │──────▶│  writer(s)     │   writer per vault,
                     │ pub/sub +    │consume│  consumer group│   horizontally
                     │ dedupe/cache │       └───────┬────────┘   shardable)
                     └─────────────┘               ▼
                                              ┌───────────┐
                                              │   Neo4j    │  durable store
                                              │ (graph db) │  + snapshot source
                                              └───────────┘
```

### 6.1 Ingest tier (the "sync-server" processes)

Stateless Node.js processes (reuse this repo's TypeScript — the predicate
definitions in `src/shapes/orm/metaShapes.schema.ts` can be imported
server-side too, for patch validation against the same shapes the client
uses, and for user-defined dynamic schemas via the same `buildShapeType`
logic). Responsibilities:

- Serve `dist/` (the static build) — satisfies "the same server process
  that serves the static pages."
- Terminate SSE connections; look up/subscribe to the relevant Redis Stream
  for the requested vault; relay entries to the client as SSE events.
- Accept `POST /sync/patches`: validate the batch (auth token, patch shape,
  size limits echoing the existing `RUNTIME_LIMITS.patchBatch` from
  `runtimeHealth.ts`), assign nothing itself — hand off to Redis (next
  section) for the authoritative sequencing, then respond once committed.
- No process-local state beyond connection objects — any instance can serve
  any vault, so the load balancer needs no session affinity/sticky routing.
  This is what makes horizontal scaling straightforward: add more
  sync-server replicas behind the proxy at will.

### 6.2 Redis's role

Use **Redis Streams**, not bare Pub/Sub, for the vault's patch log:

- `XADD vault:<id>:stream * seq <n> nodeId <..> hlc <..> patches <json>` —
  gives durability (with `appendonly yes`), an assignable sequence via a
  paired `INCR vault:<id>:seq` done in the same Lua/MULTI transaction as the
  `XADD`, and free replay (`XRANGE`) for the resume-gap case in §4.4 without
  a separate replay-buffer data structure.
- Each sync-server instance's SSE handler is a **consumer** reading the
  stream (`XREAD BLOCK` or a Lua-scripted tail) from the client's cursor —
  this is what makes fanout work regardless of which instance accepted the
  original POST.
- The **materializer** (§6.3) is a separate **consumer group** on the same
  stream, so ingest and durable-graph-write are decoupled: a slow Neo4j
  write never blocks accepting or fanning out new patches to already-synced
  nodes.
- `MAXLEN ~ <N>` trimming keeps the stream from growing unboundedly; once a
  vault's stream is trimmed past a node's cursor, that node is told to
  `/sync/snapshot` instead (§4.4) — the snapshot is always a correct
  fallback, so trimming aggressively is safe, just shifts cost to Neo4j.
- Also used for: idempotency dedupe (`SET batch:<id> 1 NX EX 300` before
  commit), per-vault sequence counter, lightweight presence
  (`SETEX vault:<id>:node:<nodeId> 30 <ts>`, refreshed on each SSE
  heartbeat — cheap "who's currently connected" for future UI, not required
  for v1), and per-node rate limiting (`INCR` + expiring window) to bound
  abuse from a single misbehaving or looping node.
- Config: `appendonly yes` (AOF) so the stream survives a Redis restart —
  Redis here is not "just a cache," it's the durable ingest buffer between
  the network and Neo4j, so treat its persistence seriously even though
  Neo4j is the long-term source of truth.

### 6.3 Materializer (Neo4j writer)

A small worker process (can run inside the same sync-server binary as a
distinct mode, or as its own deployable — start with "same binary,
`--role=materializer` flag" for reproducibility, split out later if Neo4j
write throughput becomes the bottleneck) that:

- Is a Redis Streams **consumer group** member reading each vault's stream
  in order.
- For each patch batch: resolves LWW per §5 (reads current HLC per field
  from Neo4j or a Redis-cached shadow of it — cache the shadow in Redis to
  avoid a Neo4j round trip per field on the hot path, since the ingest tier
  already needs low latency), applies accepted patches inside one Neo4j
  transaction per batch, and `XACK`s the stream entry.
- Sharding: run one materializer consumer *per vault* conceptually, but
  implement as a small pool of worker processes each owning a subset of
  vaults (consistent-hash vault id → worker), so no single process is a
  hard bottleneck as vault count grows, while still guaranteeing
  in-order-per-vault writes (never split one vault's writes across
  concurrent workers — that reintroduces the race the whole HLC/seq design
  exists to avoid).

### 6.4 Neo4j data model

- One node per record: labeled `:Record:<TypeLocalName>` (derived from the
  `@type` IRI, mirroring how `dynamicSchema.ts` already derives a
  per-schema type IRI) with properties `id`, `graph` (= vaultId), and one
  property per scalar predicate. Multi-value (`set`) predicates map to a
  Neo4j array property directly — Neo4j natively supports primitive arrays
  as node properties, no extra relationship modeling needed for this app's
  flat record shape.
- Index: composite index on `(graph, id)` (lookup/upsert key) and on
  `(graph, type)` (used to serve `/sync/snapshot` filtered/paged if a vault
  grows large enough to want partial snapshots later — not needed for v1's
  whole-vault snapshot, but cheap to add now).
- Tombstones: `:Deleted` label + `deletedAtHlc` property left in place
  rather than deleting the node, purged by a scheduled job past the
  retention window (§5).
- Multi-tenancy: partition by a `graph` property + index rather than
  separate Neo4j databases per vault. Neo4j Community edition's
  multi-database support is limited/version-dependent — a single database
  with a partition key is the safer, more portable default for a
  reproducible OSS setup; revisit only if per-vault physical isolation
  becomes a real requirement.
- Backups: `neo4j-admin database dump` on a schedule (see deployment doc)
  — Neo4j is the durable source of truth; Redis's data is disposable
  (rebuildable from Neo4j + in-flight stream) by design, so back up Neo4j,
  not Redis.

## 7. Scaling and robustness notes

- **SSE at scale**: each open stream is one held connection per sync-server
  process. Node handles many thousands of idle-ish long-lived connections
  fine (no per-connection thread), but raise the OS file-descriptor limit
  (`ulimit -n`, `LimitNOFILE` in the systemd unit) and size the reverse
  proxy's worker connections accordingly. Send an SSE comment (`: ping\n\n`)
  every ~20s so intermediary proxies/load balancers don't treat the
  connection as idle and close it — a common silent failure mode for SSE
  behind AWS ELBs/nginx defaults.
- **Reverse proxy config**: disable response buffering for the `/sync/stream`
  route specifically (`proxy_buffering off;` + `X-Accel-Buffering: no`
  header in nginx; Caddy doesn't buffer by default, which is one reason to
  prefer it here) — buffering silently turns "real-time" into "arrives in
  32KB chunks," defeating the point.
- **Horizontal scale path**: sync-server tier scales linearly (stateless,
  add replicas). Redis Streams throughput scales well vertically and is
  rarely the bottleneck at this app's likely write volume (field edits from
  a UI, not high-frequency telemetry). The real long-term bottleneck is
  Neo4j single-writer-per-vault serialization — acceptable because writes
  are already logically serialized per vault (a person editing their own
  data), and the sharded-materializer-pool design in §6.3 lets total
  cross-vault throughput scale with worker count even though any single
  vault's writes stay ordered.
- **Failure modes**:
  - *Redis down*: ingest tier should reject new POSTs with a 503 (fail
    closed, don't accept writes it can't sequence) but keep serving already
    established SSE reads from... nothing, since Redis is also the fanout
    path — so Redis down means sync pauses entirely. Clients keep working
    locally (unchanged local-first behavior) and their outbound queues keep
    growing until Redis returns, then flush. This is an acceptable
    degradation given the "local-first, sync is additive" principle in §1.
  - *Neo4j down*: ingest/fanout via Redis Streams keeps working (already-
    connected nodes keep seeing each other's live edits!) — only durability
    and new-node snapshot bootstrap are affected. Materializer consumer
    group just falls behind and catches up (Streams retain unacked entries)
    once Neo4j returns. This decoupling is the main reason to put Redis
    Streams *in front of* Neo4j rather than writing to Neo4j synchronously
    in the request path.
  - *Node offline for a long time*: handled by the resync-via-snapshot path
    in §4.4 — always correct, bounded cost (one full-vault fetch).

## 8. Client-side integration plan

No rewrite of `localNgEngine.ts`'s local behavior — add a parallel module,
e.g. `src/utils/remoteSyncEngine.ts`, that:

1. If no vault is configured (`localStorage` has no `vaultId`/`vaultToken`),
   does nothing — app behaves exactly as it does today.
2. If configured: wraps `graph_orm_update` — after the existing local
   apply+broadcast happens, also pushes the patch batch (tagged with `hlc`,
   `nodeId`, `batchId`) onto a durable outbound queue (its own small
   `localStorage` array, flushed via `fetch POST /sync/patches` with
   retry/backoff; queue persists across reloads so it survives being closed
   mid-flush while offline).
3. Opens one `EventSource` for the configured vault, resuming from the
   locally stored `seq` cursor. On each event: if the `batchId` wasn't
   already applied locally (dedupe ring buffer, mirrors the existing
   `recentlyClosedSubscriptions` pattern), call the *existing*
   `applyPatchesToStore` + `broadcastToLocalSubscriptions` functions
   already exported from `localNgEngine.ts` — i.e. a remote patch re-uses
   exactly the same apply/notify path a cross-tab `BroadcastChannel`
   message does today, just from a different origin.
4. Pairing UI: a small addition to the existing Settings page
   (`SettingsPage.tsx`) — "Create sync vault" (calls `POST /sync/vaults`,
   shows the token/QR to copy to another device) and "Join existing vault"
   (paste vaultId + token). This is the only new UI surface required.

## 9. Security posture — decided: shared vault-token bearer scheme

The prompt states auth is explicitly out of scope for the *application*.
The sync layer is a new network-facing surface, though, so this separates
"user accounts" (still correctly out of scope, not built) from "is this
endpoint an open relay" (not acceptable, needs the minimum fix below).

**Decision: go with the `vaultToken` bearer scheme from §3.** A shared
secret per vault, not a user identity system — no accounts, no login, no
per-user records. Concretely:

- `POST /sync/vaults` returns `{ vaultId, vaultToken }` once, at creation.
  The token is shown to the user to copy/scan onto each additional device
  (§8.4's pairing UI) — it is never recoverable from the server after
  creation, only rotatable: **`POST /sync/vaults/rotate` (bearer-
  authenticated with the *current* token) issues a fresh one and
  invalidates the old immediately** — the "Rotate token" action in
  Settings (`SyncSettings.tsx`). Any other device still holding the old
  token gets 401s until it's manually given the new one — inherent to a
  shared-secret scheme with no per-device identity, not a bug.
- Every `/sync/stream`, `/sync/patches`, `/sync/snapshot`, and
  `/sync/vaults/rotate` call requires `Authorization: Bearer <vaultToken>`
  scoped to the `vault` in the query/body; the server rejects mismatches
  with 401 before touching Redis/Neo4j.
- Tokens are stored server-side as a SHA-256 hash (not plaintext) in
  Redis's per-vault `meta` hash (`vaultStore.ts`), verified with a
  constant-time compare. No separate per-token salt: the token itself is
  192 bits of `randomBytes`, so an unsalted hash carries the same
  practical guarantee a salt exists to provide for low-entropy secrets
  like passwords — a precomputed rainbow table over a 192-bit space isn't
  a real attack. (Storage location deviates from an earlier draft of this
  section, which said Neo4j — vault meta/tokens live in Redis only; see
  `remote-sync-progress.md`'s step-3 notes for why that's an accepted,
  explicit scoping decision rather than an oversight.)
- `POST /sync/vaults` is rate-limited per client IP (`VAULT_CREATE_RATE_LIMIT`,
  default 10/hour) — the one endpoint with no auth at all (it *creates* the
  credential), so it's the one open abuse/storage-exhaustion vector a
  bearer token can't close. See `remote-sync-deployment.md` §3 for the
  reverse-proxy assumption this relies on (`X-Forwarded-For`).
- Without at least the bearer-token check, any client that discovers the
  server URL could read or write any vault.
- TLS: terminate at the reverse proxy (Caddy gets this for free via
  auto-HTTPS with a real domain; self-signed/internal-CA for LAN-only
  deployments). Sync payloads currently include full record contents in
  plaintext-over-HTTP otherwise.
- Explicitly **not** doing: per-record permissions, multi-user sharing
  semantics, encryption at rest in Neo4j/Redis, or anything resembling
  accounts/login. If any of that turns out to be wanted later, the
  `vaultId`/`vaultToken` model in §3 is the natural place to extend from
  (e.g. multiple tokens per vault with different scopes) rather than a
  redesign.

Confirmed for this design — no further sign-off needed before building
against §3/§9 as specified.

## 10. Suggested build order (MVP → full)

1. Sync server skeleton: serves `dist/`, `/sync/health`, in-memory (no
   Redis/Neo4j yet) single-process patch relay — proves the client
   integration (§8) end-to-end on one machine.
2. Add Redis Streams for sequencing + fanout; multiple sync-server
   instances behind a local reverse proxy — proves horizontal scaling of
   the ingest tier.
3. Add Neo4j + materializer consumer group; implement `/sync/snapshot` and
   the resync path — proves durability and long-offline recovery.
4. Add HLC-based LWW conflict resolution + tombstones (§5) — needed before
   this is safe with real concurrent multi-device edits, but not needed to
   validate the transport/fanout plumbing in steps 1–3.
5. Vault pairing UI in Settings (§8.4) + bearer-token enforcement (§9).
6. Load/soak test: many idle SSE connections, burst writes, simulated long
   node-offline periods, Redis/Neo4j restart under load.

## 11. Future direction: streaming/lazy local storage (not started)

Flagged during step 2, not on the build-order critical path — recorded here
so it isn't lost. Everything below is a proposal for a later phase, not a
decision.

### The problem, concretely, in this codebase

`localNgEngine.ts` currently does the simplest thing that could work: the
entire graph is one JS object (`Store`, `localNgEngine.ts:38`), loaded whole
into a module-level variable at startup (`let store: Store = loadStore()`,
`localNgEngine.ts:77`), and on every single patch the *whole* store is
`JSON.stringify`'d and written back to `localStorage` in full
(`localNgEngine.ts:86-93`). `useShape`'s `orm_start_graph` subscribes to
"all locally stored objects matching a shape and scope" — there's no
concept of a partial or windowed subscription; a subscriber gets everything
that matches, full stop.

This was the right call for an MVP and is fine at today's scale, but it has
a hard ceiling that's independent of performance: `localStorage` is
synchronous and capped at roughly 5-10MB per origin depending on browser.
Once total record volume approaches that, the app doesn't degrade
gracefully — it breaks (quota exceeded on write). Perf (full
`JSON.stringify`/`parse` on every mutation, everything reactively
re-rendering off one big store) becomes a problem well before that, but the
storage ceiling is the harder wall.

The remote sync layer built in steps 1-2 inherits the same eager-loading
shape rather than fixing it: `/sync/snapshot` (`server/src/vaultStore.ts`'s
`snapshot()`) does an `HGETALL` of the *entire* per-vault Redis hash and
ships it as one JSON blob (`{ seq, records: Store }`), and the client's
`resyncFromSnapshot` (`remoteSyncEngine.ts:204-220`) applies it via
`replaceGraphAndReload`, which reloads the whole page around the whole new
`Store`. So a large vault means a large full-graph transfer on every fresh
device pairing or gap-triggered resync, not just a large `localStorage`
write.

### The shift being proposed

Move from eager loading (whole graph in memory/`localStorage` at startup)
to demand-driven streaming (querying and windowing records on demand),
matching the general pattern: memory scaling goes from O(total records) to
O(records actually on screen). Concretely, for this codebase:

- **Storage layer**: replace the single `localStorage` blob with an
  indexed store in IndexedDB (or OPFS), keyed the way graph data actually
  gets queried here — by subject (today's `@id`/`@graph` lookups), and by
  shape/type (today's `orm_start_graph` scope filter) — so a query can
  pull back only the matching records instead of the entire store.
- **Subscription layer**: `orm_start_graph` currently means "give me
  everything matching this shape/scope." A windowed version would let
  callers like `BlockRenderer.tsx` ask only for a block's immediate
  children (mirroring how `collectDescendantBlockIds` in `blockGraph.ts`
  already walks the graph incrementally rather than assuming it's all
  resident) rather than the whole graph being implicitly available.
- **Sync protocol**: `/sync/snapshot` would need to become windowed/paged
  too, not just the client store — otherwise the client-side fix is
  undermined by a resync that still pulls everything from the server in
  one shot. This is a real, non-optional part of doing this properly here,
  not an orthogonal concern.
- **Off-main-thread traversal**: if graph traversal work grows (deeper
  `blockGraph.ts` walks, more complex shape resolution), consider moving
  it into a Web Worker so it can't block UI frames — not urgent at current
  traversal depth, but worth keeping in mind if `blockGraph.ts` grows more
  expensive.

One thing that's already fine and doesn't need to change: cross-tab sync
via `BroadcastChannel` already sends compact patch deltas rather than
whole-graph snapshots (this is the same patch shape the remote sync layer
reuses), so that part of the design already matches the target end state.

### Why later, not now

This is real work with real risk (a storage migration touches every read
path in `localNgEngine.ts`) and there's no evidence yet that current usage
is anywhere near the `localStorage` ceiling. Reasonable trigger conditions
to revisit this: approaching the ~5-10MB `localStorage` quota in practice,
or noticeable UI jank from full-store re-renders/serialization on typical
vaults. Until then, this section is a placeholder for when that happens,
not a task to schedule.

## 12. Future direction: rendered diagrams via d2topng (not started)

Flagged while wrapping up build-order step 4, not on the critical path —
recorded here so it isn't lost. A proposal for once the remaining
build-order items (tombstone retention, step 6's load/soak test) are
done, not a task to schedule now.

### The idea

Once this doc's design has settled down (fewer diagram-invalidating
changes), redraw the ASCII diagram in §6 and add a couple more — the
consumer-group crash-recovery sequence from step 3 (§6.3) and the
tombstone accept/reject decision flow added in step 4 (§5) are the two
most likely to benefit — as [D2](https://d2lang.com) source, rendered to
PNG and embedded in the markdown instead of hand-drawn ASCII art.

### How it would work

[d2topng](https://github.com/macsplit/d2topng) (deployed at
`https://d2topng.onrender.com`) is a small HTTP service purpose-built for
this: `POST /render[?scale=N]` with raw D2 source as the request body
returns a PNG (`image/png`) on success, or an HTTP 400 with D2's own
diagnostic text on a syntax error; `Authorization: Bearer <token>` is only
required if the deployment has `D2TOPNG_API_TOKEN` set (unconfirmed for
the public instance above — check before relying on it being open).
Concretely:

- Diagram sources live as `.d2` files, e.g.
  `docs/diagrams/server-architecture.d2`.
- A small script (`curl -H "Authorization: Bearer $D2TOPNG_TOKEN"
  --data-binary @docs/diagrams/foo.d2 https://d2topng.onrender.com/render
  -o docs/diagrams/foo.png`, or the Node equivalent) regenerates the PNG
  from source on demand.
- The generated **PNGs are committed alongside their `.d2` source**, not
  fetched live when a doc is viewed — this is a free-tier, third-party
  hosted service with no SLA and a plausible cold-start delay; docs must
  keep rendering correctly if that instance is ever slow, down, or gone.
  Regenerate locally when the `.d2` source changes; don't wire this into
  CI as a build-blocking step, since that would make doc builds depend on
  an external free service staying up.
- Markdown embed is then just `` ![server architecture](diagrams/server-architecture.png) ``
  in place of the current fenced ASCII block.

### Why later, not now

Low risk compared to §11, but genuinely not urgent: the architecture is
still shifting build-order step to build-order step, and redrawing
diagrams before that settles means redrawing them again shortly after.
Revisit once the build order in §10 is fully checked off.
