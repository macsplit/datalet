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

### "Ask to keep data" reads as a real answer on mobile, not as doing nothing

Reported from real use: on desktop Firefox, asking the browser to keep this
origin's storage worked as designed - the button disappeared and a message
confirmed the grant. On iPadOS and Android, the button appeared to do
nothing: no visible change at all.

Not a bug in the request itself. Unlike Firefox, which raises an explicit
prompt, Chrome and Safari (especially on mobile) grant or decline
`navigator.storage.persist()` silently from engagement/installed-state
heuristics - a genuine, spec-compliant refusal, most likely on a site with
low engagement, which a first real-world report on mobile is. The gap was in
the UI: a decline left `persistence` at `"not-persisted"`, exactly the state
it was already in before anyone clicked anything, so the same button and the
same sentence redrew - a real answer with nowhere to be seen.

Fixed with a new `justDeclined` flag, set only by an explicit ask (never by
the read-only check on mount), distinguishing "never asked" from "asked and
refused just now": a specific message explaining that some browsers decline
this quietly and suggesting trying again after more use, and the button
relabels to "Ask again." The existing, deliberate decision to say nothing at
all when the API is unsupported (`tests/storage-persistence.spec.ts`,
"a browser without the API is not nagged about it" - showing a warning
nobody can act on would be worse than silence) is untouched.

One new test (`tests/storage-persistence.spec.ts`) confirms a decline now
reads as a real answer; confirmed to fail against the pre-fix component and
pass against the fix.

### Pairing/copy/invite QR codes: link-based, not a bare secret

Reported from real use: the permanent pairing code's QR - full, unrevoked
read/write access to the vault, forever - decodes to plain text, not a link.
Scanned with a phone's own camera app (not this app's in-app scanner), at
least some Android camera apps paste that straight into a Google search box:
a dead end for the person trying to add a device, and a genuinely bad place
for that specific secret to sit even briefly.

**Decision: never QR the permanent pairing code.** It stays copy/paste-only,
for the "both devices already in front of me" case. The temporary PAIR code
and the COPY code - both already revocable/expiring/single-use in ways the
permanent code isn't - are the intended scan-to-add-device path instead, and
their QR now encodes the same `https://.../join?token=...` invite link
"Copy as Link" already produced (`createInviteLink`, moved from `CloneCodes`
into `codeRedemption.ts` so `SyncSettings`'s temporary code could reuse it
rather than duplicate it). Every phone's own camera app already knows what
to do with a link QR - open it - which lands directly on the existing,
already-tested `JoinPage.tsx` flow. No new redemption path was built.

`src/utils/qrCode.ts`'s hand-rolled encoder only supported QR "alphanumeric"
mode (this app's own codes fit it, but lowercase, `?`, `=`, `/` don't), so it
gained "byte" mode (`encodeLinkQr`) alongside the existing one
(`encodePairingQr`, unchanged, still used only for the permanent code's own
manual-entry round trip - not rendered as a QR by anything anymore). Both
share the existing Reed-Solomon/matrix/masking machinery; only the header
and payload-bit construction differ. Verified against a real, independent
QR decoder (`jsqr`, installed only for this one-off check, not a project
dependency) rather than merely confirmed not to throw - the existing test
suite had never actually decoded a rendered QR's pixels before. A
too-long-to-fit URL throws cleanly rather than truncating into a link that
would silently resolve to the wrong place; callers already treat a QR as
optional and fall back to the plain link.

New `LinkQr` component (`src/components/LinkQr.tsx`) renders an invite-link
QR; the SVG-drawing logic it shares with the existing `PairingQr` was
factored into `QrImage` (`src/components/QrImage.tsx`). `CloneCodes.tsx`
gained a per-code "Show QR" toggle next to its existing Copy/Copy as
Link/Revoke buttons; `SyncSettings.tsx`'s temporary-code section gained
both "Copy as Link" and "Show QR" (previously text-and-Copy only), sharing
one lazily-minted link between the two rather than minting a fresh one per
click. `PairingScanner` (in-app camera-based code entry) is untouched and
still available on the joining side for manual paste/scan.

One existing test asserted the old behaviour (a QR appearing after "Show"
on the permanent code) and was updated to assert its absence instead. A new
regression test (`tests/no-overflow.spec.ts`) covers both newly-widened
rows - CloneCodes' row grew a fifth button, the temporary code's row grew
from two to four - at both viewport widths, and was confirmed to actually
fail if `.layout-row`'s `flex-wrap` were ever removed again (the same class
of bug that prompted this file's existing tests).

