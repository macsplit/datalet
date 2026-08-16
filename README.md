# Local Graph UI Builder

A browser-based builder for defining data schemas and turning them into working
record-management screens. Schemas, navigation tabs, layouts, blocks, and field
widgets are stored as graph data and can be changed through the Settings UI.

The application is local-only by default: it needs no account, wallet, API
key, or server to store and use data in the current browser profile. Open tabs
for the same site synchronize through `BroadcastChannel`. An optional sync
server can pair a private vault across devices; leaving sync unconfigured
keeps the application entirely browser-local.

Production builds are installable as a web app and cache their application
shell. After one online load, an unpaired app can cold-start fully offline with
its local records. A paired app also starts offline and queues edits in its
existing outbox until the sync server is reachable again; `/sync/*` requests
are never intercepted or replayed by the service worker.

## Requirements

- Node.js 22.18 or newer
- pnpm

## Running the application

Install dependencies and start the development server:

```bash
pnpm install
pnpm dev
```

Create a production build with:

```bash
pnpm build
```

To run the optional cross-device sync stack, install Redis and Neo4j, export
`NEO4J_PASSWORD` or put it in an ignored `.env.local` copied from
`.env.example`, and use `./run.sh`. See
[`docs/remote-sync.md`](docs/remote-sync.md) for the endpoints, conflict rules
and failure behaviour, and
[`docs/remote-sync-deployment.md`](docs/remote-sync-deployment.md) for
deployment options.

With the full stack running, `pnpm test:smoke:sync` performs a short
browser-to-Redis-to-Neo4j-to-second-browser verification and cleans up its
temporary vault afterward.

## Documentation

[`docs/architecture.md`](docs/architecture.md) explains how the whole system
works — the browser storage engine, the metadata model that turns schemas into
screens, and the optional sync tier — with diagrams.
[`docs/README.md`](docs/README.md) indexes everything else and marks what is
current and what is a historical record.
[`docs/roadmap.md`](docs/roadmap.md) is what remains.

## Building an interface

1. Open **Settings → Manage schemas**.
2. Create a schema and add its fields.
3. Choose a data type and cardinality for each field.
4. Open **Settings → Manage tabs**.
5. Create a navigation tab or manage the Home tab.
6. Open **Manage blocks** for that tab.
7. Add layout blocks to arrange the page and data blocks to display records.
8. Select a schema for each data block and configure its widgets.
9. Open **View tab** to use the generated record interface.

The Home tab is always available and remains first in the navigation. Custom
tabs appear after Home and before Settings.

## Schemas and fields

A schema describes one record type. Its ordered fields support:

- Text
- URL, email, and long text display controls
- Number
- Boolean
- Date / time (date-only or UTC-normalized date-time display)
- Enum
- Reference to a record in another schema
- Required, optional, or multi-value cardinality

Enum fields can define an editable list of allowed values. Changes to a schema
produce a revised runtime shape while retaining the stable record type, so
existing records continue to load after fields or enum options change.

## Blocks and widgets

A tab contains an ordered tree of blocks:

- **Layout blocks** recursively arrange child blocks in a stack, row, or grid.
- **Data blocks** connect a schema to its records and rendering configuration.

Data blocks can filter records by a configured field/value and sort by record
id or any schema field in ascending or descending order.

Two further settings apply to whoever is reading the tab rather than building
it. **Reader search** adds a search box above the records, matching across the
fields the block actually displays; a reference field matches on the stored
target id rather than its resolved label. **Records per page** splits the list
into pages, defaulting to showing everything. A search query lives only in the
open page — it is neither stored in the graph nor synced.

Every data block also offers **export** and **print**, as icon buttons in its
header. Both act on the whole filtered and searched result rather than the page
on screen. Export downloads JSON containing every stored field of those
records, not only the displayed ones. Print produces a plain black-and-white
document of the block's heading and a table of its displayed fields, with the
navigation, search box, pagination, and record controls left off the page.

Data blocks can contain these widgets:

- **Panel title** displays the block heading.
- **Add button** creates a record with schema-derived defaults.
- **Field** binds a schema field to a text, long-text, URL, email, number,
  currency, date, date-time, dropdown, multi-select, checkbox, or
  record-reference control.
- **Edit/delete actions** enables record editing and confirmed deletion.

