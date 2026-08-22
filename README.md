# Datalet Builder

Build your own record-keeping apps, kept in your browser.

![A reading list built in Datalet Builder: a Books data block listing five
records with title, author, rating and finished date, above a search
field.](docs/images/app-reading-list.png)

*A datalet built with the tools below — the schema, the screen and the records
are all data in the same graph, and all of it came from the interface.*

A **datalet** is one such app together with everything in it — its records, and
the schemas, navigation tabs, layouts, blocks and field widgets that decide how
they are shown. You define all of it through the Settings UI, keep as many
datalets as you like, and use one at a time.

Internally a datalet is one graph, and that is the term the code and the
developer documentation use; "datalet" is the word the interface uses, because
"graph" means a chart to most people and a network to the rest.

The application is local-only by default: it needs no account, wallet, API
key, or server to store and use data in the current browser profile. Open tabs
for the same site synchronize through `BroadcastChannel`. An optional sync
server can pair a private vault across devices; leaving sync unconfigured
keeps the application entirely browser-local.

Production builds are installable as a web app and cache their application
shell. The manifest carries a fixed `id`, so the installed app keeps its
identity even if its start URL changes later. After one online load, an unpaired app can cold-start fully offline with
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

To deploy the sync tier, [`deploy/`](deploy) holds a working Docker Compose
stack: `cp deploy/.env.example deploy/.env`, set `NEO4J_PASSWORD`, then
`./deploy/up.sh`. It expects TLS to be terminated in front of it, by a tunnel
or reverse proxy pointing at the port it binds on loopback.

To run the sync stack for development instead, install Redis and Neo4j, export
`NEO4J_PASSWORD` or put it in an ignored `.env.local` copied from
`.env.example`, and use `./run.sh`. See
[`docs/remote-sync.md`](docs/remote-sync.md) for the endpoints, conflict rules
and failure behaviour, and
[`docs/remote-sync-deployment.md`](docs/remote-sync-deployment.md) for
deployment options.

With the full stack running, `pnpm test:smoke:sync` performs a short
browser-to-Redis-to-Neo4j-to-second-browser verification and cleans up its
temporary vault afterward.

With Redis and Neo4j available, `pnpm test:multi-tenant` runs the standalone
200-vault materializer harness. It reports blocking-connection growth, Redis
memory, per-vault correctness, and materialization lag percentiles, then cleans
up every generated vault.

### Stopping the sync stack

Stop `./run.sh` with Ctrl-C, or send it a `SIGTERM`. Its exit trap stops the
sync server and materializer it started.

Do **not** kill those children individually. `pnpm dev:server` runs `tsx watch`,
which runs the actual server in a further child process, so signalling anything
below `run.sh` — or `SIGKILL`, which no trap can catch — orphans a node process
that keeps listening on port 3000. The symptom is confusing rather than
obvious: the next `./run.sh` appears to start, but requests reach the *previous*
server, so code and environment changes seem not to apply. If a run seems to
ignore an edit, check `ss -ltn | grep 3000` and free the port with
`fuser -k 3000/tcp` before starting again.

### Writing a server test

Server tests hold two clients open, and both must be released or the test
process hangs after the last assertion with no error:

```ts
after(async () => {
  redis().disconnect();
  await closeNeo4j();
});
```

The Neo4j half is easy to miss. A test that never mentions Neo4j still opens a
driver if it looks up a vault that is absent from Redis, because `vaultExists()`
falls through to the durable copy — so an "unknown vault returns 404" case is
enough to leave the process alive.

The server suite runs **one file at a time** (`--test-concurrency=1`). Every
file in it talks to the same Redis keyspace and the same Neo4j database, so
running them in parallel has them mutating each other's world — `vaults:index`,
the shard leases and the rate-limit counters are all global. It is also faster
that way: about fifteen seconds, against minutes and intermittent stalls when
Node used one worker per CPU. If you add a file here, assume shared state and
clean up after yourself.

Integration tests skip themselves when Redis or Neo4j is unreachable, and a skip
is reported as `ok … # SKIP`. A green run is therefore not proof of coverage:
check the `# skipped` count, which should be `0` locally and in CI.

Suites create real vaults and clean them up on the way out, but an interrupted
run leaves them behind. `redis-cli scard vaults:index` shows the accumulation.
Delete only what you recognise as test residue — a paired browser's vault lives
in the same keyspace.

## Documentation

