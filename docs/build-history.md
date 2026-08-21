# Build History and Findings

**Status: historical.** A condensed record of how the sync tier and the
persistence layer were built, and — the part that is still worth reading — the
real defects found along the way, how each was found, and what was changed.

This replaces three much longer step-by-step logs
(`remote-sync-progress.md`, `incremental-persistence-progress.md`,
`project-next-steps.md`), which were written as work journals and had outlived
that purpose. Their full text remains in the Git history if you need the
narrative; everything below is what survived the edit.

For how the system works now, read [`architecture.md`](architecture.md).

---

## How the sync tier was built

Each step was verified end to end before the next began, mostly by probing the
API and the databases directly rather than through the browser. That habit is
what caught most of the defects below — several were invisible from the UI.

| Step | What landed |
| --- | --- |
| 1 | In-memory single-process sync server. Proved the wire protocol, the client integration and the two-hook seam into `localNgEngine.ts` with no Redis or Neo4j. |
| 2 | Redis Streams for sequencing and fanout; state moved out of process memory so multiple stateless instances share a vault. Horizontal scaling proved behind a reverse proxy. |
| 3 | Neo4j plus the materializer as the durable system of record, decoupled from ingest. `/sync/snapshot` switched to read Neo4j. |
| 4 | Tombstones remembered by the ingest tier and checked before applying any later patch. |
| 4b | Tombstone retention: periodic purge from both stores after 30 days. |
| 6 | Burst load and restart testing against the real stack. |
| 7 | Token rotation and vault-creation rate limiting. |
| 8 | Debounced visible warning when the sync connection is lost. |
| 9 | Hard-kill soak testing and sustained load. Found the durability gap below. |
| 10 | Plain-language reference doc with rendered diagrams. |
| 11 | Durable vault metadata, stream tickets, automated regression suites in CI. |
| 12 | Multi-tenant A1: materializer stream multiplexing, multi-stream pending recovery, and a reusable 200-vault connection/lag/memory harness. |
| 13 | Multi-tenant A2: deterministic vault sharding, stable per-shard consumers, Redis lease/heartbeat conflict detection, and two-shard integration coverage. |
| 14 | Multi-tenant A3: a closed Neo4j record-label set, exact indexed type preservation, a dry-run-first legacy-label cleanup, and 50-schema/10-vault coverage. |
| 15 | Multi-tenant A4: atomic per-vault Redis byte quotas, deletion credit, concurrency-safe whole-batch refusal, and client-visible quota warnings. |
| 16 | Multi-tenant A5: authenticated per-vault write limiting, atomic expiring counters, and retry-safe client 429 handling distinct from terminal 409s. |
| 17 | Multi-tenant A6: atomic last-active tracking, authenticated two-store vault deletion, cross-replica SSE disconnect, dead-stream reconciliation, and report-only idle detection. |
| 18 | Multi-tenant A7: operator-only per-vault statistics behind a credential no vault token satisfies, consumer-group backlog reporting, SSCAN paging, and a matching structured stats log. |
| 19 | Theme in the graph T1-T5: the project's first Content Security Policy, an allowlisted colour-role set with a closed value grammar, per-role light/dark fields on Settings, and a generated stylesheet rather than inline custom properties. |
| 20 | Theme follow-ups: the colour controls moved onto their own page, the picker and preview merged into one swatch, a per-colour reset, and a minimum-contrast floor whose sweep tests found two real defects in it. |
| 21 | Persistent storage requested and its answer reported honestly, plus a theme-color that follows the stored palette per scheme. |

---

## Defects found, and how

### Two nodes racing to create the same record (step 1)

Two devices bootstrapping from empty storage both create the well-known "Home"
tab before their first catch-up lands, and one silently overwrites the other.

Fixed by treating a record's identity — the root add and `@id`/`@graph`/`@type`
— as **write-once** server-side. A duplicate creation is deduped rather than
applied.

### SSE headers never flushed on an idle stream (step 2)

Connecting to a brand-new vault with no history produced *no response at all* —
not even headers — for many seconds. `writeHead()` sets response state but does
not push bytes; the implicit flush normally happens on the first `write()`, and
a vault with nothing to replay has nothing to write until the 20 s heartbeat.
Every earlier test happened to have something to send immediately, which is why
the code path had existed since step 1 without anyone noticing.

Fixed with an explicit `flushHeaders()`.

Worth recording because the *first* diagnosis was wrong: the symptom appeared
through a Caddy proxy, and gzip buffering of an SSE response is a real and
well-known anti-pattern. Reproducing directly against a backend instance with
no proxy in the path, and with `Accept-Encoding` stripped, still hung — which is
what pointed at the real cause. The reference Caddyfile now scopes `encode gzip`
away from `/sync/stream` anyway, because that risk is genuine even though it was
not this bug.

