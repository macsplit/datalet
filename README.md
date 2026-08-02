# Local Graph UI Builder

A browser-based builder for defining data schemas and turning them into working
record-management screens. Schemas, navigation tabs, layouts, blocks, and field
widgets are stored as graph data and can be changed through the Settings UI.

The application runs entirely in the browser. It has no server component,
account system, wallet, API keys, or network dependency. Data is stored in the
current browser profile and synchronized between open tabs with
`BroadcastChannel`.

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
- Number
- Boolean
- Enum
- Required, optional, or multi-value cardinality

Enum fields can define an editable list of allowed values. Changes to a schema
produce a revised runtime shape while retaining the stable record type, so
existing records continue to load after fields or enum options change.

## Blocks and widgets

A tab contains an ordered tree of blocks:

- **Layout blocks** recursively arrange child blocks in a stack, row, or grid.
- **Data blocks** connect a schema to its records and rendering configuration.

Data blocks can contain these widgets:

- **Panel title** displays the block heading.
- **Add button** creates a record with schema-derived defaults.
- **Field** binds a schema field to a text, number, currency, dropdown,
  multi-select, or checkbox control.
- **Edit/delete actions** enables record editing and confirmed deletion.

New data blocks receive the standard title, add, edit/delete, and field widgets.
If a schema later gains fields, **Add missing fields** adds widgets for them.

## Storage and synchronization

All application data is held in the current browser profile using
`localStorage`. It persists across reloads and is synchronized between open
tabs for the same site.

Data is not remotely backed up, encrypted, or synchronized between devices.
Clearing the site's browser storage deletes the application data.

Persistence writes are coalesced during rapid edits. Invalid or excessive
updates, oversized local data, failing subscriptions, malformed block cycles,
and excessive block depth are stopped by runtime safety limits. Recoverable
problems appear in an on-screen error banner; render failures show a reload
screen instead of leaving the page unresponsive.

## Architecture

The app uses React, TanStack Router, an RDF shape ORM, and a browser-local graph
engine.

```text
src/
├── components/
│   ├── BlockRenderer.tsx       # Recursive graph-defined page renderer
│   ├── FieldWidget.tsx         # Field display and editing controls
│   ├── RecordCard.tsx          # Generic record editor
│   └── RuntimeSafety.tsx       # Error boundary and safety notifications
├── hooks/
│   ├── MetaStoreContext.tsx    # Shared metadata subscriptions
│   ├── useTabs.ts
│   ├── useBlocks.ts
│   ├── useWidgets.ts
│   ├── useSchemas.ts
│   ├── usePropertyDefs.ts
│   └── useSettings.ts
├── pages/
│   ├── TabPage.tsx
│   ├── SchemaListPage.tsx
│   ├── SchemaEditorPage.tsx
│   ├── TabsManagerPage.tsx
│   └── BlocksBuilderPage.tsx
├── shapes/
│   ├── shex/metaShapes.shex    # Metadata shape definitions
│   └── orm/metaShapes.*.ts     # Generated ORM artifacts
└── utils/
    ├── blockGraph.ts           # Bounded graph traversal
    ├── dynamicSchema.ts        # Runtime record-shape construction
    ├── localNgEngine.ts        # Browser persistence and synchronization
    ├── ngSession.ts            # Browser-local ORM session
    └── runtimeHealth.ts        # Runtime issue reporting and limits
```

## Metadata model

The builder stores five metadata types:

- `Tab`: a navigation destination.
- `Block`: a layout container or schema-backed data view.
- `Widget`: rendering and editing configuration for a data block.
- `SchemaDef`: a user-defined record type.
- `PropertyDef`: an ordered field belonging to a schema.

`buildShapeType()` converts a schema and its fields into a runtime ORM shape.
Generated records and builder metadata therefore use the same local graph
storage and live subscription mechanism.

## Regenerating ORM artifacts

After changing `src/shapes/shex/metaShapes.shex`, regenerate the TypeScript ORM
files with:

```bash
pnpm build:orm
```

## License

Licensed under either Apache-2.0 or MIT. See `LICENSE-APACHE2` and
`LICENSE-MIT`.
