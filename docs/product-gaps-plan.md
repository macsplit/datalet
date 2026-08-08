# Product Gaps — Ordered Resolution Plan

**Status: current. This is the active plan for the repository.**

| | |
|---|---|
| **Done** | Steps 1–5 and 9a — reader tools, fields, offline shell, honest sync conflicts, stale-edit fix |
| **Next** | Step 6 — non-destructive stale-cursor recovery |
| **Open decision** | Step 9 — file/image fields need a storage call before any work starts |

Step 9a was found while building step 1's coverage and is not from the original
evaluation. It was resolved before step 2 because step 7 (undo) depends on
edits rendering correctly and every new input type would otherwise inherit the
same stale display.

Derived from `product-evaluation-2026-08-08.md`. That document does not carry a
literal "priority practical fixes" heading, so this plan takes the practical
reading: every gap it names that is **fixable inside this repository's current
architecture**, ordered for delivery. Items the evaluation rules out on purpose
are listed under "Explicitly not in this plan" rather than silently dropped.

Predecessor: `project-next-steps.md` (complete). This is the next tranche.

## Scope

**In** — from the evaluation's own wording:

| Eval reference | Gap |
| --- | --- |
| "Any dataset above small" | No end-user ad hoc search, grouping, pagination, aggregation |
| Summary judgment | Date/time and file field types absent |
| "Complex relational workflows" | Rich text, URL, email types absent |
| Summary judgment | No undo/history for conflict or editing mistakes |
| "Smaller things", bullet 1 | A losing write returns 409 and is silently discarded |
| "Smaller things", bullet 2 | Stale-cursor recovery is wholesale replacement plus forced reload |
| "True offline-first, despite the framing" | No service worker, no web manifest |
| "Long-term maintenance remains early" | Most UI builder workflows lack regression coverage |
| `project-next-steps.md` §6 | Multi-hour endurance run curtailed, deferred |

**Explicitly not in this plan** — the evaluation calls these correct-as-scoped,
and none can be fixed without changing what the product is:

- Multi-user accounts, roles, per-record ownership, audit trail, selective
  sharing (out of scope per `remote-sync-architecture.md` §9).
- End-to-end encryption / encryption at rest for the sync tier.
- Synchronous durability; the ~1s Redis AOF `everysec` crash window stays.
- IndexedDB / windowed subscriptions — considered and rejected in the previous
  tranche. The 4 MB `RUNTIME_LIMITS.storedBytes` ceiling and the full-store
  startup load remain, and steps below are sized to live under them.
- Joins, reverse lookups, rollups, relationship constraints, cascading behavior.
- The upstream `@ng-org/orm` subscription-lifecycle race — tracked upstream, not
  fixable here without forking the dependency.

## Ordering rationale

Steps 1–4 are self-contained, need no server or storage change, and each lands
independently. Steps 5–6 touch the sync engine and the local patch pipeline, so
they follow once the app-layer work has settled. Steps 7–8 are verification
work that is cheapest once the features it covers exist. Step 9 is gated on a
decision the code cannot make.

---

## 1. End-user search and pagination in data blocks — DONE

Shipped as described. `BlockShape` gained `searchEnabled` and `pageSize`; the
data-block editor exposes both; `ResolvedDataBlock` memoizes the filter/search/
sort pipeline and slices it into pages. `tests/data-blocks.spec.ts` adds 10
Playwright tests. Grouping and aggregation were held back as planned.

One deviation: search-state reset uses a JSON-encoded key rather than a
separator-joined string, because control-character separators do not belong in
source. Same behavior, cleaner file.

**Why first.** The evaluation's harshest practical verdict is "any dataset above
small". Filtering and sorting exist but are *builder-configured*; a person using
the app cannot narrow a list. This is pure client-side work over records the
subscription already holds — no schema migration, no server change — and it is
the single largest usability gain per unit of effort.

**Work**