### Neo4j nodes keyed by the wrong id (step 3)

The single most instructive bug here. In this app the first path segment of a
patch (`subjectId`) is a graph-qualified key like
`did:ng:<vaultId>|did:ng:z:meta:schema:<uuid>`, while the record's own `@id`
field is the bare unqualified id. They are **not** the same string for any
record the app generates.

Redis had always keyed by `subjectId`. The first version of `materialize.ts`
wrote Neo4j nodes keyed by `record["@id"]` while reading them back by
`subjectId`. So a record's first write landed on one node, and every subsequent
update created a *separate, untyped orphan node* — because the read-before-write
lookup never found the first one.

It was invisible from the app: a client never re-derives a record from a
server-side replay mid-session, and the `subjectId`-keyed Redis path that live
sync actually uses was never wrong. It only surfaced because `/sync/snapshot`
had just been switched to read Neo4j, and because the regression test finally
used the app's real generated ids instead of hand-written ones like `rec:foo`
— for which `subjectId` and `@id` coincidentally match.

Fixed by keying by `(graph, subjectId)` throughout and storing the record's own
`@id`/`@graph` as separate `recordId`/`recordGraph` properties. Re-verified by
wiping both stores and inspecting Neo4j directly with `cypher-shell`.

**The lesson that generalises:** hand-written test fixtures that accidentally
collapse two distinct identifiers will hide an entire class of bug.

### Stale edits resurrecting deleted records (step 4)

Found by auditing the Lua script after step 3, not by a bug report. A
whole-record delete did a plain `HDEL` with no memory that the subject had ever
existed, so a node that had been offline across the deletion could replay a
stale edit, have it accepted as a *fresh creation*, and see the materializer
dutifully undelete the record in Neo4j.

Fixed with a per-vault tombstone hash checked before any accept logic runs. A
batch whose HLC does not strictly exceed the deletion's is rejected with its own
distinct reason; a genuinely newer batch proceeds and clears the tombstone.

### Redis had no AOF, and accepted writes could vanish (step 9)

Checked Redis's running configuration before testing rather than trusting the
step-2 log's claim that `appendonly yes` was set. It was not — persistence was
RDB-snapshot-only on the defaults, meaning no snapshot at all for a short burst.
Either `CONFIG SET` had been used without `CONFIG REWRITE` and a later restart
reverted it, or the original claim was never verified against the file.

Reproduced twice with a hard `kill -9`:

- **400 writes, kill ~22 ms after the last response:** all 400 accepted with
  HTTP 200, and **zero survived anywhere** — not in Redis, and not in Neo4j
  either, since the materializer never got to consume them.
- **300 writes with a few seconds' delay before the kill:** record data survived
  in Neo4j, but the vault's own meta entry and index membership did not.
  `/sync/snapshot` returned 404 permanently; the token was only ever a hash and
  that hash was gone. The data still existed in Neo4j, orphaned and unreachable.

This mattered beyond "Redis lost data": the client's outbox treats HTTP 200 as
delivery confirmation and drops the entry from its retry queue. Run 2 shows a
write could be told "accepted" and then vanish with the client never finding
out.

Fixed by enabling AOF and persisting it properly (`CONFIG SET` **plus**
`CONFIG REWRITE`, verified in the file and across a restart). Re-running the
exact scenario that had lost everything recovered all 400 records and the
vault's identity. The separate question — that vault metadata lived in Redis
only — was deliberately left open at the time and closed in step 11 by
mirroring it into Neo4j with reconstruction on demand.

### A documented environment variable that no code read (step 7)

`VAULT_TOKEN_SECRET` appeared in the deployment doc's configuration table,
described as the key used to sign vault tokens. A repo-wide grep found no
reader. The design never needed a server-wide signing secret — each vault token
is its own random opaque value, hashed per vault. Removed, along with a
"stored in Neo4j" claim about vault metadata that was untrue at the time.

---

## Measurements

Taken on a development box against the real stack. Indicative, not an SLA.

**Burst and restart (step 6)**

- 200 idle SSE connections opened in 200 ms; a subsequent patch reached all 200
  within ~1 s.
- 500 concurrent `POST /sync/patches` all accepted in 353 ms (~1,400 req/s),
  with unique, gapless sequence numbers — the Lua script's atomicity holding
  under real concurrency, not just logically.
- Materialization: a 500-write burst accepted in 392 ms took ~3.8 s to appear
  in full through the Neo4j-backed snapshot — about **130 records/s**, one
  sequential read plus write per touched subject. Live SSE fanout is unaffected;
  only the durable copy trails.
