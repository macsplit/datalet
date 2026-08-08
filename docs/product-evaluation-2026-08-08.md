# Product Evaluation — 2026-08-08

An assessment of what this project is well suited to and what it is not,
started at commit `53aaef0`, updated after the persistence/test follow-up, and
again after data-block reader search and pagination landed. Based on reading
the application source (`src/`), the sync tier (`server/`), and the four
`remote-sync*` design documents — not on user research or field deployment.

**Status: current.** This document is kept accurate as work lands; the ordered
plan for the gaps it identifies is `product-gaps-plan.md`.

## What it actually is

Two products stacked, and it is worth separating them:

1. **A browser-local, no-code record-app builder** (`src/`) — schemas
   and fields are defined in a Settings UI, arranged into tabs, layout
   blocks, and data blocks, producing working CRUD screens. Everything
   (both user records *and* the builder's own configuration) lives as
   graph data in `localStorage`, mirrored across tabs via
   `BroadcastChannel`. No accounts, no install, no backend.

2. **An optional sync tier** (`server/`) — pairing a vault (id + bearer
   token) replicates the same graph across devices via HTTP POST up and
   SSE down, with Redis Streams for sequencing and fanout and Neo4j as
   the system of record.

The genuinely distinctive property is that the builder's metadata is
stored in the same graph as the user data, through the same subscription
mechanism. So when you sync, your *app design* travels with your data —
build a screen on the laptop, it appears on the phone. That falls out of
the architecture rather than being special-cased.

## What it is good for

**Personal and small-team trackers where the shape of the data is yours
to define.** Inventories, collections, habit and reading logs,
lightweight CRM, expense lists, project checklists. The loop from "I
need a field" to "the field is on screen" is seconds, with no code and
no deploy.

**Privacy-by-construction use.** Unpaired, there is no network surface
at all — data physically cannot leave the browser profile. For someone
who wants a tracker that is not a SaaS account, that is the whole pitch,
and it is honest here rather than marketing.

**Fast data-model prototyping.** Sketching a schema plus screens with a
stakeholder in a meeting, before committing to a real build.

**A reference implementation to learn from or fork.** The sync layer is
well-built for its size: HLC-ordered last-write-wins for scalars,
commutative merge for set fields, tombstones with retention purging,
`batchId` idempotency, stateless ingest behind a proxy, snapshot
fallback when a resume cursor falls outside Redis's retained stream, and
an offline outbox that persists across reloads.
`docs/remote-sync-progress.md` is an unusually honest build log — it
records the bugs found (Neo4j nodes keyed by the wrong id creating
silent orphans; Redis running without AOF despite docs claiming
otherwise) rather than presenting a clean story. The extension seam is
also narrow by design: the whole engine is two functions
(`orm_start_graph`, `graph_orm_update` in `src/utils/localNgEngine.ts`),
which is why sync bolted on without rewriting the app.

## What it is not good for

**Complex relational workflows.** Fields now include record references, so a
Task can point to a Project without duplicating its name. There are still no
reverse lookups, joins, relationship constraints, rollups, or cascading record
behavior. Date/time, file/image, rich text, URL, and email types also remain
absent.

**Any dataset above small.** Data blocks apply configured field filtering and
sorting, and readers now get an optional search box and pagination over the
displayed fields. Grouping and aggregation remain absent, and search is a
linear scan of the in-memory store rather than an index. Underneath, the entire
store is held in memory with a hard
4 MB cap (`RUNTIME_LIMITS.storedBytes`, `src/utils/runtimeHealth.ts:69`).
Persistence is now incremental per touched record, but startup still loads
every record and subscriptions still scan the full in-memory store.
Realistic ceiling: hundreds to low thousands of small records. It
degrades on the UX and performance axes at the same time.

**Multi-user work.** The vault token is all-or-nothing: whoever holds it
has full read/write over everything in the vault. No accounts, no
per-record ownership, no roles, no audit trail, no selective sharing —
all explicitly out of scope per `remote-sync-architecture.md` §9, and
correctly so, but it means the sync story is "one person's devices," not
"a team."

**Regulated or sensitive data once synced.** No end-to-end encryption;
the server sees plaintext records. No encryption at rest in Redis or
Neo4j. TLS exists only with a reverse proxy in front. Because `EventSource`
cannot set headers, SSE uses a one-hour stream-only ticket in its URL; the
durable vault bearer token is no longer exposed to proxy access logs.

**Anything needing strict synchronous durability today.** Neo4j now mirrors
vault identity and is the record system of record, but accepted writes first
enter Redis with AOF `everysec`, retaining an approximately one-second crash
window. Materialization runs at ~130 records/s, so the Neo4j copy trails the
live Redis copy by seconds under load.

**Long-term maintenance remains early.** The repository now has browser
regressions for persistence/bootstrap and server tests for patch behavior and
the Redis conflict path, Redis-loss snapshot recovery, and tombstone purging,
run in CI. Coverage is intentionally narrow; most UI builder workflows still
need broader regression coverage.

**True offline-first, despite the framing.** There is no service worker
and no web manifest (`public/` contains only a favicon). Data persists
offline, but a cold page load with no network will not start the app.
It is "local storage," not "installable offline app."

## Smaller things worth knowing

- Conflict resolution is field-level LWW with no history, no undo, and
  no merge UI. A losing write returns 409 and is silently discarded
  client-side (`src/utils/remoteSyncEngine.ts:227`) — correct per the
  design, invisible to the user.
- Recovery from a stale cursor is wholesale graph replacement plus a
  forced page reload (`replaceGraphAndReload`). Unpushed edits survive
  in the outbox, but it is disruptive.
- JSON export/import now provides an explicit local backup path containing
  both records and builder metadata.
- A known upstream `@ng-org/orm` subscription-lifecycle race is
  documented; the error boundary catches it, but it surfaces as a
  reload screen when it fires.

## Summary judgment

This is a well-engineered, well-documented prototype whose **sync
architecture is considerably more mature than its application layer**.
The server side reads like production thinking — sequencing,
idempotency, tombstones, horizontal scaling, soak tests under hard
kills. The app layer remains deliberately small, but now covers references,
configured filtering/sorting, and portable local backups.

So: strong as a personal tool for small self-defined datasets, as a
demonstration of local-first architecture, or as a foundation to build
on. Not ready for team use, complex relational workflows, meaningful volume,
or sensitive information.

The previously identified high-leverage product gaps—export/import,
data-block filter/sort, reference fields, and end-user search/pagination—are now
implemented. The next likely application-layer gaps are date/time and file field
types, and undo/history for conflict or editing mistakes. The ordered plan for
the rest is `product-gaps-plan.md`.

An IndexedDB/windowed-subscription migration was considered and explicitly
rejected as current scope. Incremental per-record `localStorage` persistence
addresses the immediate edit hot path without pretending to remove the
remaining startup, query, or quota ceilings.
