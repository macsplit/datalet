# Roadmap

**Status: current.** What is left, what was deliberately deferred, and what is
out of scope on purpose. Replaces `product-gaps-plan.md`, which had become a
long list of finished work; that work is summarised in one table below and the
detail lives in [`build-history.md`](build-history.md).

The gaps this responded to were identified in
[`product-assessment.md`](product-assessment.md), which is kept accurate as
work lands.

---

## Open

Nothing outstanding right now. See "Under consideration" and "Deferred by
decision" below for what's intentionally not being worked on yet.

---

## Under consideration, not decided

### A desktop shell, and what the app already is

Recorded so the question is not re-derived from scratch.

**It is already a PWA.** `public/manifest.webmanifest` is complete — name,
scope, `display: standalone`, both maskable icons — and the service worker
registered in `src/index.tsx` gives the offline cold start the offline suite
verifies. Served over HTTPS, Chrome offers to install it today. Nothing to
build.

The two things that would make an installed app better are **both now done** —
see Delivered: the storage-persistence request, and a `theme_color` that
follows the stored palette per scheme.

**Electron or Tauri is a much larger step**, and only one piece of it is real
work. The renderer uses no Node APIs at all, so it can run with
`contextIsolation: true`, `nodeIntegration: false` and no preload bridge. The
shape would be:

- Serve from a custom scheme (`app://`, registered `standard`+`secure`), not
  `loadFile()`. Under `file://` the service worker cannot register at all,
  storage partitioning is fragile, `connect-src 'self'` stops meaning anything,
  and the absolute `/assets/…` paths Vite emits (no `base` is set) break. The
  protocol handler is a port of `staticServer.ts`, SPA fallback included.
- Skip the service worker in that build; an app served from disk does not need
  an offline shell.
- **The one substantive change: a configurable sync origin.** Every call is
  root-relative — `fetch("/sync/…")` throughout `remoteSyncEngine.ts` and
  `SyncSettings.tsx`, and `new EventSource("/sync/stream…")` — and there is no
  server at `app://`. CORS is already handled and the stream-ticket design
  already exists because `EventSource` cannot set headers, so cross-origin SSE
  works unchanged. This invalidates the same-origin assumption documented in
  `remote-sync-architecture.md` §9 and
  [`remote-sync-deployment.md`](remote-sync-deployment.md), and widens
  `connect-src` beyond `'self'`.

**The caveats that should decide it.** A desktop shell removes the
clear-browsing-data hazard and puts records in OS backups — a genuine gain for
the "data that should not be in anyone's SaaS" use case. Against that: it costs
the "open a URL, nothing to install" property, adds a signing and update
pipeline to a project whose value is partly its smallness, and fixes none of
the ceiling — the 4.5-million-character cap and the full-store startup load are
decisions, and lifting them because a desktop shell makes it easy is exactly the creep
[`product-assessment.md`](product-assessment.md) warns about. If it is ever
built, **Tauri deserves weighing over Electron**: the renderer needs nothing
from Node, so the same custom-protocol model applies at a tenth of the size.

Note that the storage-persistence work already delivers most of the durability
benefit without any of this, which is the main reason a native shell is not
urgent.

## Deferred by decision

### File and image fields

**Decided 2026-08-14: deferred until a storage design exists.** Not "not yet
got to" — deliberately not built.

File and image values collide head-on with the architecture: the whole store
lives in memory under a 4.5-million-character cap, and every patch value
crosses the sync path as JSON. One photograph exhausts an entire vault.

Three options were weighed:

1. **Defer** until an IndexedDB or blob-endpoint design exists that defines
   quotas, offline behaviour, sync, retention and orphan cleanup. **Selected** —
   consistent with the earlier explicit rejection of an IndexedDB migration.
2. **Small inline images only** — a hard per-value limit around 64 KB, base64
   data URI, client-side downscale on selection, explicit refusal above the
   limit. Ships inside the current architecture and is genuinely useful for
   avatars, icons and thumbnails; useless for documents or photographs, and the
   UI would have to say so rather than let users discover it at the cap.
3. **Blob storage in the sync tier** — an upload endpoint with retention,
   orphan tombstones and quotas. The largest scope, and it breaks the unpaired
   product's "no network surface at all" property, which is one of the few
   things this project can claim honestly.

