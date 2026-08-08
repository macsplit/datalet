# Project Next Steps — Completion Report

This began as the ordered follow-up plan from the repository review on
2026-08-08. It is retained beside the progress reports as the acceptance
checklist and completion record. Detailed implementation history lives in
`incremental-persistence-progress.md` and `remote-sync-progress.md`.

Status: DONE for the agreed implementation scope. At the user's direction, the
multi-hour endurance run was curtailed and is explicitly deferred to a later
heavy-testing session.

## 1. Incremental localStorage persistence — DONE

- [x] Reproduced the stored-data safety-cap failure and fixed rejected-load
  byte accounting. Invalid or oversized data disables writes for that page
  load, so bootstrap cannot partially overwrite data the engine refused.
- [x] Replaced the single store blob with one key per record plus an index;
  ordinary flushes serialize and write only touched records.
- [x] Added write-before-delete legacy migration with byte-for-byte read-back,
  safe interruption, and retry on the next load.
- [x] Verified create/update/delete across reload, corrupt-record isolation,
  interrupted migration, and the 4 MB cap in Playwright.
- [x] Recorded the 100/1,000/5,000-write comparison in
  `incremental-persistence-progress.md`.
- [x] Client/server typechecks and production builds pass.

## 2. Repeatable regression coverage — DONE

- [x] Added Playwright coverage for migration, proportional writes, mixed
  mutations and reload, rejected oversized data, Settings singleton behavior,
  backup recovery, filtering/sorting, and references.
- [x] Added Node tests for patch validation/application and live Redis/Neo4j
  coverage of token rotation, stream tickets, idempotency, LWW conflicts,
  tombstones, Redis-loss recovery, and two-store tombstone purging.
- [x] Added `test`, `test:client`, and `test:server` scripts.
- [x] Added GitHub Actions verification with Redis and Neo4j services, both
  typechecks, both builds, and both test suites.

## 3. Documentation reconciliation — DONE

- [x] README now describes local-only default behavior, optional remote sync,
  per-record persistence, backups, filter/sort, and reference fields.
- [x] `remote-sync-architecture.md` is marked implemented and preserves the
  original-state/design reasoning without presenting it as future work.
- [x] `remote-sync-deployment.md` distinguishes templates from checked-in
  files and includes both the HTTP server and required materializer in Compose
  and systemd examples.
- [x] The product evaluation reflects incremental localStorage and the explicit
  decision not to pursue IndexedDB/windowed subscriptions in this scope.
- [x] Remaining limits stay explicit: full startup load, in-memory scans,
  unpaginated rendering, and a 4 MB application safety ceiling.
- [x] Pairing docs match the implementation: switching to a vault does not
  rename an existing local graph; export/import is the migration path.

## 4. Settings/bootstrap duplication race — DONE

- [x] Settings uses the deterministic `did:ng:z:SettingsSingleton` subject.
- [x] Bootstrap waits for the ORM readiness promise rather than guessing with
  animation frames.
- [x] Cross-tab updates include bounded touched-record snapshots, allowing a
  late listener to recover a missed create before applying field patches.
- [x] Duplicate logical record creation is insert-only, preventing delayed
  defaults from overwriting newer edits.
- [x] Automated two-tab coverage confirms app title and currency update live,
  match persisted/engine state, and survive reload.

The separate upstream `@ng-org/orm` lifecycle issue described in the sync
progress report remains tracked independently; this repository's Settings and
late-listener races are fixed without modifying the dependency.

## 5. Product milestones — DONE

1. [x] JSON export/import for the active graph, including records and all
   builder metadata, with validation, size checks, graph remapping, replacement,
   reload, and an end-to-end recovery test.
2. [x] Data-block field/value filtering and field/id sorting in either
   direction, including schema-change cleanup and numeric ordering coverage.
3. [x] Single- and multi-value reference fields targeting another schema,
   label resolution, editor/widget integration, target-schema deletion cleanup,
   and persisted selection coverage.

## 6. Optional remote-sync hardening — DONE (heavy endurance deferred)

- [x] Vault identity and token hashes are mirrored to Neo4j. Missing Redis
  metadata/index entries reconstruct from Neo4j on the next authenticated
  request; rotation updates both stores with rollback on failure.
- [x] SSE uses one-hour stream-only tickets instead of putting the durable
  bearer token in a URL. Tickets are token-generation-bound, so rotation
  invalidates them for new/reconnecting streams.
- [x] Live short-retention testing confirms tombstones purge from both Neo4j
  and Redis.
- [x] Killing the upstream behind Caddy closes the browser-facing SSE stream,
  exercising production-path sync-loss detection rather than the Vite proxy.
- [x] Started the planned two-hour harness with 20 SSE connections, steady
  writes, a forced materializer restart, and minute-by-minute memory/lag
  samples. It was curtailed at the user's request after ~19 minutes and is
  honestly recorded as partial rather than passed. The sample had 1,139
  accepted writes, zero errors, recovered pending work, and flat post-warm-up
  Node RSS. Terminal materialized-count equality and true multi-hour leak
  confidence remain deferred.

## Verification commands

```bash
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec tsc --noEmit -p server/tsconfig.json
pnpm build
pnpm build:server
pnpm test:client
pnpm test:server
```

All commands above pass. The partial endurance artifact is
`remote-sync-endurance-results.json`, labeled `status: curtailed`; its temporary
services/data were cleaned up and Neo4j's normal authenticated configuration
was restored. A future deployment-focused session can replace it with a true
multi-hour result without blocking the completed work here.
