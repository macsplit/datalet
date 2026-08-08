# Incremental localStorage Persistence — Progress Report

Tracks implementation of the approved plan at
`/home/user/.claude/plans/shiny-yawning-hanrahan.md` (also summarized
below). Separate initiative from the remote-sync work
(`remote-sync-architecture.md`/`remote-sync-progress.md`) — this is a
client-only fix to `src/utils/localNgEngine.ts`'s local persistence layer.

## Why

`localNgEngine.ts` kept the whole app's object graph in one in-memory
`Store` and persisted it as one JSON blob under one localStorage key —
every edit, however small, triggered a debounced full `JSON.stringify` +
full `localStorage.setItem` of the *entire* store. Cost was O(total store
size) per flush, not O(what changed): a real hot-path inefficiency,
independent of the separate ~5–10MB storage-quota ceiling.

Explicitly **not** doing (ruled out of scope): IndexedDB/OPFS migration,
windowed/paged subscriptions, any change to the in-memory `Store`/
`OrmRecord` shape or the sync protocol. Those ideas used to live in
`remote-sync-architecture.md` §11 as a "future direction" and have been
deleted from the repo — judged to be a different product's scope, not a
natural next phase of this one. This fix is deliberately narrow: make
*ongoing per-edit persistence* incremental, nothing else.

## Status: DONE

### Implementation — DONE

All in `src/utils/localNgEngine.ts` (confirmed via exploration this is
the only file that needed to change — no other file depends on the
on-disk format, only on this module's public function/type contracts):

- New layout: one localStorage key per record
  (`meta-ui-builder:ng-local-store:record:<id>`) plus a small index key
  (`meta-ui-builder:ng-local-store:index`) listing known ids, replacing
  the single-blob layout.
- `dirtyIds: Set<string>` tracks touched ids, populated inside
  `applyPatchesToStore` at both its mutation points.
- `persistNow()` rewritten as a two-pass incremental flush: pass 1 computes
  the projected byte total and every write without touching localStorage
  (preserving the existing all-or-nothing safety-cap behavior — nothing
  gets written if the projected total would exceed
  `RUNTIME_LIMITS.storedBytes`); pass 2 commits. A running
  `recordByteLengths`/`storedBytesTotal` replaces the old "re-stringify
  everything to check size" approach.
- `loadStore()` rewritten to read the index then each record
  individually, rebuilding the byte-length tracking as it goes. Bonus,
  low-risk behavior improvement: a single corrupted record now only drops
  that one record (reported via `reportRuntimeIssue`) instead of losing
  the entire store.
- One-time, write-before-delete migration (`runMigrationIfNeeded`) from
  the old blob format: writes every record + the index under the new
  scheme, verifies byte-for-byte against what was just written, and only
  then deletes the old blob key. A failure partway through leaves the old
  blob in place (safe retry on next load) rather than losing data.
- `replaceGraphAndReload` fixed to route through the same `dirtyIds` set
  — it mutates `store` directly rather than via `applyPatchesToStore`, so
  without this fix it would have silently stopped persisting its own
  changes once `persistNow()` became dirty-set-driven. Caught during
  planning (a Plan subagent's review), not left to be found by testing.
- `schedulePersist`'s stale doc comment ("one expensive stringify/storage
  write") updated to match the new behavior.
- `tsc --noEmit` on the client's `tsconfig.json`: clean.

### Verification — DONE

Ad hoc Playwright script (`persistTest.mjs` in this session's scratchpad,
not committed), run against the real dev server, using isolated
`browser.newContext()` per test (an early version without isolated
contexts produced spurious failures from shared localStorage bleed
between tests — fixed).

**Confirmed passing:**
- **Migration**: old blob key removed after reload; new index contains
  the migrated ids; migrated record content matches byte-for-byte.
- **Proportional-write proof (the core claim)**: seeded 300 synthetic
  records directly in the new format, made one small field edit through
  the real UI, confirmed only 1 `setItem` call fired (245 bytes) — not a
  rewrite of the 300-record store. This is the central thing this change
  needed to prove, and it held.

**Additional checks now passing in the tracked Playwright suite:**

- **Reload reconstructs identical state**: create a user tab, update it,
  snapshot every indexed record byte-for-byte, reload, and compare the same
  persisted state; then delete the tab and confirm the deletion survives a
  second reload.
- **Safety cap**: seed data just over 4 MB, confirm the visible safety issue,
  and confirm neither the index nor oversized record is modified after app
  bootstrap. This exposed and fixed an accounting bug: rejected loads could
  leave partially populated byte-length bookkeeping behind. Rejected or
  invalid loads now clear bookkeeping and disable persistence for that page
  load, preventing bootstrap defaults from overwriting data the app refused
  to load.
- **Interrupted migration**: inject a synthetic quota failure during the
  first per-record write, confirm the legacy blob remains authoritative and
  no new index is created, then reload and confirm migration retries and the
  record appears. Migration failure now explicitly disables normal writes
  for that page load.
- **Corrupted record isolation**: one invalid per-record JSON value is
  reported and skipped while a valid neighboring record still loads.
- **Settings bootstrap**: a fixed Settings subject id prevents duplicate
  singleton creation across reloads and two open tabs. Bootstrap now waits on
  the ORM subscription's readiness promise instead of racing its initial-data
  callback with an animation-frame delay. Cross-tab broadcasts include bounded
  snapshots of touched records, so a tab that missed the original creation
  message can reconstruct identity before applying a later field edit; logical
  record creation is insert-only, preventing a delayed default bootstrap from
  overwriting newer values. App-title and currency edits were verified live in
  a second tab, in persisted storage, and again after reload.
- **Overhead benchmark** (Chromium on this dev box; indicative, not an SLA):
  100 small writes 0.5 ms vs one blob 0.1 ms; 1,000 small writes 4.9 ms vs
  one blob 0.8 ms; 5,000 small writes 27.7 ms vs one blob 3.2 ms. The fixed
  per-call cost is measurable, but ordinary edits write one touched record,
  not thousands; the change's target path therefore avoids repeatedly
  serializing and writing the whole store.

## Verification commands

```bash
pnpm test:client
pnpm exec tsc --noEmit -p tsconfig.json
pnpm build
```

The browser suite lives in `tests/persistence.spec.ts` and is run in CI.

## Outcome

Ongoing persistence cost is now proportional to the records touched in a
flush. Startup still reads the whole store, the in-memory model is unchanged,
and the 4 MB safety ceiling remains; those constraints are intentionally
outside this narrowly scoped change.
