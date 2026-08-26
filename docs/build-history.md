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
| 22 | Datalets: whole-origin storage accounting, per-datalet pairing, a switcher that restores before evicting, adding one, and copy codes that hand over a copy rather than access. |
| 23 | Invite-token links: disposable single-use links wrapping a COPY or PAIR code, so a code never has to be shared as human-typable text. |
| 24 | Six real, user-reported defects found and fixed in the copy/join flow: a materializer-lag race, a silent client-side failure that swallowed errors, a storage-key mismatch (the actual root cause behind an "empty copy" report), an over-eager first-time-visitor guard, a partial-copy-at-scale retry bug, and a third-party ORM id-generation defect. |
| 25 | User-story browser tests J1-J5: full, realistic, multi-step journeys through the app (not isolated scenarios), which found five more real defects the existing suite had missed. |
| 26 | The `markdown` field type: a hand-rolled, dependency-free renderer, safe by construction. |
| 27 | Product-quality fixes from real use: offline archived-vault removal timing out cleanly, first-time COPY links skipping an unnecessary confirmation, a backup export integrity hash, a real multi-hour multi-tenant endurance run, link-based pairing/copy QR codes, and honest mobile storage-persistence messaging. |

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

---

## Invite-token links

A COPY or PAIR code can be wrapped in a disposable, single-use link instead of
sharing the human-typable code directly — the pattern Zoom uses for meeting
invites.

- **`server/src/pairCode.ts`**: code entropy doubled from 40 to 80 bits
  (`randomBytes(10)`, 16-character payload). COPY codes also gained a 30-day
  TTL (`COPY_CODE_TTL_SECONDS`) — previously durable/forever, too weak for a
  persistent secret at the old entropy.
- **`server/src/vaultStore.ts`**: `createInviteToken(codeType, code)` mints a
  single-use UUID token wrapping a code, 7-day TTL
  (`INVITE_TOKEN_TTL_SECONDS`). `redeemInviteToken(codeType, token)` redeems it
  via `GETDEL` (atomic, single-use by construction).
- **HTTP**: `POST /sync/invite-token` (mint) and `POST /sync/invite-redeem`
  (redeem) in `server/src/httpServer.ts`, rate-limited the same as pair/clone
  redemption.
- **Client**: `src/pages/JoinPage.tsx` at `/join?token=<uuid>` redeems the
  token (tries COPY then PAIR), shows a confirmation step, then genuinely
  completes the join/copy — the same `redeemDataletCode` + `adoptVaultAsDatalet`
  path the manual-paste field uses, not a copy-to-clipboard-and-redirect.
  `src/utils/codeRedemption.ts` holds the shared code-type-branching logic
  (`redeemDataletCode`), `extractInviteToken` (recognizes a pasted invite link
  or bare token), and `redeemInviteToken`, so the manual field and `/join`
  never judge a code or link differently. `CloneCodes.tsx` gained "Copy as
  Link" alongside "Copy" for each COPY code.