- `src/shapes/shex/metaShapes.shex`, `BlockShape`: add
  `ex:searchEnabled xsd:boolean ?`, `ex:pageSize xsd:integer ?`. Regenerate with
  `pnpm build:orm` (rewrites `src/shapes/orm/metaShapes.{typings,schema}.ts`).
- `src/pages/BlocksBuilderPage.tsx`: expose both alongside the existing
  filter/sort controls in the data-block editor.
- `src/components/BlockRenderer.tsx`, `ResolvedDataBlock`: add a per-session
  search input (component state — an end-user query is not app design and must
  not be written to the graph or synced), then wrap the existing filter/sort
  pipeline (lines 95–111) in a `useMemo` and slice to the current page.
  Today that pipeline re-filters and re-sorts on every render; with search
  typing on top, memoizing stops being optional.
- Reset the page index when the query, filter, or sort changes.
- Show "showing X–Y of N" so an empty page is never ambiguous.

**Decisions baked in**

- Search matches the same stringification the configured filter already uses
  (`String(value ?? "").toLocaleLowerCase().includes(needle)`), across
  widget-bound properties only, so what is searched is what is on screen.
- Reference fields match on the resolved label where the target subscription is
  already mounted, and on raw id otherwise. Document that, do not hide it.
- Grouping and aggregation are deliberately *not* in this step. They need a
  display model (group headers, collapse state, which aggregate per type) that
  is a design task, not a filter tweak. Revisit after search ships.

**Acceptance** — new `tests/data-blocks.spec.ts`: search narrows a seeded list;
search composes with a configured filter and sort rather than replacing it;
page boundaries are correct at exactly `pageSize` and `pageSize + 1` records;
changing the query resets to page 1.

**Size** M.

---

## 2. Date and time field types — DONE

Shipped as described. Date-only values remain `YYYY-MM-DD`; date-time editor
values are normalized to UTC ISO strings and converted back to local time for
editing and browser-locale display. Empty values remain empty. The generated
ORM schema, both builders, runtime dynamic shape, defaults, and field renderer
all recognize the new types. Playwright covers persistence across reload,
empty values, chronological sorting, UTC normalization, and local editor
round-tripping.

**Why here.** Named first among the missing types in the evaluation's summary,
and the only one that stores as a plain JSON string — so it crosses the patch
pipeline, Redis Lua, and Neo4j materializer with no change to any of them.

**Work**

- `metaShapes.shex`: `PropertyDefShape.ex:dataType` gains `ex:date`;
  `WidgetShape.ex:fieldType` gains `ex:date` and `ex:dateTime`. Regenerate.
- `src/utils/dynamicSchema.ts`, `dataTypesFor`: `did:ng:z:date` →
  `{ valType: "string" }`. Store RFC 3339 / ISO 8601 in UTC. That choice is
  load-bearing: it makes `BlockRenderer`'s existing `localeCompare` sort
  chronologically correct for free, and keeps step 1's search working on the
  literal text.
- `src/components/BlockRenderer.tsx`, `defaultValue`: `""` for date (empty, not
  "now" — a defaulted timestamp is a lie about when the record was filled in).
- `src/components/FieldWidget.tsx`: `<input type="date">` / `type="datetime-local"`
  when editing; `Intl.DateTimeFormat` in the browser locale when reading,
  matching how `formatCurrency` already defers to the browser locale.
- `src/pages/SchemaEditorPage.tsx` `DATA_TYPES`, `src/pages/BlocksBuilderPage.tsx`
  `FIELD_TYPES` and `defaultFieldType`.

**Acceptance** — Playwright: create a record with a date, reload, value is
byte-identical; sort a data block by a date property and get chronological
order; an empty date round-trips as empty rather than epoch.

**Size** S–M.

---

## 3. URL, email, and long-text field types — DONE

Shipped as described. Text properties can now use URL, email, and long-text
widgets without changing their stored data type. URL and email editors use
their native input modes; read mode emits HTTP(S) and `mailto:` links with
`noreferrer noopener`, while unsupported or malformed URL schemes remain plain
text. Long text uses a resizable textarea and preserves whitespace in read
mode. Playwright covers persistence/reload, the rendered controls and links,
line breaks, and an inert `javascript:` URL.