- Redis restarted mid-burst: zero failed requests (ioredis queues offline
  commands through a graceful restart).
- Neo4j restarted mid-materialization: ingest logged no errors at all, and the
  consumer was picked back up by the 3 s discovery poll with no data loss.

**Sustained load (step 9)**

1,790 writes over 3 minutes at 10/s with 50 idle SSE connections: zero errors,
zero rejections, all confirmed materialized. Both Node processes grew from a
~86–90 MB baseline to ~103 MB and ~118 MB over the first 90–100 s and then
plateaued. Redis memory grew linearly with stored data. Three minutes is too
short to rule out a slow leak.

**Curtailed endurance sample (step 11)**

An intended two-hour run was stopped at the user's request after ~19 minutes:
20 concurrent SSE connections, one accepted write per second, 1,139 writes with
zero request errors. The materializer was killed at five minutes and restarted
30 seconds later; pending work rose to 1 at the failure boundary and returned
to 0 by the next sample. The artifact is
[`remote-sync-endurance-results.json`](remote-sync-endurance-results.json),
honestly labelled `status: curtailed`. Because it was curtailed it never ran
the terminal accepted-versus-materialized equality check and cannot rule out a
slow leak. A real multi-hour run remains open — see
[`roadmap.md`](roadmap.md).

---

## Incremental persistence

A separate, client-only change to `localNgEngine.ts`.

**The problem.** The whole store was persisted as one JSON blob under one key,
so every edit — however small — triggered a full `JSON.stringify` plus a full
`setItem` of the entire store. Cost was O(total store size) per flush rather
than O(what changed).

**What was done.** One key per record plus a small index; a `dirtyIds` set
populated at both mutation points in `applyPatchesToStore`; a two-pass flush
that computes projected size and all writes before touching `localStorage`, so
the all-or-nothing 4 MB safety cap still holds exactly; and a write-before-delete
migration from the old blob that verifies byte-for-byte before removing the old
key.

**Deliberately not done:** IndexedDB or OPFS, windowed subscriptions, any change
to the in-memory `Store` shape or the sync protocol. Those had previously been
recorded as a "future direction" and were deleted as a different product's
scope. Startup still loads the whole store, and the 4 MB ceiling remains.

**The claim it had to prove.** With 300 records seeded, one small field edit
through the real UI fired exactly one `setItem` of 245 bytes — not a rewrite of
the store.

**Two bugs the verification exposed:**

- `replaceGraphAndReload` mutates `store` directly rather than through
  `applyPatchesToStore`, so once flushing became dirty-set-driven it would have
  silently stopped persisting its own changes. Caught in review, before testing.
- A rejected load could leave partially populated byte-length bookkeeping
  behind. Rejected or invalid loads now clear bookkeeping and disable
  persistence for that page load, so bootstrap defaults cannot overwrite data
  the app just refused to load.

**Overhead.** Many small writes cost more than one blob write in isolation —
1,000 small writes 4.9 ms versus 0.8 ms; 5,000 versus one, 27.7 ms versus
3.2 ms. That fixed per-call cost is real, but the path being optimised writes
one touched record, not thousands.

---

## Application-layer defects worth remembering

Found while building reader tools, undo and the export/print controls.

**Edited values went stale on screen.** A field edited through the UI could
display an older value than the store held, because optimistic control state
and the graph-backed value could diverge. Resolved before any further field
types were added, since every new input type would otherwise inherit it.

**Undo lost data through the vault.** Undo submits `remove` then `add` for one
field in a single batch. Because every patch in a batch carries the batch's one
HLC, the strict last-write-wins test made the restoring `add` lose against the
HLC its own removal had just written. The vault kept the deletion and dropped
the restore, so an undo reached other devices as "field cleared". The user saw
it as a cosmetic "1 of 2 local changes were not applied" warning; it was real
data loss. Fixed in `applyBatch.lua` by tracking the fields a batch has already
claimed.

**Editing a field after undoing it froze the tab.** Pre-existing, and unrelated
to undo itself. Adding a field opens a new shape revision while the ORM tears
the old one down some time later, so two subscriptions briefly watch the same
records; both share the same mutable record branch, so each saw the other's
write, called it a fresh edit, and rebroadcast it forever. Diagnosed by pausing
the hung page over CDP and logging subscription lifecycle, and confirmed
pre-existing by stashing the local changes. Fixed with an inert-batch guard in
`graph_orm_update`, compared against the engine's shadow snapshot rather than
the live store — the first attempt compared against the live store, where ORM
signals had already applied the mutation, and so treated every genuine edit as
inert.
