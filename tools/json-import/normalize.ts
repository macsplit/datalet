/**
 * Structural pass over a DSL1 document: turns nested arrays-of-objects into
 * their own child entities (auto-promoted, linked to their parent by row
 * index rather than a declared id - the producer never names these), and
 * flattens nested plain objects into dotted field names on their owning
 * entity. Type/cardinality inference happens afterwards, in infer.ts.
 */

import type { Hint, ImportDocument, JsonValue, RawRecord } from "./types";

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 8;

/** Name of the tool-generated back-reference field on an auto-promoted
 * child entity. Double-underscored so it can never collide with a field a
 * producer actually wrote. */
export const SYNTHETIC_PARENT_FIELD = "__parentId";

export interface RawNormalizedRecord {
  index: number;
  parentIndex?: number;
  values: Record<string, JsonValue>;
}

export interface RawNormalizedEntity {
  name: string;
  hints: Record<string, Hint>;
  records: RawNormalizedRecord[];
  parentEntity?: string;
}

function assertSafeKey(key: string): void {
  if (RESERVED_KEYS.has(key)) {
    throw new Error(`Field or entity name "${key}" is not allowed (reserved for JavaScript internals).`);
  }
}

function isPlainObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArrayOfPlainObjects(value: JsonValue): value is Array<{ [key: string]: JsonValue }> {
  return Array.isArray(value) && value.length > 0 && value.every(isPlainObject);
}

/**
 * Flattens one record's own fields (nested plain objects become dotted keys)
 * and peels off array-of-object fields into `out` as rows of a separate,
 * auto-promoted child entity, tagged with `parentIndex` so build.ts can wire
 * up the back-reference once real ids exist.
 */
function flattenRecord(
  record: RawRecord,
  entityNamePath: string,
  parentRecordIndex: number,
  out: Map<string, RawNormalizedEntity>,
  prefix: string,
  depth: number,
): Record<string, JsonValue> {
  if (depth > MAX_DEPTH) {
    throw new Error(`"${entityNamePath}" nests more than ${MAX_DEPTH} levels deep - flatten it in the source JSON first.`);
  }
  const values: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "_hints") continue;
    assertSafeKey(key);
    const flatKey = prefix ? `${prefix}.${key}` : key;

    if (isArrayOfPlainObjects(value)) {
      const childEntityName = `${entityNamePath}.${key}`;
      registerChildEntityRows(childEntityName, entityNamePath, value, parentRecordIndex, out, depth + 1);
      continue; // becomes its own entity, not a field on this one
    }
    if (Array.isArray(value)) {
      values[flatKey] = value; // array of scalars: kept as-is, typed later
      continue;
    }
    if (isPlainObject(value)) {
      Object.assign(
        values,
        flattenRecord(value as RawRecord, entityNamePath, parentRecordIndex, out, flatKey, depth + 1),
      );
      continue;
    }
    values[flatKey] = value;
  }
  return values;
}

/** All rows in one call belong to the same parent record (one array field on
 * one parent row), so every row gets that same `parentIndex`. */
function registerChildEntityRows(
  name: string,
  parentEntity: string,
  rows: Array<{ [key: string]: JsonValue }>,
  parentRecordIndex: number,
  out: Map<string, RawNormalizedEntity>,
  depth: number,
): void {
  const entity: RawNormalizedEntity = out.get(name) ?? { name, hints: {}, records: [], parentEntity };
  const hints = (rows[0] as RawRecord)?._hints;
  if (hints && entity.records.length === 0) entity.hints = { ...entity.hints, ...hints };
  let nextIndex = entity.records.length;
  for (const row of rows) {
    const values = flattenRecord(row as RawRecord, name, nextIndex, out, "", depth);
    entity.records.push({ index: nextIndex, parentIndex: parentRecordIndex, values });
    nextIndex += 1;
  }
  out.set(name, entity);
}

/** Walk a whole DSL1 document into a flat map of entity name -> its rows,
 * including every auto-promoted child entity discovered along the way. */
export function normalizeDocument(doc: ImportDocument): Map<string, RawNormalizedEntity> {
  const out = new Map<string, RawNormalizedEntity>();
  for (const [entityName, rawRecords] of Object.entries(doc)) {
    assertSafeKey(entityName);
    if (!Array.isArray(rawRecords)) {
      throw new Error(`Entity "${entityName}" must be an array of records.`);
    }
    if (out.has(entityName)) {
      throw new Error(`Entity name "${entityName}" collides with a nested field path of the same name.`);
    }
    const entity: RawNormalizedEntity = { name: entityName, hints: rawRecords[0]?._hints ?? {}, records: [] };
    rawRecords.forEach((row, i) => {
      const values = flattenRecord(row, entityName, i, out, "", 0);
      entity.records.push({ index: i, values });
    });
    out.set(entityName, entity);
  }
  return out;
}
