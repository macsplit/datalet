# User-story browser tests

**Status: active.** This is the specification for deterministic, realistic
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

### J4 — Share a copy without sharing the original

An established moderate-size datalet publishes a link. A fresh browser accepts
it, waits for complete materialization, changes the copy, and proves the source
is unchanged. The existing 2,000-record copy-scale smoke supplies much of this
mechanism; the remaining work is a narrative source-versus-copy independence
journey with ordinary subsequent edits.

### J5 — Maintain several areas of life separately

A paired browser creates three recognisably different datalets, works in each,
switches among them repeatedly, archives and rejoins one, and verifies that
titles, themes and records never bleed between them. Include a backup before a
destructive lifecycle action and recovery afterwards.

## Priority

Implement J4 next against the real sync stack. J5 follows with the
multi-datalet lifecycle and recovery journey.