**Why here.** Same seam as step 2 and nearly free once it is open — all three
are `valType: "string"` with a different input type and a different read-mode
render. Doing them in a separate pass would mean a second schema regeneration
and a second round of editor plumbing for no benefit.

**Work** — `ex:url`, `ex:email`, `ex:longText` on `WidgetShape.ex:fieldType`
(all three keep `dataType: did:ng:z:text`, so no `PropertyDef` change and no
migration for existing records). `FieldWidget` renders `<input type="url">`,
`<input type="email">`, `<textarea>`; read mode renders a link for url/email
with `rel="noreferrer noopener"` and a preserved-whitespace block for long text.

**Not included:** rich text. A formatting model (storage format, sanitizer,
editor) is a genuine project, not a field type, and the evaluation lists it
beside the cheap types without that distinction.

**Acceptance** — extend step 2's spec: each type persists, and a `javascript:`
URL is not rendered as a live link.

**Size** S.

---

## 4. Installable offline shell (manifest + service worker) — DONE

Shipped with a web manifest, deterministic 192/512 icons derived from the
existing vector mark, production-only service-worker registration, and an
explicit dependency-free worker. Install caches the built shell and its hashed
assets; static GETs are cache-first with background refresh, navigations fall
back to the shell, old cache versions are removed, and `/sync/*` is always
bypassed. A separate production-preview Playwright test takes Chromium offline,
confirms a persisted record survives a cold reload, and confirms sync health
cannot be served from the worker. `pnpm test:client` runs both the normal dev
suite and this production-only check.

**Why here.** The evaluation calls the offline framing out directly: data
persists offline but a cold load with no network will not start the app. This
is the cheapest gap to close honestly, and it is fully isolated from steps 1–3.

**Work**

- `public/manifest.webmanifest` plus 192/512 icons; link it and `theme-color`
  from `index.html`.
- Hand-written `public/sw.js`, no new dependency: cache-first with
  stale-while-revalidate for same-origin static GETs, navigation requests fall
  back to the cached shell, and a hard bypass so `/sync/*` is **never**
  intercepted — a cached SSE stream or a replayed POST would corrupt sync
  state. Version the cache name and clean up old caches on `activate`.
- Register from `src/index.tsx`, production builds only, so `vite dev` keeps
  hot reload.
- README: state plainly what offline now means (cold start works; unpaired,
  fully offline; paired, edits queue in the existing outbox).

**Rejected alternative:** `vite-plugin-pwa` — a build-time dependency and a
generated Workbox runtime for roughly sixty lines of behavior we want explicit
control over, specifically the `/sync/*` bypass.

**Acceptance** — Playwright: load the app, `context.setOffline(true)`, reload,
the app boots and previously created records render.

**Size** M.

---

## 5. Make discarded writes visible — DONE

Shipped across the Redis Lua reply, typed Redis client, HTTP response, and
browser outbox. Accepted and submitted patch counts now survive idempotent
retries; a 409 or a partially accepted 200 raises a visible warning with the
dropped count and server reason. The winning SSE update remains the sole
convergence path—there is deliberately no competing rollback. Live integration
coverage checks partial acceptance and its replayed result when Redis/Neo4j are
available; Playwright stubs both full and partial rejection responses and
asserts the warning text.

**Why here.** Depends on nothing above, but it needs a small server change, so
it opens the sync-tier half of the plan. The evaluation flags the 409 path as
"correct per the design, invisible to the user"; reading the code, the invisible
surface is actually **larger** than the evaluation states.

**The finding.** `applyBatch.lua` filters per patch (lines 116–170). A batch
where *some* patches lose the HLC comparison returns `accepted = 1` and a 200,
and neither the response nor `server/src/redis/client.ts` carries how many
patches were dropped. So a partially superseded batch is invisible to the server
response, to `flushOutbox`, and to the user. Only the all-rejected case produces
the 409 at `src/utils/remoteSyncEngine.ts:228`, and that one is discarded
silently too.

