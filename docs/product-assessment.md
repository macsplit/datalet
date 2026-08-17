# Product Assessment

**Status: current.** What this project is, what it is well suited to, and which
additions would cost it that. Kept accurate as work lands; the plan for what
remains is [`roadmap.md`](roadmap.md).

First written 2026-08-08 (as `product-evaluation-2026-08-08.md`), reframed
2026-08-16. Based on reading the application source, the sync tier and the
design documents — not on user research or a field deployment.

## What it actually is

It is tempting to describe this as two products stacked — a no-code record-app
builder, plus an optional sync tier. That framing is accurate and unhelpful,
because "no-code app builder" is a category, and in that category this loses to
Airtable, Notion, Baserow and NocoDB on every axis, permanently and by
construction.

The narrower and truer statement is:

> **The app definition is stored as ordinary records in the same graph as the
> user's data, through the same subscription mechanism.**

Everything distinctive follows from that one decision:

- Screens sync because they *are* data. Build a tab on a laptop, it appears on
  the phone. Nothing special-cases it.
- The builder needs no persistence, migration story or export format of its
  own. A backup is the app *and* its contents, in one JSON file.
- The same is true of how it looks. The colour theme is a set of fields on the
  Settings record, so it syncs, backs up and undoes like any other edit — no
  theme format, no theme storage, no theme sync.
- A schema edit is a live, non-destructive event rather than a migration:
  `buildShapeType()` hashes the property list into the runtime shape IRI, so
  the subscription reopens while the stable record type keeps existing records
  loading.

That is not a builder feature. It is a claim about what an application is.
Treating it as a builder feature — "we should also have X, since builders have
X" — trades away the only property here that is not available elsewhere.

Mechanically, the system is still two tiers, and they are worth keeping
separate when reasoning about it:

1. **The browser-local tier.** Schemas, fields, tabs, layout blocks, data
   blocks and widgets defined in a Settings UI and stored as graph data in
   `localStorage`, mirrored across tabs via `BroadcastChannel`. No accounts, no
   install, no backend.
2. **The optional sync tier.** Pairing a vault replicates the same graph across
   devices via HTTP POST up and SSE down, with Redis for sequencing and fanout
   and Neo4j as the system of record.

## What it is good for

**1. One person's tracker, where the schema is unstable.** Not "CRUD over a few
hundred records" — everything does that. The win is the loop from "I need a
field" to "the field is on screen and old records still load," in seconds, with
no code and no deploy. Collections, reading and training logs, a job search, a
renovation punch list, a small research corpus. The value scales with *how
often the shape changes*, not with row count.

**2. Data that should not be in anyone's SaaS.** Unpaired, there is no network
code on any path — verifiable by reading the source, and now enforced by a
Content Security Policy whose `font-src 'self'` means stored data cannot cause
an outbound request even if some future change forgets why that matters. Almost nothing else in this space can say that. Medication logs,
therapy notes, a legal-matter chronology, salary and finance notes, anything
about other people that is not yours to hand to a vendor. Two conditions belong
to the use case rather than beside it: it holds only while **unpaired** (paired,
the server reads plaintext), and durability rests entirely on the user's own
JSON exports. Backup discipline is part of this scenario's definition.

**3. Schema elicitation with a stakeholder in the room.** Build the model live
while they talk, put working screens in front of them in the same meeting,
export the JSON as the artifact. Rough edges do not matter here, because the
output is agreement rather than software.

**4. A specimen of local-first architecture at readable size.** Roughly 9.5k
lines total, and the pedagogy is the point: the entire engine is two functions,
so the substitution for the real NextGraph wasm/broker engine is legible; the
same patch algebra exists three times (`src/utils/localNgEngine.ts`,
`server/src/patchApply.ts`, `server/src/redis/applyBatch.lua`) with the docs
stating plainly that all three move together;
[`build-history.md`](build-history.md) keeps the defects — Neo4j nodes keyed by
the wrong id creating silent orphans, Redis running without AOF while the docs
claimed otherwise — instead of laundering them. People tend to learn more from
an artifact this size than from a production codebase.

**5. A fork base for one domain-specific local-first app.** The two-function
seam is real leverage, and the strongest available evidence that it holds is
that the whole sync tier attached through `onLocalPatch` /
`applyRemoteSyncPatches` without a single component changing. The sync layer
itself is well built for its size: HLC-ordered last-write-wins for scalars,
commutative merge for set fields, tombstones with retention purging, `batchId`
idempotency, stateless ingest behind a proxy, snapshot fallback when a resume
cursor falls outside the retained stream, and an offline outbox that survives
reloads.

**6. Hosting many small worlds on one backend.** A vault is a complete,
isolated tenant — separate Redis keyspace, separate graph, its own credential —
so one deployment can serve a few thousand of them. This is a recent capability
rather than an original goal, and it is the reason the sync tier's engineering
is proportionate rather than excessive: the materializer multiplexes 64 vault
streams per blocking connection and shards across leased workers, Neo4j label
cardinality is bounded regardless of how many schemas tenants define, Redis
enforces per-vault storage and write limits atomically, and an operator-only
endpoint plus a structured per-vault log make those limits visible before a
tenant has to complain. The 200-vault harness
measures 4 blocking connections where the old design would have held 200, with
materialization lag at p99 177 ms.

Read the boundary carefully: this is **many separate single-user worlds, not
teams**. Everything under "Multi-user work" below still holds inside any one
vault. What changed is how many vaults one operator can carry, not what a vault
is.

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
is held in memory with a hard 4 MB cap (`RUNTIME_LIMITS.storedBytes`).
Persistence is incremental per touched record, but startup still loads every
record and subscriptions still scan the full store. Realistic ceiling: hundreds
to low thousands of small records. It degrades on the UX and performance axes
at the same time.

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