Revisit option 2 if avatars or thumbnails become the actual ask; revisit option
3 only alongside a decision to change what local-only mode means.

---

## Out of scope, on purpose

None of these can be fixed without changing what the product is. They are
listed so they are not mistaken for oversights.

- **Multi-user accounts, roles, per-record ownership, audit trail, selective
  sharing.** A vault token is all-or-nothing by design.
- **End-to-end encryption, or encryption at rest** in the sync tier.
- **Synchronous durability.** The ~1 s Redis AOF `everysec` crash window stays.
- **IndexedDB or windowed subscriptions.** Considered and rejected in an
  earlier tranche. The 4.5-million-character cap and the full-store startup
  load remain, and everything built since has been sized to live under them.
- **Font choice, of any kind.** The system stack is the answer: it renders
  readable text in the typeface the device is designed around, at no bundle
  cost and with no network surface. Vendored fonts were planned and then
  declined — this is an opinionated tool, and typeface selection is the start
  of a typography surface with no end and no reason to compete on. Webfont URLs
  in the graph are separately refused, because import is a supported path and a
  stored URL would make importing a backup fetch from a third party;
  `font-src 'self'` enforces that in the browser. Font bytes in the graph fall
  under the file-and-image deferral above.
- **Joins, reverse lookups, rollups, relationship constraints, cascading
  record behaviour.** References stay one-directional. They now *display* as
  the target's label everywhere rather than as a raw id, but that is a lookup
  of one record by its own id, not a relational feature: nothing traverses the
  reverse direction, aggregates across it, or constrains it.
- **The upstream `@ng-org/orm` subscription-lifecycle race.** Worked around in
  `graph_orm_update`; not fixable here without forking the dependency.

---

## Delivered

### "Ask to keep data" reads as a real answer on mobile