[`docs/architecture.md`](docs/architecture.md) explains how the whole system
works — the browser storage engine, the metadata model that turns schemas into
screens, and the optional sync tier — with diagrams.
[`docs/README.md`](docs/README.md) indexes everything else and marks what is
current and what is a historical record.
[`docs/roadmap.md`](docs/roadmap.md) is what remains.

## Building an interface

![The schema editor, defining a Books schema with Title, Author, Rating and
Finished fields, each with a data type and
cardinality.](docs/images/schema-editor.png)

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
tabs appear after Home and before Settings. A tab's address is derived from its
name (`/tab/reading-list`), so a bookmark or shared link is readable; if two
tabs would derive the same address the first keeps it and the others use their
id, and links using a raw id keep working permanently.

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

Each schema also chooses **how its records are named**: a text or enum field
becomes the label other screens use when they refer to one of its records.
Leaving it unset picks the schema's first text or enum field. Wherever a
reference is shown, sorted, searched, exported or printed, that label appears
instead of the internal record id; a record with no usable label falls back to
its id rather than showing nothing.

## Blocks and widgets

A tab contains an ordered tree of blocks:

- **Layout blocks** recursively arrange child blocks in a stack, row, or grid.
- **Data blocks** connect a schema to its records and rendering configuration.

Data blocks can filter records by a configured field/value and sort by record
id or any schema field in ascending or descending order.

Two further settings apply to whoever is reading the tab rather than building
it. **Reader search** adds a search box above the records, matching across the
fields the block actually displays; a reference field matches on the target
record's label rather than its stored id. **Records per page** splits the list
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

## Theme

![The theme page, showing colour roles for light and dark mode, each with a
swatch, a picker and a text field.](docs/images/theme.png)

**Settings → Theme → Choose colours** opens the theme on its own page. Each role
has a light and a dark value; the dark column applies when the operating system
asks for dark mode, so choosing a theme does not stop the app following that
preference. An empty field keeps the built-in colour, and **Reset theme** clears
them all.

Each value is a colour square and a text field. Clicking the square opens your
browser's colour picker; the square itself shows the colour that will actually
be on screen, over a chequerboard so a translucent value looks translucent, and
is drawn empty when nothing is set. The text field is the authoritative one — a
browser picker only understands plain `#rrggbb`, so translucent and functional
values are typed rather than picked. **×** next to a field returns that one
colour to its default, and **Reset theme** returns all of them.

Colours are held to a minimum contrast against what they sit on, so a choice
cannot leave the app unreadable while you are still using it. This is a floor,
not a style guide: it only steps in when text would be lost against its
background, and it moves the colour as little as it can. The text moves first,
since a background is read against several colours at once. If the colour you
chose is already at its limit — pure black or pure white — the other side moves
instead, so what you picked survives. When a colour has been moved, the field
says so.

Colours are stored in the graph as ordinary record fields, so a theme reaches
your other devices through sync, appears in a JSON backup, and can be undone
like any other edit.