### Multi-hour endurance run: real results, resource behaviour holds

The re-scoped question - memory, handle counts and materialization lag under
sustained multi-tenant load, aborting early on an invariant breach rather than
dutifully running to completion - now has a real answer, not just tooling.
`./endurance-run.sh` was run for its full requested 2 hours: 249 real
browser-driven tenants (192 held concurrently at steady state, the rest via
periodic churn), 65,947 real UI actions (add/edit/occasional delete, clicked
through the real app), against a real sync-server and materializer on real
Redis and Neo4j.

**Correctness held completely.** No `crash.json` - the run finished with exit
code 0, meaning no invariant was ever breached. The final reconciliation
matched all 192 live tenants' local record counts exactly against the
server's materialized state (192/192), every one of the 8 periodic
reconciliation checkpoints during the run was equally clean, and
`materializerLag`/`materializerPending` were `0` for every vault at shutdown.
Zero uncaught client-side errors, zero page crashes.

**Resource trends, from `metrics.json`'s 76 samples:** materializer RSS rose
from ~89 MB to ~116 MB and then visibly plateaued from about the 87-minute
mark on - the strongest evidence in this run that there's no slow leak.
Sync-server RSS rose gently, ~92 MB to ~127 MB, without having fully
flattened by the 2-hour mark - not alarming on its own, but a longer run
would be needed to call that fully settled with confidence. Open file
descriptors for both processes stayed in a tight, flat band the entire run,
then dropped to near-zero the instant all 249 contexts closed at
shutdown - no fd leak. Redis memory climbed steadily and roughly linearly,
13.6 MB to 136 MB, tracking real data genuinely being created (the action mix
favors creates over deletes) rather than anything resembling a leak; even the
largest single vault stayed a small fraction of its 8 MiB quota.

**One honest caveat, not a product defect.** 2,780 of the run's action
attempts (about 4%) hit a non-fatal 30-second click timeout and were retried
on the tenant's next tick - every one eventually succeeded, which is why
correctness still came out perfect. Nearly all of them (2,775) started right
around the 45-minute mark, exactly when initial tenant creation finished and
full ~192-tenant concurrency began, and stayed roughly flat through the load
phase rather than climbing further - essentially absent during the
low-concurrency ramp-up. That points at this run's own load generator (200
real Chromium contexts) sharing the same 16-core box's CPU with the sync-server,
materializer, Redis and Neo4j it was testing, not at a server-side problem. A
future run from a separate machine than the one under test would isolate "does
the product hold up" from "can this one box also drive 200 browsers at once."

This item is closed as answered, not as perfect - a longer run, on hardware
matching what's actually deployed, remains available to run again with
`./endurance-run.sh` any time the question needs re-asking (e.g. after a
change to the sync/materializer hot path).

### Backup export integrity

Every export now carries a top-level SHA-256 hash over its own content, so a
hand-edited backup is detectable on import and explicitly refused rather than
silently accepted as a genuine export. Two more metadata fields ride alongside
it: `exportedAt` (already existed, always UTC ISO 8601 via `toISOString()`)
and a new `sourceHost` (`location.host`, e.g. `datalet.app`) recording where
the export was made - useful context if a self-hosted deploy at a different
origin is ever in the picture, though nothing trusts or enforces it; a
different host is exactly as legitimate an export as the canonical one.

The format stayed at version 1 (`format: "localgraph-backup", version: 1`) -
no bump, and deliberately no backward compatibility for a pre-hash shape:
there were no real backups in the wild predating this, so a hash-less file is
refused outright rather than accepted as an unverified legacy format. The
hash is computed with the Web Crypto API (`crypto.subtle.digest`) over
`JSON.stringify` of the payload minus the `hash` field itself, in the exact
key order the exporter writes it in; a mismatch on import is refused outright
with a specific "may have been edited or corrupted" error, and a file missing
`hash` entirely is refused the same way rather than treated as
unverified-but-fine.

Both `exportGraphBackup` and `importGraphBackup` (`src/utils/localNgEngine.ts`)
became async to allow the digest call. A new synchronous `graphRecords(graph)`
was split out for the one internal, non-file caller
(`moveRecordsBetweenGraphs` in `remoteSyncEngine.ts`, used when pairing moves
records between graphs) so that path isn't paying for a hash nobody reads.