Worked as designed on desktop Firefox, appeared to do nothing on iPadOS and
Android. Not a request-logic bug - a decline (common on mobile, where the
browser grants or refuses silently rather than prompting) left the UI in
exactly the state it was already in, so a real answer looked like no
answer. Fixed with a `justDeclined` flag that gives a decline its own
message and relabels the button to "Ask again." Full write-up, including the
copy-wording correction: [`build-history.md`](build-history.md#recent-product-quality-fixes).

### Pairing/copy/invite QR codes: link-based, not a bare secret

The permanent pairing code's QR decoded to plain text - full, forever
access to the vault - which at least some Android camera apps paste
straight into a search box. Decision: never QR the permanent code
(copy/paste-only); the temporary PAIR and COPY codes, both already
revocable, become the scan-to-add-device path instead, QR'd as the same
invite link "Copy as Link" already produces. Full write-up:
[`build-history.md`](build-history.md#recent-product-quality-fixes).

### Multi-hour endurance run: real results, resource behaviour holds

The re-scoped question - memory, handle counts and materialization lag
under sustained multi-tenant load - now has a real answer. `./endurance-run.sh`
ran for its full requested 2 hours: 249 real browser-driven tenants, 65,947
real actions, zero invariant breaches, final reconciliation matched all live
tenants against the server exactly. One honest caveat (a burst of retried
click timeouts traced to the load generator sharing CPU with the system
under test on that one box, not a server defect) is in the full write-up:
[`build-history.md`](build-history.md#recent-product-quality-fixes). Closed
as answered, not as perfect - a longer run on hardware matching what's
actually deployed remains available any time the question needs re-asking.

### Backup export integrity

Every export now carries a top-level SHA-256 hash over its own content, an
export timestamp, and the source host it was made from. A hand-edited or
hash-less file is refused outright on import, with no legacy format
accepted. Full write-up: [`build-history.md`](build-history.md#recent-product-quality-fixes).

### First-time COPY links skip the confirmation step

A COPY invite opened by a browser that has never used the app before now
proceeds directly to the clone - no context for the confirmation, nothing
established for it to protect. A PAIR code always keeps its confirmation,
since joining a synced vault is a bigger commitment. Full write-up:
[`build-history.md`](build-history.md#recent-product-quality-fixes).

### Offline removal of an archived datalet no longer hangs

The `DELETE /sync/vaults` request had no timeout, so an unreachable-but-not-quite-offline
connection could hang indefinitely with the archived entry stuck mid-erase.
Now times out at 15s and accepts a real cancel. Full write-up:
[`build-history.md`](build-history.md#recent-product-quality-fixes).

### User-story browser journeys J1–J5

[`user-story-tests.md`](user-story-tests.md) is fully implemented - five
deterministic journeys covering adopting/evolving a tracker, two-device
live/offline convergence, source/copy independence, and a three-datalet
lifecycle. Found five real product defects along the way. Full write-up:
[`build-history.md`](build-history.md#user-story-browser-tests-j1-j5).

### The server suite ran itself into the ground

`pnpm test:server` intermittently stalled partway through, and a full run took
minutes. `materializerSharding.test.ts` passed 4/4 alone against identical
Redis state, which pointed at contention rather than a broken test.

The cause was Node's test runner defaulting to one worker per CPU — sixteen
here — for a suite of integration tests that all share **one Redis keyspace and
one Neo4j database**. `vaults:index`, the shard leases and the per-IP rate-limit
counters are global, so concurrent files were mutating each other's world.

Running with `--test-concurrency=1` is both correct and faster: three
consecutive runs took 18s, 15s and 15s, all 68 passing, against minutes and
occasional stalls before. Parallelism was buying nothing, because the shared
backend serialised the work anyway — through lease TTLs and blocking reads
rather than through the scheduler.


### Durable local storage and a live window colour

`navigator.storage.persist()` is now offered, and the result reported honestly:
the backup panel says whether this browser has agreed to keep the data, and a
refusal is shown as a refusal rather than as success. The request is
deliberately not made on load — Chrome decides silently, but Firefox raises a
permission prompt, and an unprompted prompt on first paint is worse than the
problem. It is offered where losing data is already the subject.

The installed window chrome now follows the theme too. `index.html` still ships
a static `theme-color` so an installed app has a colour before any script runs;
two media-qualified tags are inserted ahead of it, mirroring the stylesheet's
own light/dark split, and carry the accent role so an unthemed app looks
exactly as it did.


### Theme in the graph

[`theme-in-graph-plan.md`](theme-in-graph-plan.md) moved the visual theme into
the graph, so the last hardcoded part of the app definition became a record
like everything else. Sixteen colour roles, each with a light and a dark value,
as optional fields on the Settings record — so an unthemed graph is unchanged,
and a theme syncs, backs up and undoes like any other edit. Applying it
generates a stylesheet with a real `prefers-color-scheme` media query rather
than inline custom properties, which would have collapsed both palettes into
whichever was written last.

It also landed the project's first Content Security Policy, which was worth
having on its own merits.


### More than one datalet


[`multiple-datalets-plan.md`](multiple-datalets-plan.md) planned and delivered
holding several datalets and using one at a time, in the shape of Joplin's profiles. It adds no
capability to a datalet — nothing new can be modelled, stored or rendered — and
the engine is already multi-graph, so it is largely exposing what exists.

It turns on a measured constraint: Chromium refuses localStorage past ~5.2
million characters for an origin, against a 4.5 million budget for one datalet. Several
resident at once would make the same action succeed or fail depending on sizes,
so only the active datalet is resident, and the rest must be recoverable from
their vaults. **Holding more than one therefore requires pairing** — local-only
use stays exactly as it is, with one datalet and no network.

Datalets are built: the registry, the switcher with its restore-before-evict
rules, adding one, and copy codes with revocation. The flow and cloning were
planned together in
[`datalet-add-and-clone-plan.md`](datalet-add-and-clone-plan.md) — they share a
destination, since every way of gaining a datalet ends in a vault that is
paired, added and switched to.

A clone is the **whole** graph, given by a code that redeems into a copy rather
than into access. Joining and cloning are opposites and are named as such: join
is the same datalet in a second place, clone is a new datalet that began as a
copy. Publishing a code hands over every record in that datalet to anyone
holding it, the server can read all of it, and revoking stops future copies but
not copies already taken — three facts to be stated rather than softened.

### A deployable stack

The deployment guide described a Compose stack that existed only as fenced
snippets, so deploying meant transcribing it. [`deploy/`](../deploy) now holds
the real thing — Dockerfile, Compose stack, env template and `up.sh`, which
waits for `/sync/health` rather than reporting success the moment containers
exist. Built and exercised end to end on the target machine: vault creation,
write, materialization and snapshot round trip.

Its limits are measured rather than guessed. Neo4j is 833 MiB resident while
idle for a 512m heap and 256m page cache, because JVM metaspace and thread
stacks live above both; the whole stack is about 910 MB, of which the two Node
processes are 62 MB.

TLS is terminated in front, by a tunnel or reverse proxy, which also keeps the
app same-origin with `/sync/*` as the CSP requires.

### Multi-tenancy and identity tracks

[`multi-tenancy-and-identity-plan.md`](multi-tenancy-and-identity-plan.md)
planned two pieces of work identified after this roadmap was written. Both are
now complete; the plan keeps the per-item detail and the deviations from it:

- **Multi-tenant hosting** — carrying thousands of separate vaults on one
  backend deployment. This is *not* the multi-user work listed as out of scope
  above: a vault stays all-or-nothing and single-world, and the vault-token
  scheme is unchanged. A1 through A7 are complete: the materializer multiplexes
  64 vault streams per blocking connection, deterministically shards vaults
  across leased worker indexes, and keeps Neo4j record labels bounded across
  user schemas, while Redis atomically enforces per-vault storage and write
  limits, authenticated lifecycle deletion cleans both stores, idle vaults are
  reported without automatic reclamation, and per-vault numbers are served to
  an operator-only endpoint and emitted as structured logs.
- **User-facing identity** — resolving `did:ng:` ids to labels in the four
  places they leak (reference sort, reader search, export, print), and
  replacing the two-field pairing credential with one checksummed string plus
  QR and short-lived pairing codes. **Track B is complete:** labels cover all
  four reader surfaces, durable and one-use pairing flows are implemented,
  and user tabs use readable derived URLs while permanent raw-id bookmarks
  continue to resolve.

The endurance run under **Open** should now be re-scoped to multi-tenant:
`pnpm test:multi-tenant` already measures connection count, per-vault
accepted-versus-materialized equality and lag percentiles across 200 vaults in
one pass, and a multi-hour version of that answers the original memory-leak
question at the same time.


| Area | What landed |
| --- | --- |
| Reader tools | Per-block search across displayed fields, pagination, configured filter and sort |
| Field types | Date and date-time, URL, email, long text, record references, enum, currency display |
| Data utilities | Per-block JSON export and black-and-white print; whole-graph backup export/import |
| Offline | Web manifest and service worker; cold start offline after one online load |
| Sync UX | Visible warning for discarded writes with count and reason; in-place stale-cursor recovery with no reload; debounced connection-lost banner |
| Editing | Bounded local undo stack, one entry per editing gesture, `Ctrl/Cmd+Z` |
| Interface | Icon controls for the fixed navigation destinations, undo and banner reload |
| Persistence | Incremental per-record `localStorage` writes with a verified migration |
| Coverage | Playwright suites for persistence, bootstrap, data blocks, builders, sync recovery and offline; Node suites for patch algebra and live Redis/Neo4j; both in CI |
| Sync tier | Everything in [`build-history.md`](build-history.md) |

---

## Verification

Any change should end green on all of these:

```bash
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec tsc --noEmit -p server/tsconfig.json
pnpm build
pnpm build:server
pnpm test:client
pnpm test:server
```

Changing `src/shapes/shex/metaShapes.shex` additionally requires re-running
`pnpm build:orm` and committing the regenerated `src/shapes/orm/*`.

Before signing off a tranche, also exercise the real sync path with Redis and
Neo4j running: start `./run.sh`, then run `pnpm test:smoke:sync` in another
terminal, then stop the stack with Ctrl-C rather than killing its children (see
the README's note on orphaned servers). The smoke must traverse two browser
contexts, Redis, the materializer and a Neo4j-backed snapshot, and must clean up
its temporary vault.

The real two-device user story is `pnpm test:smoke:user-story-sync`. It starts
its own materializer by default; when `./run.sh` already supplies one, set
`SMOKE_EXTERNAL_MATERIALIZER=1`.

`pnpm test:server` loads `.env.local` itself, so integration tests run rather
than skip. Check the `# skipped` count anyway: a skip reports as `ok … # SKIP`,
so a suite that reaches neither Redis nor Neo4j still exits green.

Update [`product-assessment.md`](product-assessment.md) as each piece lands.
Its value is that it stays accurate about what is missing.