**Long-term maintenance is still early.** Coverage is real but uneven: 52
browser regressions plus an offline cold-start, and 32 server tests, all in CI.
The browser suites cover persistence and bootstrap, reader data blocks, schema
and property editing, tab management, nested blocks, widget management, cleanup
cascades, sync recovery, discarded-write and quota warnings, rate-limit retry,
pairing in all its forms, and offline startup. The server suites cover patch
algebra, the Redis conflict path, snapshot recovery, tombstone purging, stream
multiplexing and sharding, label bounding, quota atomicity, pairing codes and
operator statistics, against live Redis and Neo4j. Two standalone harnesses sit
outside the suites: a full-stack browser-to-Neo4j-to-browser smoke test and a
200-vault multi-tenant measurement.

That is meaningful workflow coverage, not a comprehensive unit or visual test
matrix — there is no component-level or visual-regression testing at all, and
the multi-hour endurance run remains outstanding.

## The additions that would cost it its identity

[`roadmap.md`](roadmap.md) already refuses most of these; this is why, ranked by
how reasonable the ask sounds against how much damage it does.

- **"Just raise the ceiling."** IndexedDB, windowed subscriptions, a search
  index, grouping and aggregation. Each is individually defensible; together
  they turn a tool that is excellent at 300 records into a mediocre one at
  50,000, and the block builder becomes the bottleneck long before the storage
  does. The 4 MB cap is not a limitation awaiting removal — it is what keeps
  startup, subscriptions and the sync payload simple at the same time.
- **"Make it work for my team."** The most likely ask and the most expensive
  one. The all-or-nothing vault token is why the server fits in ~1,300 lines
  and why the trust model fits in one sentence. Authorization would have to
  reach every patch in `applyBatch.lua`, and that is a different project.
- **Formulas, scripting, plugins.** Nobody has asked yet. This is how every
  tool in this category becomes generic, and the one path that would turn a
  five-type metadata model into a language runtime.
- **Files and images.** The deferral holds. If avatars or thumbnails turn out
  to be the real ask, the small-inline-image option (hard ~64 KB cap, downscale
  on selection, explicit refusal above it) is the only one that stays inside
  the identity; a blob endpoint breaks "no network surface at all," which is
  one of very few claims here that is literally true.
- **Joins, reverse lookups, rollups.** Asking for these is asking it to be a
  database product.

## Two earlier criticisms, and where they now stand

**The sync tier's ceremony-to-workload ratio — answered by changing the
workload, not the tier.** This document used to argue that Redis plus Neo4j
plus a materializer plus a stream-ticket exchange was disproportionate
operational surface for "one person's two or three devices, hundreds of small
records", and that the honest question was whether the personal use case wanted
a single process over SQLite. That criticism was contingent on which product
the tier serves, and the multi-tenant work inverted it: the same machinery now
carries many isolated tenants at once, which is a workload that genuinely
warrants sequencing, idempotency, sharded materialization, quota enforcement
and an operator's view of the fleet.

Two honest limits on that. The verified scale is **200 vaults**, measured in a
single pass by `pnpm test:multi-tenant`; the "few thousand" this document
claims above is an extrapolation from flat connection counts and sub-200 ms
lag, not a measurement. And the
multi-hour endurance run in [`roadmap.md`](roadmap.md) is still outstanding, so
nothing here rules out a slow leak. The criticism that remains is narrower:
running this for other people is a different posture from running it for
yourself, and the repository now supports two quite different deployments. Its
documents have to keep saying which one they mean.

**Reference labels — resolved.** A schema chooses the property used to
represent its records, with an automatic fallback for existing data. Sorting,
reader search, export and print resolve that label directly from the
already-resident store rather than opening more subscriptions or changing the
stable ids. Export retains both forms. This closed the clearest reader-facing
papercut without adding joins, reverse relationships or another identity
system.

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
- A vault credential is one `LG1-…` string rather than two fields: Crockford
  base32 with no ambiguous characters and a check symbol, so a typo is refused
  locally instead of returning an unexplained 401. It can be scanned as a QR
  where the browser allows a camera, and a device that is not to hand can be
  given a ten-minute, single-use, rate-limited `PAIR-…` code so the durable
  credential is never read aloud. There is exactly one credential format; the
  vault id and token are never shown separately.
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

A personal, privacy-by-construction tracker for small self-defined datasets
whose shape keeps changing — and a well-documented specimen of how to build
one. The application layer stays deliberately small while covering references,
configured filtering and sorting, reader search and pagination, per-block
export and print, undo, and portable backups. The sync architecture remains
more mature than the application layer, but it is no longer out of proportion
to it: the same tier now also serves multi-tenant hosting, which is a second
deployment shape rather than a second product.

The list of things it will not do — team use, complex relational workflows,
meaningful volume, sensitive information once synced — is a list of decisions
rather than a list of deficits. Every entry on it is what buys the six things
above. It is already at roughly the right size, and the main risk to it is
incremental reasonableness: a sequence of individually defensible additions
that ends with a worse version of a product other people already ship.

The high-leverage gaps this document originally identified — export/import,
data-block filter and sort, reference fields, end-user search and pagination,
date/time fields, URL/email/long-text controls, undo, visible discarded writes,
non-destructive cursor recovery, an offline shell, and builder regression
coverage — are all implemented. File and image fields remain intentionally
absent pending a storage design that keeps binary data out of the 4 MB JSON
path. The remaining plan is [`roadmap.md`](roadmap.md).