Five new tests in `tests/backup-integrity.spec.ts`, exercising the real
export/import UI rather than the functions directly: an export's hash,
timestamp and source host are well-formed; a genuine untouched export
re-imports cleanly; a hand-edited export is rejected and the original record
survives; an export missing its hash is refused; and a hand-crafted backup
claiming the old hash-less shape is refused rather than trusted unverified.
All were confirmed to fail against the pre-fix code, and the last was also
confirmed to fail against an intermediate version that *did* keep a hash-less
fallback, proving the test actually pins the "no legacy format" decision and
not just "hashes get checked."

Every hand-crafted `version: 1` fixture elsewhere in the suite
(`tests/security-import.spec.ts`, `tests/user-stories.spec.ts`) had to gain a
correctly-computed hash to keep exercising what it was actually testing,
rather than being rejected before it ever reached that code path.

### First-time COPY links skip the confirmation step

For a valid COPY invite opened in a browser that has genuinely never used the
app before, the clone now proceeds directly instead of showing the normal
yes/no confirmation - someone receiving their first Datalet link had no
existing context for that dialog, and there was no established datalet choice
for it to protect. The confirmation is unchanged for an existing user who has
visited or initialized the app at any time in the past, and always kept for a
PAIR code regardless, since joining a synced vault is a bigger commitment than
a COPY's separate, disposable clone. Invalid, expired and reused links still
stop with their existing explicit errors, unaffected.

The durable "has ever used this app" signal is `hadPriorSession`
(`src/utils/ngSession.ts`): whether this browser's local session already
existed before the current page load, captured at the moment `init()` reads
or creates it. Nothing in the app ever removes that key - unpairing,
forgetting a datalet, archiving, and deleting every record all leave it
untouched - so unlike checking whether the current datalet is empty or
paired, it cannot be reset by ordinary use. `JoinPage.tsx` auto-confirms once,
guarded by a ref, only when the code is COPY, `hadPriorSession` is false, and
the existing data-loss guard (`canLeaveActiveDatalet`) already says yes; any
failure past that point (a late server error, a guard refusal) still lands on
the normal error screen; nothing is skipped automatically.

Four new tests in `tests/join.spec.ts` cover: a first-time COPY link reaching
the joined vault with no click; a first-time COPY link's late failure still
surfacing without any click; a PAIR link always keeping its confirmation even
for a first-time browser; and a browser that has merely visited before (no
datalet ever adopted) still seeing the COPY confirmation. All four were
confirmed to fail against the pre-fix code before the fix landed.

### Offline removal of an archived datalet no longer hangs

Reported from real use: while the app was offline, attempting to remove an
archived vault permanently left a contentless screen pending indefinitely,
because the `DELETE /sync/vaults` request had no timeout at all. Fixed:
`removeDataletPermanently` now times out at 15s (matching the app's existing
`SYNC_DOWN_WARNING_DELAY_MS` judgment) and accepts an external `AbortSignal`;
`DataletSettings`'s "Cancel" button aborts a pending erase immediately instead
of being disabled while one is in flight. Every failure path — timeout,
cancel, or a genuine connection error — shows a retryable message and never
calls `forgetDatalet`, so the archived entry and its vault credentials are
untouched and the app remains fully usable throughout. Two new tests in
`tests/datalets.spec.ts` cover the hang-then-timeout case and the
cancel-returns-control-immediately case; both were confirmed to fail against
the pre-fix code before the fix landed.

### User-story browser journeys J1–J5

[`user-story-tests.md`](user-story-tests.md) is fully implemented. The journeys
cover adopting and maintaining an established tracker; building and evolving a
moderate tracker; two-device live/offline convergence against the real stack;
source/copy independence after sharing; and three distinct datalets through
repeated switches, archive/restore and durable backup recovery.

The composed journeys found five product defects that focused tests had missed:
an editor unmounted when its sort value moved pages; an in-flight sync
acknowledgement erased a newer queued edit; the Redis historical-to-live SSE
handoff could skip a patch; remote patches did not invalidate mounted React
consumers; and backup import into a synced datalet was only local, so reopening
silently undid the apparent recovery. Each is fixed in repo-owned code. No
vendored dependency code was changed.

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