- Deliberately **not** wired up at first for PAIR's 10-minute temporary code —
  wrapping a 10-minute code in a 7-day link would look like a week-long invite
  that silently stops working after 10 minutes. Revisited later (see "Recent
  product-quality fixes" below): the temporary code's link is now minted
  lazily and shared between "Copy as Link" and "Show QR" rather than treated
  as a mismatch to avoid.
- **Design decisions**: token in a query param (`?token=`), not a URL fragment
  — a plain query param was judged acceptable given the token is single-use +
  7-day TTL, so a leaked link is worthless after one redemption or one week.
  7-day TTL chosen over 24h (too tight) or 30 days (too loose for a single
  link, even though the underlying code lives that long). Token type (COPY vs
  PAIR) is explicit in the API, not inferred, so a token can't be redeemed as
  the wrong kind.
- **Tests**: `server/test/inviteTokenHttp.test.ts` (full round trip against a
  real HTTP server + Redis — mint, redeem once, refuse a second redemption,
  refuse cross-type redemption, refuse a never-issued token, refuse a
  malformed code at mint time); `tests/join.spec.ts` and
  `tests/clone-codes.spec.ts` (COPY and PAIR links complete the join without a
  second manual paste, an expired/reused token shows a clear message, the same
  data-loss guard the manual field uses also blocks joining via a link).

A follow-up pass on this same feature found two real bugs: `JoinPage.tsx`'s
confirm screen computed `canLeaveActiveDatalet()` once at render instead of
polling it the way `DataletSettings.tsx` already did — the commonest refusal
(a queued outbox) clears itself moments later as changes sync, and a
one-shot check never noticed, leaving the confirm button disabled forever.
Fixed by polling the same way. Separately, a blind text-replace in an earlier
session (`"durable copy"` → `"valid for 30 days"`, meant only for the
COPY-code description) had also matched an unrelated sentence in the
permanent-erasure warning, leaving a broken sentence fragment shipped
silently for two sessions since no test asserted that exact text. Restored
via `git log -p`.

---

## Six real bugs in the copy/join flow

Found across several rounds of testing a real, live invite link end to end —
not through isolated Playwright scenarios, which structurally could not have
caught most of these. Reported starting point: taking a copy of a datalet via
an invite link, opening it in a different browser, accepting it — state never
updated, landed on Settings instead of Home, Home showed nothing.

**1. A materializer-lag race, server-side.** `/sync/snapshot` reads Neo4j, fed
asynchronously by `materializer.ts` from the same accepted writes that bump
Redis's `seq` immediately. A vault cloned moments ago can report `seq > 0`
before Neo4j has replayed it, and come back with zero records even though the
copy was genuinely accepted. Fixed: `dataletSwitch.ts`'s `fetchVaultSnapshotSettled`
retries with backoff specifically when `seq > 0` and `records` is empty — that
combination can't mean "genuinely empty," only "not there yet." `seq === 0` is
trusted immediately, since a real empty vault must not be delayed.

**2. A silent-failure bug in `JoinPage.tsx`**, worse than the race above and
probably what the user actually hit. `confirm()` moved the address bar to
`/settings/datalets` via `window.history.replaceState` before
`adoptVaultAsDatalet` had succeeded, to stop a reload from retrying an
already-consumed invite token. But `replaceState` is exactly what TanStack
Router's history listener reacts to — it unmounted `JoinPage` immediately, so
if adoption then threw for any reason, the error landed on an already-gone
component and `setStage({step:"error", ...})` was a silent no-op: no error, a
drop on Settings, nothing adopted. Fixed: `adopt()` now takes an optional
`beforeReload` callback, invoked only once every check has already passed,
immediately before its own `window.location.reload()` — the one point moving
the address bar is actually safe.

**3. `cloneVault` cleanup hardening.** Only cleaned up (`deleteVault`) on an
explicit `{accepted: false}` rejection from a chunk, not on the chunk loop
throwing for any other reason (a Redis error mid-clone). Not client-visible —
credentials are only returned after the whole loop succeeds — but a half-built
vault would sit orphaned in Redis forever. Now wrapped so any failure in the
loop triggers cleanup before rethrowing.

**4. The actual root cause of the "empty copy" report — a storage-key bug.**
Found *after* the three fixes above, by redeeming the user's real, live,
unused invite link directly against production and inspecting the raw JSON.
The snapshot came back non-empty immediately, no materializer lag at all —
but every record's storage key was still prefixed with the **source** vault's
graph id, while each record's own `@graph` *property* correctly pointed at
the new clone. `cloneVault` rewrites `@graph` but was never rewriting the
subject id itself, and subject ids are `${graph}|${localId}` compound
strings. Nothing cross-checks a record's key against its own `@graph` value,
so this was invisible server-side; the client reads records by the new
graph's key prefix and found none. This predates all three fixes above and is
unrelated to them — they are all real, correctly-fixed bugs in their own
right, just not this one. Fixed: `cloneVault` now rewrites the subject id's
graph prefix in step with `@graph`. The existing test's `seedVault()` fixture
used a bare id with no graph prefix at all, so the mismatch had no graph
segment to drift out of sync with — fixed to use the compound form every real
client actually uses.

Re-verifying against a freshly-wiped deployment surfaced one more real gap: a
source vault and its clone, created seconds apart, took ~6s for the clone's
records to appear — close to a full `VAULT_DISCOVERY_INTERVAL_MS` (3s) plus
replay time, past the original retry budget (5 tries, ~5s total). Widened to
`[200, 400, 800, 1600, 3000, 3000, 3000, 3000]` (~15s, 9 calls max) — fast
early retries for the common near-instant case, settling to 3s steps matching
the server's actual discovery cadence.

**5. Partial-copy at scale.** After the fixes above shipped, the user asked
whether there were now real (unmocked, real materializer, real browser) tests
for the join-link flow at scale — thousands of records, timing measured.
Building one (`server/test/copyLinkScaleSmoke.ts`, `pnpm test:smoke:copy-scale`)
found a bug the mocked tests structurally could not have caught:
`fetchVaultSnapshotSettled`'s retry loop stopped the moment `records` was
non-empty — correct for a small vault, wrong at scale, since materialization
is incremental, not atomic. A 2,000-record clone showed 25 records visible at
5s and the full 2,000 only ~11.5-17s later; a client that stops at
"non-empty" would silently adopt a datalet missing 99% of its records, with no
sign anything was wrong. Fixed: `/sync/snapshot` also returns
`materializerLag`/`materializerPending` (reusing the same consumer-group
backlog read the admin API already exposed); the client retries until both
are `0`, not until `records` merely has something in it. The retry budget
widened again, to ~27s (`[200, 400, 800, 1600, 3000×8]`) — real end-to-end
runs of a 2,000-record clone-and-join measured 13-19s, with real variance from
`VAULT_DISCOVERY_INTERVAL_MS`'s per-clone jitter on top of replay time.

**6. A third-party library's id generator, occasionally corrupting the id it
hands back.** Found via a live report ("Remote sync snapshot safety circuit
opened... records failed local validation") on a small (13-record) schema.
One `PropertyDef` record's `@id` had the vault's own graph embedded in it
**twice**, joined by a literal `|` (`did:ng:V|did:ng:V:q:R` instead of
`did:ng:V:q:R`) — already sitting in the source vault's own storage, not
introduced by cloning. Root cause, in `@ng-org/orm`
(`ormSubscriptionHandler.js`, `signalObjectPropGenerator`): when `.add()` is
called with `"@id": ""` (asking the library to auto-generate one), the
generator computes `subjectIri = (path[0] ?? graphIri).substring(0, 53) +
":q:" + random`, preferring an internal deep-signal watcher `path[0]` over the
`@graph` the caller explicitly passed — under a condition not fully pinned
down, that `path[0]` held a stale `graph|id`-shaped composite instead of being
empty. Third-party code, not something to patch here.

Fix, per explicit instruction ("bad records should be impossible" — prevent,
not tolerate; downstream leniency was proposed and rejected): stop ever
calling `.add()` with `"@id": ""`. New `generateSubjectId(graph)`
(`src/utils/randomId.ts`) generates the id in application code
(`${graph}:q:${randomUuid()}`, the same shape the ORM's own correct path
produces) and passes it explicitly, which takes the direct-use branch in the
library and never consults the buggy `path[0]`-based branch at all. Applied
to the two sites that relied on the auto-id path
(`usePropertyDefs.ts`, `BlockRenderer.tsx`'s `createRecord`).

Deliberately **not** fixed, per the same instruction: `validGraphSnapshot`'s
all-or-nothing rejection (one bad record fails the whole snapshot) stays as
is. A skip-the-bad-record-and-warn policy was proposed and explicitly turned
down in favor of prevention — an already-corrupted record permanently blocks
copying/joining its vault until manually deleted and recreated, and no
automatic repair path was wanted.

**A related, over-eager guard bug, found by testing the user's actual live
link twice more.** The user still couldn't accept a copy link on a fresh
Firefox private window — correctly, per the guard, but the guard itself had a
real gap. `ensureLocalDatalet()` creates a vault-less "this device" placeholder
the instant adoption is attempted at all, and `canLeaveActiveDatalet` then
refused because that placeholder has no vault. But `SettingsProvider` and
`MetaStoreContext.tsx` both write a default record into any active graph
within moments of rendering, unprompted (a Settings singleton and a Home tab)
— so a placeholder that looks "protected" almost always holds nothing a
person actually put there. The old check (`graphFootprint(graph) === 0`) lost
this race virtually every time: refuse forever, on every device, including
ones that never held a single real record. Fixed: `localNgEngine.ts`'s
`graphHasOnlyKnownBootstrapRecords(graph, knownIds)` looks past exactly those
two known, unprompted writes rather than at whether the graph is literally
empty.

**A QR-code bug in the same neighborhood, reported as "iPad-only."** The
"Show" button next to the permanent pairing code rendered a QR via
`encodePairingQr` with no try/catch, throwing uncaught into the router's
default error boundary. Root cause: `PAIRING_CODE_CHECK_ALPHABET` used five
extra checksum symbols including `~` and `=`, which are valid Crockford-adjacent
symbols but not valid QR "alphanumeric" characters — about 2/37 (~5.4%) of
vaults, confirmed empirically over 20,000 random vault-id/token pairs, could
never render a QR, on any device, forever. Not actually iPad-specific: the
checksum is stable per vault, so whichever device first showed it there would
always crash there. Fixed: the alphabet now uses `*%$+U` instead of `*~$=U`,
both QR-alphanumeric-safe, plus defense in depth (`PairingQr` now catches any
encoding failure locally). An already-issued code whose check symbol was
literally `~` or `=` no longer decodes after this fix — not addressed with a
migration path, since no vault an old code could reference still existed at
the time.

Every fix above was verified bidirectionally where the bug allowed it —
reverting the fix and confirming the exact reported symptom reproduces,
restoring it and confirming it's gone — and where it didn't (the ORM id bug's
underlying race can't be reliably re-triggered by reverting alone),
verification instead temporarily made the replacement function itself emit
the corrupted shape, to prove the new regression tests would actually catch a
recurrence.

---

## User-story browser tests (J1-J5)

A high-level testing specification (`docs/user-story-tests.md`), driven by a
direct request after this project's other bugs kept surfacing from real,
chained, multi-step usage that no isolated test scenario resembled: "a high
level test specification that is not driven by anti-regression edge cases
propping up the code, but is instead about creating real plausible user
stories of how they will use this datalets app." Five deterministic journeys,
three in `tests/user-stories.spec.ts` and two as real-stack smoke tests.

- **J1** imports a realistic 48-record reading log into a fresh browser,
  pages and searches it, edits scalar and markdown fields, adds and reloads a
  record, exports the searched result, takes a full backup, deletes the
  record and restores it.
- **J2** builds a Projects tracker entirely through the schema/block/reader
  UI, enters 24 projects, adds a field after data exists, changes filtering
  and sorting, edits the new field, reloads, and verifies backup recovery.
  Found a real bug: after the first page filled, typing the active sort
  property moved the record being edited to another page, unmounting the form
  mid-edit. Fixed by freezing the current result order while any record
  editor is open.
- **J3** (`server/test/multiDeviceUserStorySmoke.ts`) uses two isolated real
  Chromium contexts and a real one-use PAIR code: an online edit arrives live,
  different-field edits are made while one side is offline, both reconnect
  and must converge without reloading. Found three independent real bugs:
  `flushOutbox` acknowledged a completed request by saving its stale
  in-memory queue, silently erasing any edit enqueued while that request was
  in flight; the Redis SSE watcher's blocking command starting at `$` could
  skip a patch in a narrow race with its own gap-closer; a received remote
  patch updated localStorage but did not rerender the mounted ORM React
  consumer (bridged via a new `hooks/useShape.ts`).
- **J4** (`server/test/copyIndependenceUserStorySmoke.ts`) publishes a copy
  link from a real 64-record source and verifies edits on each side stay
  isolated in both UIs and both materialized Neo4j snapshots.
- **J5** builds three distinct datalets through the UI, switches between
  them repeatedly, archives/restores, backs up, damages and recovers one.
  Found a real bug: `importGraphBackup` replaced local storage but emitted no
  outbound patches, so the server snapshot silently undid the apparent
  recovery. Fixed: `replaceGraphAndReload` now emits the minimal graph diff
  through the durable outbox before reload.

No vendored dependency code was changed for any of these fixes.

---

## The markdown field type

A sibling of `longText` for longer notes with basic formatting — headings,
bold/italic, inline code, fenced code blocks, lists, blockquotes, links.

- **`src/utils/markdown.ts`**: `renderMarkdownToSafeHtml(source)`, hand-rolled
  rather than a dependency (`marked`/`markdown-it` etc. were considered and
  skipped — the app has near-zero runtime deps, and "safe by construction"
  was easier to verify in ~150 lines fully controlled here than to audit in
  someone else's parser config). Every tag in the output comes from this
  file's own template strings; the only interpolated values are text run
  through `escapeHtml` or a URL run through `safeWebUrl`
  (`src/utils/urlSafety.ts`, http(s)-only, everything else degrades to
  visible literal text).
- **No image support**, deliberately: an `<img>` fetches its `src` the
  instant the record renders, no click required — a tracking-pixel vector
  for a field that can hold someone else's synced or COPY-code data, and a
  broken icon offline. `![alt](url)` degrades to an ordinary link.
- **Length cap**: 50,000 characters, client-side only — a UX guard, not a
  security boundary; the real backstops (2MB per request, 8MB per vault,
  both server-side and pre-existing) already made an oversized paste
  impossible to lose data over.
- **A real bug the XSS test caught**: the bold/italic inline tokenizer
  originally matched `__[^_]+__` greedily with no word-boundary guard, so two
  unrelated `__dunder_identifiers__` anywhere in the same note would pair up
  as one bold span stretching between them — not an actual security hole
  (everything inside stays HTML-escaped either way), but wrong, and exactly
  the kind of content (logs, code, identifiers) this field will hold
  constantly. Fixed with `(?<!\w)`/`(?!\w)` boundary guards, matching
  CommonMark's real intraword-underscore rule.
- **Print view was a separate bug found right after landing this**:
  `BlockRenderer.tsx`'s print sheet has its own independent stringifier that
  never went through the new renderer, so a markdown field printed as literal
  `# Title` / `**bold**` source. Fixed by special-casing the markdown type at
  the print `<td>` render site.
- **Design decisions**: hand-rolled renderer over a dependency; no image
  rendering, links only (weighed explicitly against the tracking-pixel and
  offline-breakage risk); 50,000-character cap chosen from three options; no
  nested inline markup or full CommonMark-complete emphasis flanking — "basic
  format effects," not a full implementation.

---

## Recent product-quality fixes

Five real issues reported from actual use of the deployed app, each
independent of the others.

**Offline removal of an archived datalet.** Erasing an archived vault while
offline left a contentless screen pending indefinitely — the `DELETE
/sync/vaults` fetch had no timeout at all, so on a connection that looked
present but couldn't reach the server, it could hang for as long as the
browser's own TCP timeout, with no way back into the app. Fixed:
`removeDataletPermanently` (`src/utils/dataletRemoval.ts`) now races the
DELETE against a 15s timeout and an optional caller-supplied `AbortSignal`
(the first use of `AbortController` anywhere in `src/`); `DataletSettings`'s
"Cancel" button aborts a pending erase immediately instead of being disabled
while one is in flight. Every failure path leaves the archived entry and its
credentials untouched.

**First-time COPY links skip the confirmation step.** A COPY invite opened by
a browser that has never used the app before had no context for the yes/no
confirmation and nothing established for it to protect. Fixed:
`JoinPage.tsx` auto-confirms once when the code is COPY, the browser has
never had a session before (`hadPriorSession` in `src/utils/ngSession.ts` —
captured at session-creation time, never reset by unpairing, archiving, or
deleting records, unlike checking whether the current datalet is empty), and
the existing data-loss guard already says yes. A PAIR code never auto-skips,
since joining a synced vault is a bigger commitment than a COPY's disposable
clone.

**Backup export integrity.** Every export now carries a top-level SHA-256
hash over its own content (`crypto.subtle.digest` over the payload minus the
hash field, in the exporter's own key order), plus `sourceHost` recording
where it was made. `importGraphBackup` refuses a mismatch or a missing hash
outright — "may have been edited or corrupted" — with no legacy hash-less
format accepted, since there were no real backups predating this in the
wild. Verified against a real, independent QR-adjacent style check: the
tamper and missing-hash tests were confirmed to fail against the pre-fix
code, and one was also confirmed to fail against an intermediate version that
briefly kept a hash-less-still-imports fallback, proving the tests actually
pin "no legacy format."

**A real multi-hour, multi-tenant endurance run.** `./endurance-run.sh`
builds and starts a real sync-server and materializer as separate OS
processes against real Redis and Neo4j, then drives
`server/test/browserEndurance.ts` — real headless-Chromium tenants (not
synthetic HTTP), a fraction paired two-devices-to-one-vault, periodic tenant
churn — for a configured duration. Run for its full requested 2 hours: 249
real tenants, 65,947 real actions, zero invariant breaches, final
reconciliation matched all 192 live tenants' local record counts against the
server exactly. Materializer RSS plateaued partway through the run; a burst
of retried click timeouts starting exactly when full tenant concurrency began
traced to the load generator sharing CPU with the system under test on that
one box, not a server defect.

**Pairing/copy/invite QR codes: link-based, not a bare secret.** The
permanent pairing code's QR decoded to plain text — full, unrevoked,
forever access to the vault — and at least some Android camera apps paste
that straight into a Google search box. Decision: never QR the permanent
code (copy/paste-only); the temporary PAIR code and the COPY code, both
already revocable/expiring, become the scan-to-add-device path instead, QR'd
as the same invite link "Copy as Link" already produces. `src/utils/qrCode.ts`
gained QR "byte" mode (`encodeLinkQr`) for URLs alongside the existing
"alphanumeric" mode, verified against a real, independent decoder (`jsqr`,
a one-off dev-time install) — the existing test suite had only ever confirmed
the encoder didn't throw, never that a rendered QR actually decoded correctly.

**Storage-persistence decline reads as a real answer.** "Ask to keep data"
worked as designed on desktop Firefox but appeared to do nothing on iPadOS
and Android. Not a request-logic bug: unlike Firefox's explicit prompt,
Chrome/Safari on mobile commonly grant or decline `navigator.storage.persist()`
silently from engagement heuristics, and a decline left the UI in exactly the
state it was already in before anyone clicked, so a real refusal read as the
click doing nothing. Fixed with a `justDeclined` flag, set only by an
explicit ask, giving a decline its own message and relabeling the button to
"Ask again." The first version of that message named "Firefox" by name —
flagged immediately as developer-speak nobody using the app would recognise
— and was reworded to describe only what happened and what to do.