**Work**

- `applyBatch.lua`: return accepted and submitted counts (append to the reply
  array — additive, so an older client reading `[accepted, seq, reason]`
  positionally is unaffected). Surface them through `client.ts` and the
  `/sync/patches` JSON body.
- `remoteSyncEngine.ts`: on 409, and on a 200 with `accepted < submitted`, call
  the existing `reportRuntimeIssue(..., "warning")` with the server's `reason`
  and the dropped count. The banner infrastructure already exists; this is
  wiring, not new UI.
- Deliberately do **not** attempt local rollback of the losing value. The
  winning write arrives over SSE and converges the record anyway; a second
  reconciliation path would be a new class of bug for no gain. The user gets
  told; the data still converges the way the design says.

**Acceptance** — `server/test/redisSync.test.ts`: a partially superseded batch
reports the reduced accepted count. Playwright with a stubbed 409: the warning
banner appears with the server's reason.

**Size** S–M.

---

## 6. Non-destructive stale-cursor recovery

**Why here.** Builds on step 5's honesty work and is the last sync-tier item.
`resyncFromSnapshot` currently calls `replaceGraphAndReload`: wholesale graph
replacement plus a forced page reload, losing scroll position, open editors, and
in-progress form state. The outbox protects unpushed edits, so this is a UX
defect rather than a data-loss defect — which is exactly why it ranks below
step 5 and not above it.

**Work** — apply the snapshot into the live store and let the existing
subscription broadcast path re-render, rather than reloading. Reuse
`applyPatchesToStore` / the cross-tab apply path in
`src/utils/localNgEngine.ts` instead of adding a third store-mutation route.
Keep `replaceGraphAndReload` for import and for pairing changes, where a reload
is genuinely the right answer.

**Risk to check before committing to this step.** The reload exists partly
because swapping a graph out from under mounted ORM subscriptions is the
neighborhood of the known upstream lifecycle race. If in-place replacement
proves to trip it, stop, keep the reload, and instead soften it: warn first,
preserve scroll and route across the reload. That fallback is a real
improvement and is the honest outcome if the dependency will not cooperate.

**Acceptance** — Playwright: force a cursor outside the retained stream, confirm
the graph converges to the snapshot with no navigation event; unpushed outbox
entries still flush afterwards.

**Size** M, with a live fallback plan.

---

## 7. Local undo

**Why this late.** The evaluation asks for "undo/history for conflict or editing
mistakes". Undo across devices is history — a real feature with storage and
conflict semantics, and it is out of scope. Undo of *your last few local edits
in this page session* is achievable and covers the mistake case the evaluation
actually describes. It is ordered after steps 1–6 because it needs a small
engine change, and it should not block cheaper wins.

**Work**

- `src/utils/localNgEngine.ts`: `onLocalPatch` (line 326) fires *after* apply,
  so it cannot produce an inverse for a property that previously had no value.
  Add a pre-apply capture that emits the prior value alongside each patch; the
  existing `snapshotPatches` helper (line 382) already knows how to serialize a
  record's current state and is the natural building block.
- A bounded in-memory inverse stack (≈50 entries, session-scoped, not
  persisted, not synced) plus an Undo control and `Ctrl/Cmd+Z`.
- Undo emits a normal local edit, so it flows through persistence, cross-tab
  broadcast, and the outbox unchanged — it is a new write, not a rewind. That
  keeps it correct under sync: undoing locally cannot resurrect a value another
  device already superseded, it just proposes the old value with a fresh HLC.

**Acceptance** — Playwright: edit, undo, value and persisted bytes both revert;
undo after reload is a no-op (stack is session-scoped, by design); undo of a
record creation removes the record.

**Size** M–L. Break out if it grows.

---

## 8. Broader builder regression coverage

