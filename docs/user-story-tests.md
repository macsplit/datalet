# User-story browser tests

**Status: implemented.** This is the specification for deterministic, realistic
Playwright journeys. These tests complement the focused regression suites and
the random datalet fuzzer: they exercise ordinary sequences long enough for
features to interact, using enough data for paging, searching, storage and
serialization paths to behave realistically.

## Rules

- Start from a user-recognisable situation and state what the person is trying
  to accomplish. Do not name a past implementation bug as the scenario.
- Cross product boundaries through the public UI. Direct storage seeding is
  reserved for focused tests; a journey may use backup import because importing
  an existing datalet is itself a supported user workflow.
- Use moderate deterministic data: tens to hundreds of records for browser
  journeys, and thousands only in the dedicated real-stack scale smoke test.
- Exercise a sequence, not a feature checklist. State must survive the next
  meaningful action: reload, search, switch, export, copy, or restore.
- Assert user outcomes and durable state. Also assert that no runtime safety
  circuit, validation failure or uncaught page error appeared along the way.
- Print progress at each phase so a longer run never looks hung.

## Journey backlog

### J1 — Adopt and maintain a personal tracker — implemented

A person brings an established 48-record reading log to a fresh browser. They
browse its paged reader, find an author, update a book and its markdown notes,
add a new book, reload, export the searched result, take a full backup, delete
the new record, and restore it from that backup.

This composes backup import, graph remapping, moderate-size rendering, paging,
search, scalar and markdown editing, record creation, persistence, per-block
export, deletion, full backup and recovery.

### J2 — Build a tracker, then evolve its shape — implemented

A person builds a project tracker from the schema and block builders, enters 24
projects through the reader UI, later adds an optional field, confirms the
existing renderer evolves with it, updates old and new records, changes
sort/filter configuration, and confirms the evolved tracker survives reload
and backup round-trip.

### J3 — Use one datalet from two devices — implemented

`server/test/multiDeviceUserStorySmoke.ts` drives two isolated Chromium
contexts through the real supported PAIR flow against HTTP, Redis, the
materializer and Neo4j. Device one builds and populates a shared notes tracker,
device two pairs with a one-use code and receives a live edit, then device two
edits offline while device one continues online. On reconnect, both rendered
pages and the materialized snapshot must agree on the field-level merge without
a reload, discarded write, safety warning or uncaught page error.

This journey found three independent defects that route-mocked browser tests
could not expose: acknowledging an in-flight batch erased a newer queued edit;
a Redis watcher could miss a patch in the historical-to-live SSE handoff; and
a received patch updated localStorage without invalidating the mounted React
shape consumer. Focused regressions now cover the first two, while this real
journey covers their composition and the reactive client boundary.

### J4 — Share a copy without sharing the original — implemented

`server/test/copyIndependenceUserStorySmoke.ts` seeds an established 64-record
datalet through the real sync stack, opens it in its owner's browser, publishes
a copy link through the UI, and accepts it in a fresh Chromium context. The
copy and source then make separate ordinary edits. Both UIs and both
materialized snapshots must show their own edit and retain the other side's
original value. Run it with `pnpm test:smoke:user-story-copy`.

### J5 — Maintain several areas of life separately — implemented

A paired browser creates Garden, Reading and Travel datalets through the UI,
each with its own title, theme, schema and record. It switches repeatedly,
checks that none of those identities bleed, archives/restores Reading, exports
a backup, deletes its record, restores the backup, then switches away and back
to prove the recovery reached durable sync state.

The final reopen found a real defect: backup import replaced local storage but
did not emit outbound patches, so the server's older snapshot silently undid
the apparent recovery on the next switch. Backup restore now emits the minimal
graph diff through the durable sync outbox before reloading, chunked below the
existing patch-count and request-size limits.

## Result

J1–J5 are implemented. Focused regression suites remain responsible for narrow
faults; these journeys remain the composed, user-facing acceptance layer.
