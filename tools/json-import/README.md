# JSON import

Turns a generic, multi-entity JSON document into a datalet — inferring a
schema (fields, types, references, tabs, blocks) from the data itself, rather
than requiring whoever writes the JSON to know anything about Datalet's own
schema/widget model.

## Why this exists, and why it works this way

The goal was letting an LLM (or a person) hand over some structured personal
data — a log, a tracker, a set of related records — and get a working datalet
out the other end, without either (a) making them learn Datalet's schema
editor well enough to hand-author records in its native shape, or (b) adding
new import UI to the app itself.

Two deliberate constraints shaped the design:

- **Backup/restore stays untouched.** It's a data-integrity/availability
  feature, not a place to bolt on unrelated functionality. This tool never
  modifies that code; it only produces a file in its existing, documented,
  hash-verified format (`LocalGraphBackup` - see the doc comments on
  `exportGraphBackup`/`importGraphBackup`/`snapshotPatches` in
  `src/utils/localNgEngine.ts`). You still open the file through the app's own
  unmodified **Manage datalets -> "Start an empty one" -> "Import backup"**
  buttons - there is no new UI.
- **No dependency on the app's internals.** This tool never imports from
  `src/`. The few pieces of internal convention it needs (id-minting shape,
  the backup hash algorithm, the `did:ng:z:user:<schemaId>` type prefix) are
  independently re-derived from the app's own doc comments, in
  `buildBackup.ts`, rather than imported - so a refactor of the ORM/sync
  engine can't silently break this tool, and this tool can't accidentally
  depend on something that was never meant to be reused outside the browser
  bundle.

## Usage

```bash
pnpm import:json <input.json> <output.json> [app title]
```

`[app title]` becomes the new datalet's display name (shown in the header);
if omitted, it defaults to the input file's own name, title-cased.

Then, in the app: **Settings -> Manage datalets -> "Start an empty one"**,
then in the Backup panel, **"Import backup"** and pick `<output.json>`.

## The input format (DSL1)

A JSON object keyed by entity name, each value an array of that entity's
records - similar to OpenAPI's `components.schemas` being a map of named
schemas, rather than one flat list of one record shape:

```json
{
  "recipes": [
    { "id": "r1", "name": "Sourdough loaf", "tags": ["baking", "bread"] }
  ],
  "batches": [
    {
      "_hints": { "recipeId": { "type": "reference", "entity": "recipes" } },
      "id": "b1",
      "recipeId": "r1",
      "date": "2026-09-13",
      "rating": 4,
      "notes": "Rose well overnight.",
      "ingredients": [
        { "name": "flour", "amount": 100, "unit": "g" }
      ]
    }
  ]
}
```

Full rules the producer (an LLM, typically) should follow:

1. **Every record in an entity's array has the same keys**, in the same
   shape, even when empty (`null`/`""` rather than omitting a key). `_hints`
   is the one exception - metadata, not a data field, so it only needs to
   appear on an entity's first record.
2. **Never change a field's shape between records** (string one time, object
   another). Ambiguity like this is flagged as a warning and falls back to
   plain text rather than being guessed at.
3. **A repeating array of objects becomes its own entity**, auto-promoted and
   linked back to its parent by a generated `__parentId` reference - use this
   for things that only ever belong to one parent (line items, ingredients).
   Prefer a real top-level entity instead when something might be referenced
   from more than one place.
4. **A single nested plain object flattens into dotted field names**
   (`location.city`, `location.country`).
5. **Values are written in their natural JSON type** - real dates, numbers,
   booleans - not pre-formatted display strings. Type is inferred from the
   value itself.
6. **`_hints`** on an entity's first record can mark a field as `"reference"`
   (naming the target entity - never inferred automatically, since a matching
   id is not evidence of an intended link) or `"currency"` (never inferred
   from a bare number, since nothing else distinguishes an amount from a
   quantity).
7. **Size**: browser `localStorage` has a hard ~5MB budget shared with
   everything else already in that browser. The CLI refuses to write a backup
   over 2MB, on the assumption that leaves reasonable headroom - there's no
   way to know from here how much headroom actually exists on the
   destination.

## What the inference heuristics do (DSL1 -> DSL2)

Per field, in order:

1. An explicit `_hints` entry always wins - never overridden by inference.
2. A field literally named `id` (case-insensitive) always stays plain text -
   it is an identifier, not data to be reformatted, even when its value
   happens to look like a date or a number.
3. Pattern/format detection: boolean, date (`date` vs `dateTime` by whether a
   time component is present), URL, email.
4. Low-cardinality detection: a string field with few distinct values across
   enough records (>=10 samples, <=6 distinct) becomes a dropdown/multiSelect
   enum. Below that sample size, it stays text rather than guessing from too
   little evidence.
5. Otherwise: plain text, or `longText` if any sampled value is long or
   multi-line.

Structural mapping to Datalet's own model
(`src/shapes/orm/metaShapes.typings.ts`): one `SchemaDef` + one `Tab` + one
data `Block` per entity, with `title`/`addButton`/`editDeleteActions` widgets
plus one field widget per property. A schema's `labelPropertyId` (how its
records are named wherever referenced) is chosen deliberately - the most
prose-like eligible field, or the field with the longest average content -
rather than left to the app's own "first eligible property in declared order"
fallback, which would otherwise frequently pick `id` now that `id` is always
text.

Everything that fails a confidence check - too few samples, a shape
disagreement, a mixed-type field, a reference that doesn't resolve, an
unrecognized entity name in a hint - degrades to a warning printed by the CLI
and a safe fallback (plain text, an unresolved/dropped reference), never a
crash and never a silent wrong guess.

## Files

- `types.ts` - DSL1 (input) and DSL2 (inferred model) types.
- `normalize.ts` - structural pass: nested arrays -> child entities, nested
  objects -> flattened field names.
- `infer.ts` - DSL1 -> DSL2: the type/cardinality heuristics above.
- `buildBackup.ts` - DSL2 -> the actual `LocalGraphBackup` file.
- `cli.ts` - entrypoint.
- `*.test.ts` - `node:test` unit tests for the heuristics and the record/hash
  building (`pnpm test:json-import`).

## Known gaps

- No UI affordance for reviewing the inferred schema before import - you get
  the CLI's warning list and the result once it's already in the app.
- `reference` and `currency` are the only hintable types; there is no general
  mechanism yet for a producer to override an inferred field's type when it
  disagrees with the heuristics for a reason the heuristics can't see.
- Auto-promoted child entities (`__parentId`) always get their own Tab, even
  when they'd read better as a nested block under their parent - a display
  polish item, not a correctness one.