Only colours are configurable, and only in a closed set of forms (`#rgb`,
`#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, `hsl()`, `hsla()`). A stored value
that is not one of those is ignored in favour of the built-in colour and
flagged in the Settings field. That strictness is deliberate: a backup you
import, or a vault someone else shares, can contain any string, and a theme
must never be able to make the app fetch from another server.

The typeface is not configurable at all. The app uses your system font stack:
readable text in the face your device is designed around, with nothing to
download. That is a deliberate limit rather than a missing feature — colour is
worth making yours on something you look at daily, typography is a surface
without an end, and this is a tracker rather than a design tool.

## Storage and synchronization

All application data is held in the current browser profile using
`localStorage`. It persists across reloads and is synchronized between open
tabs for the same site. Records are stored under separate keys, so an ordinary
edit persists only the touched records rather than serializing the whole
store.

![The storage panel: a bar showing 0% used, 0.0 MB of 4.5 MB, and a button to
ask the browser to keep the data.](docs/images/storage.png)

**Settings → Manage datalets** shows how full this browser is and whether it has
agreed to keep your data. If it has,
your records are exempt from routine cleanup; if it has not, the panel says so
and offers to ask. Either way, exporting a backup is still the only thing that
survives losing the device.

## Datalets

A **datalet** is one self-contained instance of this app — its records, schemas,
tabs, blocks, widgets and theme. You can keep several and use one at a time,
switching between them from **Settings → Manage datalets**, which is also where
pairing, copies, storage and backups live.

![The datalet switcher: Reading list marked Open, Field notes and Recipes each
with Open and Archive buttons, and an expanded Archived section holding two
more with Open and Restore.](docs/images/switch-datalet-archived.png)

Only the datalet you have open is held in this browser, which is why keeping
more than one requires each to be paired: the ones you are not using live in
their vaults until you open them. A datalet with no vault has no other copy to
come back from, so the app will ask you to pair the one you have before adding
another.

Datalets are cheap to make, and some are made to be finished with. **Archive**
puts one out of the way without deleting anything: its vault, its credentials
and every record in it are untouched, it drops out of the list into a collapsed
**Archived** section, and opening it brings it back. Nothing is reclaimed by
archiving — an archived datalet still occupies its vault on the sync server —
so it is a way to find the two you are using, not a way to free space.

The datalet you have open cannot be archived. That would mean evicting it and
switching in one gesture, and would leave the app deciding which datalet you
land in; open another one first.

Two things that look alike and are opposites:

- **Opening one from an `LG1` or `PAIR` code** gives you the *same* datalet in a
  second place. Edits made here and there meet.
- **Opening one from a `COPY` code** gives you a *new* datalet that started as a
  copy of someone else's. From that moment the two are unrelated, and nothing
  you do reaches theirs.

![The copy-code panel, listing one published COPY code with Copy and Revoke
buttons.](docs/images/copy-codes.png)

**Settings → Manage datalets → Give someone a copy** creates a `COPY` code for the datalet you
have open. It hands over everything in it, including every record; the sync
server can read all of it, as nothing here is end-to-end encrypted; and anyone
holding the code can take a copy until you revoke it. Revoking stops further
copies and does nothing about copies already taken.

To start a datalet from a backup file, add an empty one and then use **Import
backup**, which fills whichever datalet is open.

When optional remote sync is configured, the same data and builder metadata
are copied to a paired vault across devices. Synced data is not end-to-end
encrypted: the server can read it. Clearing browser storage still deletes the
local copy; an unpaired browser has no remote recovery source.

A paired vault is carried to another device in one of three ways. The vault's
own credential is a single `LG1-…` string that folds the vault id and its token
together, in an alphabet with no ambiguous characters and a check symbol, so a
mistyped code is refused before any network request rather than returning an
unexplained authentication failure. The connected device also renders that
string as a QR code to scan. For a device that is not to hand, it can issue a
short `PAIR-…` code that expires in ten minutes, works exactly once, and is
rate-limited against guessing — so the durable credential never has to be read
aloud or retyped.

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

## Screenshots in the documentation

The images under [`docs/images/`](docs/images) are generated, not captured by
hand:

```sh
pnpm screenshots
```

`tests/screenshots.spec.ts` seeds a fixed reading list, walks the screens and
writes every file. It does not run with `pnpm test` — it produces artifacts
rather than verdicts, and a screenshot that changes is news rather than a
failure. Review the diff, and commit the images with the change that caused
them.

Everything that could differ between machines is pinned in
`playwright.screenshots.config.ts`: locale and timezone, because dates render
through `toLocaleDateString`; the colour scheme; and the device scale factor.
Dates in the fixture are constants for the same reason. Regenerating on a
different machine should therefore produce no diff unless the interface
actually changed.

Panels are captured through the fragment anchors described below, so a crop
stays pointed at the right panel when the page around it is rearranged.

## Fragment anchors

Panels carry stable ids, so a link can land on one:
`/settings/datalets#storage`, `#switch-datalet`, `#copy-codes`, `#backup`,
`#sync`, and on Settings `#datalets`, `#schemas`, `#tabs`, `#theme`,
`#app-title`. The router scrolls to the target once it has rendered, which a
client-side router does not do on its own.

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
│                   backup, vault pairing and its QR, runtime safety, icons
├── hooks/          Shared metadata subscriptions and the settings singleton
├── pages/          Tab view plus the schema, tab and block builders
├── shapes/         ShEx metadata definitions and their generated ORM artifacts
└── utils/          localNgEngine (store, persistence, cross-tab, undo, labels),
                    dynamicSchema, remoteSyncEngine, runtimeHealth, blockGraph,
                    pairingCode, qrCode, tabRoutes
server/src/         HTTP/SSE ingest, the Redis accept and lifecycle scripts,
                    the sharded Neo4j materializer, pair codes, label bounding
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