New data blocks receive the standard title, add, edit/delete, and field widgets.
If a schema later gains fields, **Add missing fields** adds widgets for them.

The navigation bar's **Undo** control (or `Ctrl/Cmd+Z`) reverses recent local
edits and record creation. A continuous run of typing into one field is a
single undo rather than one per keystroke; pausing, moving to another field, or
undoing ends the run. Up to 50 actions are kept for the current page
session; reloading intentionally starts with an empty undo stack. An undo is a
new edit, so it persists and follows the same cross-tab and optional remote-sync
paths as any other change.

## Storage and synchronization

All application data is held in the current browser profile using
`localStorage`. It persists across reloads and is synchronized between open
tabs for the same site. Records are stored under separate keys, so an ordinary
edit persists only the touched records rather than serializing the whole
store.

When optional remote sync is configured, the same data and builder metadata
are copied to a paired vault across devices. Synced data is not end-to-end
encrypted: the server can read it. Clearing browser storage still deletes the
local copy; an unpaired browser has no remote recovery source.

Pairing switches the app to the vault graph but does not automatically migrate
records from the previous unpaired graph. To seed a new vault with existing
local data, export a backup before pairing and import it after pairing.

Persistence writes are coalesced during rapid edits. Invalid or excessive
updates, oversized local data, failing subscriptions, malformed block cycles,
and excessive block depth are stopped by runtime safety limits. Recoverable
problems appear in an on-screen error banner; render failures show a reload
screen instead of leaving the page unresponsive.

Run the regression suites with `pnpm test`. Playwright covers client storage,
bootstrap, generated data blocks, the schema/tab/block/widget builder
workflows, sync recovery and warnings, and offline startup; patch-algebra and
live Redis/Neo4j coverage uses Node's test runner. Both run in CI.

Settings also provides JSON export/import for the active graph. Backups include
user records and the schemas, tabs, blocks, widgets, and settings needed to
render them in a fresh browser profile.

## Architecture

React, TanStack Router, an RDF shape ORM, and a browser-local graph engine.

`@ng-org/orm` drives React through `useShape(shapeType, graph)` and needs only
two functions from a storage engine: `orm_start_graph` to subscribe to objects
matching a shape, and `graph_orm_update` to receive patches from local edits.
`src/utils/localNgEngine.ts` implements both over `localStorage` and a
`BroadcastChannel`, where the real NextGraph engine implements them over a wasm
CRDT store and a broker. That narrow seam is why the optional sync tier could
be added without touching any component.

The builder stores five metadata types, as ordinary records in the same graph
as the user's data:

- `Tab` — a navigation destination.
- `Block` — a layout container, or a data view bound to a schema.
- `Widget` — rendering and editing configuration for a data block.
- `SchemaDef` — a user-defined record type.
- `PropertyDef` — an ordered field belonging to a schema.

`buildShapeType()` turns a schema and its fields into a runtime ORM shape whose
IRI carries a content revision, so changing a field reopens the subscription
rather than reusing a stale one, while the stable record type keeps existing
records loading. Because metadata is stored and synced like any other record,
a screen built on one device appears on another.

```text
src/
├── components/     Block renderer, field controls, record editor, undo control,
│                   backup, vault pairing, runtime safety, icons
├── hooks/          Shared metadata subscriptions and the settings singleton
├── pages/          Tab view plus the schema, tab and block builders
├── shapes/         ShEx metadata definitions and their generated ORM artifacts
└── utils/          localNgEngine (store, persistence, cross-tab, undo),
                    dynamicSchema, remoteSyncEngine, runtimeHealth, blockGraph
server/src/         HTTP/SSE ingest, the Redis accept script, Neo4j materializer
tests/              Playwright suites
server/test/        Node test-runner suites
```

[`docs/architecture.md`](docs/architecture.md) covers all of this properly,
with diagrams: the patch format and key layout, incremental persistence,
cross-tab replication, shape revisions, undo, the safety limits, and the sync
tier's write and recovery paths.

## Regenerating ORM artifacts

After changing `src/shapes/shex/metaShapes.shex`, regenerate the TypeScript ORM
files with:

```bash
pnpm build:orm
```

## License

Licensed under either Apache-2.0 or MIT. See `LICENSE-APACHE2` and
`LICENSE-MIT`.