`tests/persistence.spec.ts` is 11 tests weighted toward persistence and sync.
Steps 1–7 each add their own coverage; this step closes what the evaluation
calls out — "most UI builder workflows still need broader regression coverage" —
for the workflows that predate this plan: creating and editing a schema,
reordering properties, tab management, nested layout blocks, widget
add/reorder/delete, and schema deletion cleanup. Split `persistence.spec.ts` by
concern once the file crosses roughly 15 tests.

**Size** M.

---

## 9. Decision required: file and image fields

**This step is blocked on a product decision, not on engineering.** The
evaluation lists file/image among the missing types without noting that they
collide head-on with a constraint it names elsewhere: the whole store lives in
memory under a 4 MB `RUNTIME_LIMITS.storedBytes` cap, and every patch value
crosses the sync path as JSON. One photograph exhausts the entire vault.

Three options, in my order of preference:

1. **Defer** until a storage decision (IndexedDB or a blob endpoint) is made.
   Consistent with the previous tranche's explicit rejection of an IndexedDB
   migration, and my recommendation.
2. **Small inline images only** — a hard per-value limit (≈64 KB), base64 data
   URI, client-side downscale on selection, and a clear refusal above the limit.
   Ships inside the current architecture; genuinely useful for avatars, icons,
   and thumbnails; useless for documents or photos, and that must be said in the
   UI rather than discovered at the cap.
3. **Blob storage in the sync tier** — a real feature (upload endpoint,
   retention, tombstones for orphaned blobs, quota) that also breaks the
   unpaired product's "no network surface at all" property. Largest scope, and
   it changes what the local-only mode is.

## 9a. Found during step 1: edited field values go stale on screen — DONE

Not in the original evaluation — surfaced while building step 1's coverage, and
worth fixing before step 7 (undo), which depends on edits rendering correctly.

**Symptom.** Editing a text or number field on a *user record* commits and
persists correctly — `localStorage` holds the new value and a reload displays
it — but the on-screen input immediately snaps back to the previous value. The
data is right; the display is stale until reload.

**Confirmed pre-existing.** Reproduced on unmodified `main` (commit `50fb0aa`)
with the step-1 changes stashed, via both `fill()` and per-keystroke typing.
Nothing in step 1 causes or worsens it, and it is independent of the memoized
pipeline — an un-memoized build reproduces it identically.

**Likely mechanism.** `useShape`'s deepSignal is created with
`replaceProxiesInBranchOnChange`, so writing a property replaces the record's
proxy. The card re-renders holding the superseded proxy and reads the old value
back out of it. Builder metadata records (tabs, settings) do not show this,
which is why existing coverage never caught it; those edit paths re-read
through their hooks on each render.

This is plausibly the same neighborhood as the tracked upstream
`@ng-org/orm` lifecycle issue. Investigate before writing any workaround — a fix
in the app layer that papers over a dependency bug is worth avoiding if the
dependency can be fixed instead.

**Resolution.** Confirmed against the installed React adapter: a write can
replace the deep-signal record branch while a field still renders the retired
proxy supplied in its current card props. The dependency is external, so field
widgets now hold an optimistic local value, write through the same record proxy
as before, and resynchronize when the record prop supplies a genuinely newer
value. Persistence, cross-tab broadcast, and remote sync remain unchanged.
The behavior is covered by a Playwright regression that verifies both the live
input and the per-record persisted bytes.

## 10. Deferred: multi-hour endurance run

Carried over from `project-next-steps.md` §6, unchanged. The existing artifact
`remote-sync-endurance-results.json` is honestly labeled `status: curtailed`
after ~19 minutes. It needs a deployment-focused session with real hours
available, and it gates nothing above.

## Verification

Every step ends green on the existing commands:

```bash
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec tsc --noEmit -p server/tsconfig.json
pnpm build
pnpm build:server
pnpm test:client
pnpm test:server
```

Steps 1–3 additionally require `pnpm build:orm` to be re-run and the regenerated
`src/shapes/orm/*` committed. `product-evaluation-2026-08-08.md` should be
updated as each step lands, in the same style as the previous tranche — the
evaluation's value is that it stays accurate about what is missing.
