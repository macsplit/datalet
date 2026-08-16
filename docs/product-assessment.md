# Product Assessment

**Status: current.** What this project is well suited to and what it is not.
Kept accurate as work lands; the plan for what remains is
[`roadmap.md`](roadmap.md).

First written 2026-08-08 (as `product-evaluation-2026-08-08.md`), last reviewed
2026-08-16. Based on reading the application source, the sync tier and the
design documents — not on user research or a field deployment.

## What it actually is

Two products stacked, and worth separating:

1. **A browser-local, no-code record-app builder.** Schemas and fields are
   defined in a Settings UI and arranged into tabs, layout blocks and data
   blocks, producing working CRUD screens. Everything — user records *and* the
   builder's own configuration — lives as graph data in `localStorage`,
   mirrored across tabs via `BroadcastChannel`. No accounts, no install, no
   backend.
2. **An optional sync tier.** Pairing a vault replicates the same graph across
   devices via HTTP POST up and SSE down, with Redis for sequencing and fanout
   and Neo4j as the system of record.

The genuinely distinctive property is that the builder's metadata is stored in
the same graph as the user data, through the same subscription mechanism. When
you sync, your *app design* travels with your data — build a screen on the
laptop and it appears on the phone. That falls out of the architecture rather
than being special-cased.

## What it is good for

**Personal and small-team trackers where the shape of the data is yours to
define.** Inventories, collections, habit and reading logs, lightweight CRM,
expense lists, project checklists. The loop from "I need a field" to "the field
is on screen" is seconds, with no code and no deploy.

**Privacy by construction.** Unpaired, there is no network surface at all —
data physically cannot leave the browser profile. For someone who wants a
tracker that is not a SaaS account, that is the whole pitch, and it is honest
here rather than marketing.

**Fast data-model prototyping.** Sketching a schema plus screens with a
stakeholder in a meeting, before committing to a real build.

**A reference implementation to learn from or fork.** The sync layer is
well-built for its size: HLC-ordered last-write-wins for scalars, commutative
merge for set fields, tombstones with retention purging, `batchId` idempotency,
stateless ingest behind a proxy, snapshot fallback when a resume cursor falls
outside the retained stream, and an offline outbox that persists across
reloads. [`build-history.md`](build-history.md) is an unusually honest record —
it keeps the bugs found (Neo4j nodes keyed by the wrong id creating silent
orphans; Redis running without AOF despite the docs claiming otherwise) rather
than presenting a clean story. The extension seam is narrow by design: the
whole engine is two functions, which is why sync bolted on without rewriting
the app.

## What it is not good for

**Complex relational workflows.** Fields include record references, so a Task
can point to a Project without duplicating its name — but there are no reverse
lookups, joins, relationship constraints, rollups or cascading record
behaviour. File, image and rich-text types remain absent. Text properties can
render as plain or long text, URL or email controls; unsafe URL schemes stay
inert text. Dates are ISO strings, with date-time normalised to UTC and
displayed in the browser locale.

**Any dataset above small.** Data blocks apply configured filtering and
sorting, and readers get an optional search box and pagination over the
displayed fields. Grouping and aggregation are absent, and search is a linear
scan of the in-memory store rather than an index. Underneath, the entire store
is held in memory with a hard 4 MB cap
(`RUNTIME_LIMITS.storedBytes`). Persistence is incremental per touched record,
but startup still loads every record and subscriptions still scan the full
store. Realistic ceiling: hundreds to low thousands of small records. It
degrades on the UX and performance axes at the same time.

**Multi-user work.** The vault token is all-or-nothing: whoever holds it has
full read/write over everything in the vault. No accounts, no per-record
ownership, no roles, no audit trail, no selective sharing — all explicitly out
of scope per `remote-sync-architecture.md` §9, and correctly so, but it means
the sync story is "one person's devices", not "a team".

**Regulated or sensitive data once synced.** No end-to-end encryption; the
server sees plaintext. No encryption at rest in Redis or Neo4j. TLS exists only
with a reverse proxy in front. Because `EventSource` cannot set headers, SSE
uses a one-hour stream-only ticket in its URL; the durable vault token is no
longer exposed to proxy access logs.

**Anything needing strict synchronous durability.** Neo4j mirrors vault
identity and is the system of record for records, but accepted writes first
enter Redis with AOF `everysec`, leaving roughly a one-second crash window.
Materialization runs at about 130 records/s, so the Neo4j copy trails the live
Redis copy by seconds under load.

**Long-term maintenance is still early.** There are browser regressions for
persistence and bootstrap, reader data blocks, schema and property editing, tab
management, nested blocks, widget management, cleanup cascades, sync recovery
and offline startup. Server tests cover patch behaviour, the Redis conflict
path, Redis-loss snapshot recovery and tombstone purging, and run in CI. That
is meaningful workflow coverage, not a comprehensive unit or visual test
matrix.

## Smaller things worth knowing

- Conflict resolution is field-level last-write-wins with no shared history and
  no merge UI. A bounded page-session undo stack reverses recent local edits by
  emitting a fresh write, at one entry per editing gesture rather than per
  keystroke. Fully and partially superseded writes raise a visible warning with
  the server's reason and dropped-patch count; the winning value still
  converges through SSE without a second rollback path.
- Recovery from a stale cursor reconciles the snapshot into mounted
  subscriptions without navigation, then reconnects and flushes the untouched
  outbox. Import and pairing still reload deliberately.
- JSON export and import provide an explicit local backup path covering both
  records and builder metadata. Each data block additionally exports its own
  matching records as JSON and prints them as a plain black-and-white table
  with the interface left off the page.
- Production builds include a manifest and service worker. After one online
  load the shell and local records cold-start offline; paired edits continue
  through the persistent outbox. Sync endpoints are always bypassed by the
  worker.
- A known upstream `@ng-org/orm` subscription-lifecycle race is documented. The
  engine now makes the write path indifferent to it by dropping batches that
  change nothing; the error boundary still catches what remains.

## Summary judgment

This is a well-engineered, well-documented prototype whose **sync architecture
is more mature than its application layer**. The server side reads like
production thinking — sequencing, idempotency, tombstones, horizontal scaling,
soak tests under hard kills. The app layer stays deliberately small, but now
covers references, configured filtering and sorting, reader search and
pagination, per-block export and print, undo, and portable backups.

So: strong as a personal tool for small self-defined datasets, as a
demonstration of local-first architecture, or as a foundation to build on. Not
ready for team use, complex relational workflows, meaningful volume, or
sensitive information.

The high-leverage product gaps this document originally identified —
export/import, data-block filter and sort, reference fields, end-user search
and pagination, date/time fields, URL/email/long-text controls, undo, visible
discarded writes, non-destructive cursor recovery, an offline shell, and
builder regression coverage — are now implemented. File and image fields remain
intentionally absent pending a storage design that keeps binary data out of the
4 MB JSON path. The remaining plan is [`roadmap.md`](roadmap.md).
