// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * A local, browser-only NextGraph ORM engine.
 *
 * `@ng-org/orm` only needs two methods from its "ng" implementation to drive
 * `useShape`: `orm_start_graph` (subscribe to objects matching a shape/scope)
 * and `graph_orm_update` (receive patches from local edits). The real
 * NextGraph engine implements those over a wasm CRDT store synced through a
 * broker that requires a hosted wallet. This implementation instead persists
 * objects to localStorage and broadcasts changes to other subscriptions (and
 * other tabs, via BroadcastChannel) directly in the browser. No wallet, no
 * broker, no network connection of any kind.
 */

import { reportRuntimeIssue, RUNTIME_LIMITS } from "./runtimeHealth";

const STORAGE_KEY = "meta-ui-builder:ng-local-store";
const TYPE_PREDICATE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const BROADCAST_CHANNEL_NAME = "meta-ui-builder:ng-local-engine";

// One localStorage key per record (RECORD_KEY_PREFIX + id) plus a small
// index key listing known ids, replacing the old single-blob-under-
// STORAGE_KEY layout - see loadStore()/persistNow() below. `recordKey`
// always contains the literal ":record:" segment and INDEX_KEY never
// does, so no id value can ever collide with INDEX_KEY or the old blob
// key (STORAGE_KEY itself, still used only as a migration source).
const RECORD_KEY_PREFIX = `${STORAGE_KEY}:record:`;
const INDEX_KEY = `${STORAGE_KEY}:index`;
function recordKey(id: string): string {
  return RECORD_KEY_PREFIX + id;
}

const recordByteLengths = new Map<string, number>();
const dirtyIds = new Set<string>();
const UNDO_LIMIT = 50;
// A run of edits to one field is one undoable action. Every keystroke in a
// text input writes to the record, so without this an undo per keystroke is
// all a reader ever gets. The window is generous enough to span an ordinary
// typing pause but short enough that a deliberate second action (picking
// another enum value, toggling a checkbox again) starts its own entry.
const UNDO_COALESCE_MS = 1_200;
type UndoEntry = { patches: Patch[]; shapes: string[] };
const undoStack: UndoEntry[] = [];
let undoRunTarget: string | undefined;
let undoRunAt = 0;
const undoListeners = new Set<() => void>();
const undoAppliedListeners = new Set<() => void>();
let undoAppliedRevision = 0;
let lastUndoRecords: Store = {};
const expectedUndoEchoes = new Map<string, { signature: string; expiresAt: number }>();
let storedBytesTotal = 0;
let indexByteLength = 0;
let loadWasRejected = false;

function rejectStoredData(): Store {
  recordByteLengths.clear();
  dirtyIds.clear();
  storedBytesTotal = 0;
  indexByteLength = 0;
  loadWasRejected = true;
  return {};
}

type SchemaPredicate = {
  iri: string;
  dataTypes: Array<{ valType: string; literals?: string[] }>;
};
type Schema = Record<string, { iri: string; predicates: SchemaPredicate[] }>;
type ShapeType = { schema: Schema; shape: string };

export type OrmRecord = Record<string, unknown> & { "@id": string; "@graph": string };
export type Store = Record<string, OrmRecord>;

export type LocalGraphBackup = {
  format: "localgraph-backup";
  version: 1;
  exportedAt: string;
  graph: string;
  records: Array<{ key: string; record: OrmRecord }>;
};

export type Patch = {
  op: "add" | "remove";
  path: string;
  value?: unknown;
  type?: string;
  valType?: string;
};

type CrossTabSnapshots = Record<string, OrmRecord>;

type Subscription = {
  graphs: string[];
  subjects: string[];
  shapeType: ShapeType;
  callback: (message: unknown) => void;
};

/**
 * One-time migration from the old single-blob layout to the new
 * per-record one. Write-before-delete: every record + the index is
 * written and verified under the new scheme before the old blob key is
 * removed, so a failure partway through never loses data - the old blob
 * just stays behind as an unused backup and migration retries on the
 * next load. If both the old and new keys already exist (an interrupted
 * prior migration), this is a no-op: the new-format data is treated as
 * authoritative and the stale old key is left alone rather than forcibly
 * cleaned up, since it's harmless besides a little wasted quota.
 */
function runMigrationIfNeeded(): boolean {
  let oldRaw: string | null;
  let newIndexExists: boolean;
  try {
    oldRaw = localStorage.getItem(STORAGE_KEY);
    newIndexExists = localStorage.getItem(INDEX_KEY) !== null;
  } catch {
    return false;
  }
  if (oldRaw === null || newIndexExists) return true;

  let verified = false;
  try {
    if (oldRaw.length > RUNTIME_LIMITS.storedBytes) {
      reportRuntimeIssue(
        `Saved data is ${oldRaw.length.toLocaleString()} bytes; the safety limit is ${RUNTIME_LIMITS.storedBytes.toLocaleString()} bytes. Migration was stopped.`,
        "Local data safety circuit opened",
      );
      return false;
    }
    const parsed: unknown = JSON.parse(oldRaw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Saved browser data does not contain a valid object store.");
    }
    const oldStore = parsed as Store;
    const ids = Object.keys(oldStore);
    const serializedById = new Map(ids.map((id) => [id, JSON.stringify(oldStore[id])]));
    for (const [id, serialized] of serializedById) {
      localStorage.setItem(recordKey(id), serialized);
    }
    const indexStr = JSON.stringify(ids);
    localStorage.setItem(INDEX_KEY, indexStr);

    // Byte-for-byte read-back against what was just written (not a re-parse
    // - a re-parse would pass even if a write silently failed to persist).
    verified =
      localStorage.getItem(INDEX_KEY) === indexStr &&
      ids.every((id) => localStorage.getItem(recordKey(id)) === serializedById.get(id));
    if (!verified) {
      throw new Error("Migrated data did not verify against the original - keeping the old copy.");
    }
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch (error) {
    // If verification never completed, keep the old blob authoritative and
    // remove the new index so the next load retries. Per-record keys written
    // before the failure are harmless and will be overwritten by that retry.
    if (!verified) {
      try {
        localStorage.removeItem(INDEX_KEY);
      } catch {
        // The original data is still intact. A later load can retry once
        // storage access recovers.
      }
    }
    reportRuntimeIssue(error, "Local storage migration was paused");
    return false;
  }
}

function loadStore(): Store {
  recordByteLengths.clear();
  dirtyIds.clear();
  storedBytesTotal = 0;
  indexByteLength = 0;
  loadWasRejected = false;
  if (!runMigrationIfNeeded()) return rejectStoredData();

  let ids: string[];
  try {
    const rawIndex = localStorage.getItem(INDEX_KEY);
    if (rawIndex === null) return {};
    indexByteLength = rawIndex.length;
    storedBytesTotal = indexByteLength;
    if (storedBytesTotal > RUNTIME_LIMITS.storedBytes) {
      reportRuntimeIssue(
        `Saved data exceeds the safety limit of ${RUNTIME_LIMITS.storedBytes.toLocaleString()} bytes. Loading was stopped.`,
        "Local data safety circuit opened",
      );
      return rejectStoredData();
    }
    const parsedIndex: unknown = JSON.parse(rawIndex);
    if (
      !Array.isArray(parsedIndex) ||
      !parsedIndex.every((id) => typeof id === "string") ||
      new Set(parsedIndex).size !== parsedIndex.length
    ) {
      throw new Error("Saved browser data index is not a valid id list.");
    }
    ids = parsedIndex;
  } catch (error) {
    reportRuntimeIssue(error, "Saved browser data could not be loaded");
    return rejectStoredData();
  }

  const nextStore: Store = {};
  for (const id of ids) {
    let raw: string | null;
    try {
      raw = localStorage.getItem(recordKey(id));
    } catch (error) {
      reportRuntimeIssue(error, "Saved browser data could not be loaded");
      return rejectStoredData();
    }
    if (raw === null) continue; // index says it exists but the record is missing - drop it, self-heals on next flush
    if (storedBytesTotal + raw.length > RUNTIME_LIMITS.storedBytes) {
      reportRuntimeIssue(
        `Saved data exceeds the safety limit of ${RUNTIME_LIMITS.storedBytes.toLocaleString()} bytes. Loading was stopped.`,
        "Local data safety circuit opened",
      );
      return rejectStoredData();
    }
    try {
      nextStore[id] = JSON.parse(raw) as OrmRecord;
      recordByteLengths.set(id, raw.length);
      storedBytesTotal += raw.length;
    } catch (error) {
      reportRuntimeIssue(error, "One saved record could not be loaded and was skipped");
    }
  }
  return nextStore;
}

let store: Store = loadStore();
const USER_TYPE_PREFIX = "did:ng:z:user:";
const labelPropertyNameCache = new Map<string, string | undefined>();

function readableLabelValue(value: unknown): string {
  const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : [value];
  return values
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

function automaticLabelPropertyName(graph: string, schemaId: string): string | undefined {
  const cacheKey = `${graph}|${schemaId}`;
  if (labelPropertyNameCache.has(cacheKey)) return labelPropertyNameCache.get(cacheKey);
  const property = Object.values(store)
    .filter(
      (record) =>
        record["@graph"] === graph &&
        record["@type"] === "did:ng:z:PropertyDef" &&
        record.schemaId === schemaId &&
        (record.dataType === "did:ng:z:text" || record.dataType === "did:ng:z:enum"),
    )
    .sort(
      (left, right) =>
        Number(left.order ?? 0) - Number(right.order ?? 0) || left["@id"].localeCompare(right["@id"]),
    )[0]?.name;
  const name = typeof property === "string" ? property : undefined;
  labelPropertyNameCache.set(cacheKey, name);
  return name;
}

/**
 * Resolve a stored record id to the schema-configured display label without
 * opening an ORM subscription. The target record, schema, and explicitly
 * selected PropertyDef are direct store lookups. Legacy schemas without a
 * selection use a cached scan for their first ordered text-or-enum property.
 * A label edited elsewhere becomes visible when its consumer next renders;
 * this intentionally is not a reactive subscription.
 */
export function lookupRecordLabel(graph: string, id: string): string {
  if (!graph || !id) return id;
  const record = store[`${graph}|${id}`];
  const rawType = record?.["@type"];
  const type = Array.isArray(rawType) ? rawType[0] : rawType;
  if (!record || typeof type !== "string" || !type.startsWith(USER_TYPE_PREFIX)) return id;

  const schemaId = type.slice(USER_TYPE_PREFIX.length);
  const schema = store[`${graph}|${schemaId}`];
  if (!schema) return id;
  let propertyName: string | undefined;
  if (typeof schema.labelPropertyId === "string") {
    const property = store[`${graph}|${schema.labelPropertyId}`];
    if (
      property?.["@type"] === "did:ng:z:PropertyDef" &&
      property.schemaId === schemaId &&
      (property.dataType === "did:ng:z:text" || property.dataType === "did:ng:z:enum") &&
      typeof property.name === "string"
    ) {
      propertyName = property.name;
    }
  }
  propertyName ??= automaticLabelPropertyName(graph, schemaId);
  return propertyName ? readableLabelValue(record[propertyName]) || id : id;
}
// ORM signals receive the records in `store` by reference and mutate them
// before reporting a local patch. Keep an engine-owned snapshot so inverse
// patches can still see the value that preceded that mutation.
let undoSnapshotStore = JSON.parse(JSON.stringify(store)) as Store;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let persistenceDisabled = loadWasRejected;

/**
 * Incremental flush: only the records touched since the last flush
 * (`dirtyIds`) are re-serialized and written, not the whole store - see
 * docs/build-history.md's incremental-persistence section for why. Two
 * passes: the first computes the projected total size and every write
 * without touching localStorage, so the existing all-or-nothing safety
 * cap (nothing gets written if the projected total would exceed
 * RUNTIME_LIMITS.storedBytes) still holds exactly as before; the second
 * pass commits. One honest gap versus the old single-write version: pass 2
 * is multiple localStorage calls, not one, so a *native* browser quota
 * error mid-commit (distinct from - and expected to be caught well before
 * by - our own RUNTIME_LIMITS.storedBytes check above) could leave a
 * partial write. Accepted as a rare, defensive-only edge case given the
 * margin RUNTIME_LIMITS.storedBytes already leaves below real browser caps.
 */
function persistNow() {
  if (persistenceDisabled) return;
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = undefined;
  if (dirtyIds.size === 0) return;

  try {
    const writes = new Map<string, string | null>(); // null = delete
    let projected = storedBytesTotal;
    let indexChanged = false;
    for (const id of dirtyIds) {
      const oldLen = recordByteLengths.get(id);
      const record = store[id];
      if (record === undefined) {
        if (oldLen !== undefined) {
          writes.set(id, null);
          projected -= oldLen;
          indexChanged = true;
        }
        // else: added then removed again before ever being flushed - nothing to do.
      } else {
        const serialized = JSON.stringify(record);
        writes.set(id, serialized);
        projected += serialized.length - (oldLen ?? 0);
        if (oldLen === undefined) indexChanged = true;
      }
    }

    let nextIndexStr: string | undefined;
    if (indexChanged) {
      const nextIds = new Set(recordByteLengths.keys());
      for (const [id, value] of writes) {
        if (value === null) nextIds.delete(id);
        else nextIds.add(id);
      }
      nextIndexStr = JSON.stringify([...nextIds]);
      projected += nextIndexStr.length - indexByteLength;
    }

    if (projected > RUNTIME_LIMITS.storedBytes) {
      persistenceDisabled = true;
      throw new Error(
        `Local data reached ${projected.toLocaleString()} bytes. Saving has been paused to keep the page responsive.`,
      );
    }

    for (const [id, serialized] of writes) {
      if (serialized === null) {
        localStorage.removeItem(recordKey(id));
        recordByteLengths.delete(id);
      } else {
        localStorage.setItem(recordKey(id), serialized);
        recordByteLengths.set(id, serialized.length);
      }
    }
    if (nextIndexStr !== undefined) {
      localStorage.setItem(INDEX_KEY, nextIndexStr);
      indexByteLength = nextIndexStr.length;
    }
    storedBytesTotal = projected;
    dirtyIds.clear();
  } catch (error) {
    persistenceDisabled = true;
    reportRuntimeIssue(error, "Browser persistence was paused");
  }
}

/** Coalesce rapid field edits into one incremental (touched-records-only) persist. */
function schedulePersist() {
  if (persistenceDisabled || persistTimer !== undefined) return;
  persistTimer = setTimeout(persistNow, 120);
}

type LocalPatchListener = (patches: Patch[], shape: string) => void;
const localPatchListeners = new Set<LocalPatchListener>();

/**
 * Notified with every locally-applied patch batch, once per affected shape.
 * src/utils/remoteSyncEngine.ts hooks in here to forward local edits to the
 * sync server without this module needing to know sync exists.
 */
export function onLocalPatch(listener: LocalPatchListener): () => void {
  localPatchListeners.add(listener);
  return () => localPatchListeners.delete(listener);
}

const subscriptions = new Map<string, Subscription>();
const recentlyClosedSubscriptions = new Map<
  string,
  { shape: string; expiresAt: number }
>();

function retireSubscription(subscriptionId: string) {
  const now = Date.now();
  for (const [closedId, entry] of recentlyClosedSubscriptions) {
    if (entry.expiresAt < now) recentlyClosedSubscriptions.delete(closedId);
  }
  const subscription = subscriptions.get(subscriptionId);
  if (subscription) {
    recentlyClosedSubscriptions.set(subscriptionId, {
      shape: subscription.shapeType.shape,
      // ORM edits are microtask-batched and its own close is delayed. Keep
      // just enough identity to accept a legitimate final commit.
      expiresAt: now + 2_000,
    });
    if (recentlyClosedSubscriptions.size > 256) {
      const oldestId = recentlyClosedSubscriptions.keys().next().value;
      if (oldestId) recentlyClosedSubscriptions.delete(oldestId);
    }
  }
  subscriptions.delete(subscriptionId);
}

function recentlyClosedShape(subscriptionId: string): string | undefined {
  const entry = recentlyClosedSubscriptions.get(subscriptionId);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    recentlyClosedSubscriptions.delete(subscriptionId);
    return undefined;
  }
  return entry.shape;
}

const channel =
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(BROADCAST_CHANNEL_NAME)
    : undefined;

function patchRootKey(patch: Patch): string | undefined {
  if (!patch.path.startsWith("/")) return undefined;
  return decodePathSegment(patch.path.slice(1).split("/", 1)[0]);
}

function encodePathSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function snapshotPatches(key: string, record: OrmRecord): Patch[] {
  const root = `/${encodePathSegment(key)}`;
  const patches: Patch[] = [
    { op: "add", path: root, value: {} },
    // The ORM patch applier uses this order to recognize and pre-seed a new
    // object in a Set before applying its remaining properties.
    { op: "add", path: `${root}/@graph`, value: record["@graph"] },
    { op: "add", path: `${root}/@id`, value: record["@id"] },
  ];
  for (const [property, value] of Object.entries(record)) {
    if (property === "@graph" || property === "@id") continue;
    const path = `${root}/${encodePathSegment(property)}`;
    if (Array.isArray(value)) {
      patches.push({ op: "add", path, value, type: "set", valType: "set" });
    } else {
      patches.push({ op: "add", path, value });
    }
  }
  return patches;
}

function inversePatchesFor(patches: Patch[]): Patch[] {
  const byKey = new Map<string, Patch[]>();
  for (const patch of patches) {
    const key = patchRootKey(patch);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), patch]);
  }
  return [...byKey].flatMap(([key, keyPatches]) => {
    const previous = undoSnapshotStore[key];
    if (!previous) {
      return [{ op: "remove" as const, path: `/${encodePathSegment(key)}` }];
    }
    const snapshot = JSON.parse(JSON.stringify(previous)) as OrmRecord;
    const root = `/${encodePathSegment(key)}`;
    if (keyPatches.some((patch) => patch.path === root)) {
      return [
        { op: "remove" as const, path: root },
        ...snapshotPatches(key, snapshot),
      ];
    }
    const properties = [...new Set(keyPatches.flatMap((patch) => {
      const parts = patch.path.slice(1).split("/").filter(Boolean).map(decodePathSegment);
      return parts[1] ? [parts[1]] : [];
    }))];
    return properties.flatMap((property) => {
      const path = `${root}/${encodePathSegment(property)}`;
      if (!Object.prototype.hasOwnProperty.call(snapshot, property)) {
        return [{ op: "remove" as const, path }];
      }
      const value = snapshot[property];
      return [
        { op: "remove" as const, path },
        {
          op: "add" as const,
          path,
          value,
          ...(Array.isArray(value) ? { type: "set", valType: "set" } : {}),
        },
      ];
    });
  });
}

function sameStoredValue(current: unknown, next: unknown): boolean {
  if (current === next) return true;
  if (current === undefined || next === undefined) return false;
  if (typeof current !== "object" || typeof next !== "object") return false;
  return JSON.stringify(current) === JSON.stringify(next);
}

/**
 * Whether `patch` asks for a value the engine has already recorded.
 *
 * Two live subscriptions over the same records is a routine transient state:
 * the ORM tears an old shape's signal down well after the replacement opens,
 * and the old signal keeps reporting edits meanwhile. Both of them observe
 * the same mutable record branch, so each one sees the other's write, reports
 * it as a fresh local edit, and rebroadcasts it -- an exchange that never
 * settles because the value is already what both sides want. Ignoring writes
 * that change nothing ends it after a single hop.
 *
 * The comparison is against `undoSnapshotStore`, not `store`: ORM signal
 * objects share `store`'s record branches, so an edit has already mutated
 * `store` by the time it is reported here and every real write would look
 * inert. The shadow copy only moves when the engine itself applies a patch.
 */
function isNoOpPatch(patch: Patch): boolean {
  const key = patchRootKey(patch);
  if (!key) return false;
  const record = undoSnapshotStore[key];
  const parts = patch.path.slice(1).split("/").filter(Boolean).map(decodePathSegment);
  // A whole-record patch: only a remove of an already-absent record is inert.
  // Creations are left to omitDuplicateCreations, which knows about replays.
  if (parts.length === 1) return patch.op === "remove" && record === undefined;
  if (parts.length !== 2 || record === undefined) return false;
  const property = parts[1];
  const current = record[property];
  if (patch.type === "set" || patch.valType === "set") {
    if (!Array.isArray(current)) return false;
    const incoming = Array.isArray(patch.value)
      ? patch.value
      : patch.value === undefined
        ? []
        : [patch.value];
    return patch.op === "add"
      ? incoming.every((value) => current.includes(value))
      : incoming.every((value) => !current.includes(value));
  }
  if (patch.op === "remove") {
    return !Object.prototype.hasOwnProperty.call(record, property);
  }
  return sameStoredValue(current, patch.value);
}

/**
 * Whether the batch as a whole would change nothing. Judged on the batch's
 * net effect rather than patch by patch: an undo sends `remove` then `add`
 * for one field, and dropping only the half that matches would turn a
 * restore into a deletion.
 */
function batchIsInert(patches: Patch[]): boolean {
  // Within a batch the last patch for a path wins, exactly as
  // applyPatchesToStore applies them in order. Set patches accumulate
  // instead of replacing, so they are judged individually.
  const net = new Map<string, Patch>();
  for (const patch of patches) {
    if (patch.type === "set" || patch.valType === "set") {
      if (!isNoOpPatch(patch)) return false;
      continue;
    }
    net.set(patch.path, patch);
  }
  return [...net.values()].every(isNoOpPatch);
}

function isAutomaticSingletonCreation(patches: Patch[]): boolean {
  const keys = [...new Set(
    patches.map(patchRootKey).filter((key): key is string => Boolean(key)),
  )];
  return keys.length > 0 && keys.every((key) => {
    if (undoSnapshotStore[key]) return false;
    const subject = identityFromStoreKey(key)["@id"];
    return subject === "did:ng:z:HomeTab" || subject === "did:ng:z:SettingsSingleton";
  });
}

function emitUndoChange() {
  for (const listener of undoListeners) listener();
}

function clearRestoredUndoValues(patches: Patch[]) {
  const keys = new Set(
    patches.map(patchRootKey).filter((key): key is string => Boolean(key)),
  );
  if (![...keys].some((key) => lastUndoRecords[key])) return;
  lastUndoRecords = Object.fromEntries(
    Object.entries(lastUndoRecords).filter(([key]) => !keys.has(key)),
  ) as Store;
  undoAppliedRevision += 1;
  for (const listener of undoAppliedListeners) listener();
}

export function clearUndoDisplayForRecord(key: string) {
  if (!lastUndoRecords[key]) return;
  lastUndoRecords = Object.fromEntries(
    Object.entries(lastUndoRecords).filter(([candidate]) => candidate !== key),
  ) as Store;
  undoAppliedRevision += 1;
  for (const listener of undoAppliedListeners) listener();
}

/**
 * The single record property a patch batch edits, or `undefined` if the batch
 * is anything else — a creation or removal, a multi-property write, or a set
 * field. Set fields are excluded deliberately: each checkbox in a multi-select
 * is its own deliberate action, unlike the characters of a typed word.
 */
function singleFieldTarget(patches: Patch[]): string | undefined {
  const targets = new Set<string>();
  for (const patch of patches) {
    if (patch.type === "set" || patch.valType === "set") return undefined;
    const key = patchRootKey(patch);
    if (!key) return undefined;
    const parts = patch.path.slice(1).split("/").filter(Boolean).map(decodePathSegment);
    const property = parts[1];
    if (parts.length !== 2 || !property || property === "@id" || property === "@graph") {
      return undefined;
    }
    targets.add(`${key}|${property}`);
    if (targets.size > 1) return undefined;
  }
  return targets.size === 1 ? [...targets][0] : undefined;
}

function pushUndo(entry: UndoEntry, target: string | undefined) {
  const now = Date.now();
  const continuesRun =
    target !== undefined &&
    target === undoRunTarget &&
    now - undoRunAt < UNDO_COALESCE_MS &&
    undoStack.length > 0;
  undoRunTarget = target;
  undoRunAt = now;
  if (continuesRun) {
    // The entry already on top restores the value from before the run began,
    // which is what undoing the whole edit means. Only its origin shapes need
    // widening, in case the run crossed a subscription boundary.
    const top = undoStack[undoStack.length - 1];
    top.shapes = [...new Set([...top.shapes, ...entry.shapes])];
    emitUndoChange();
    return;
  }
  undoStack.push(entry);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  emitUndoChange();
}

export function subscribeUndo(listener: () => void) {
  undoListeners.add(listener);
  return () => {
    undoListeners.delete(listener);
  };
}

export function subscribeUndoApplied(listener: () => void) {
  undoAppliedListeners.add(listener);
  return () => {
    undoAppliedListeners.delete(listener);
  };
}

export function getUndoAppliedRevision(): number {
  return undoAppliedRevision;
}

export function getLastUndoRecords(): Store {
  return lastUndoRecords;
}

export function getCanUndoSnapshot(): boolean {
  return undoStack.length > 0;
}

export function undoLastLocalChange(): boolean {
  // Whatever run was open is over: the next edit must not merge into the
  // entry now exposed underneath the one being undone.
  undoRunTarget = undefined;
  const entry = undoStack.pop();
  if (!entry) return false;
  if (!validPatchBatch(entry.patches, "undo update")) {
    emitUndoChange();
    return false;
  }
  try {
    applyPatchesToStore(entry.patches);
    applyPatchesToStore(entry.patches, undoSnapshotStore, false);
  } catch (error) {
    reportRuntimeIssue(error, "Undo was stopped");
    emitUndoChange();
    return false;
  }
  schedulePersist();
  const touchedKeys = [...new Set(
    entry.patches.map(patchRootKey).filter((key): key is string => Boolean(key)),
  )];
  for (const shape of entry.shapes) {
    broadcastToLocalSubscriptions(entry.patches, undefined, shape, true);
    try {
      postCrossTabPatches(entry.patches, shape);
    } catch (error) {
      reportRuntimeIssue(error, "Cross-tab synchronization was paused", "warning");
    }
    for (const listener of localPatchListeners) listener(entry.patches, shape);
  }
  // ORM subscriptions share mutable record branches with this store. Let the
  // inverse patch finish traversing those branches before taking the immutable
  // display snapshot used to reset optimistic field controls.
  lastUndoRecords = Object.fromEntries(
    touchedKeys.flatMap((key) => store[key]
      ? [[key, JSON.parse(JSON.stringify(store[key])) as OrmRecord]]
      : []),
  ) as Store;
  undoAppliedRevision += 1;
  for (const listener of undoAppliedListeners) listener();
  emitUndoChange();
  return true;
}

function affectedSnapshots(patches: Patch[]): CrossTabSnapshots {
  const snapshots = Object.create(null) as CrossTabSnapshots;
  for (const patch of patches) {
    const key = patchRootKey(patch);
    if (key && store[key]) snapshots[key] = store[key];
  }
  return snapshots;
}

function postCrossTabPatches(patches: Patch[], shape: string) {
  channel?.postMessage({ patches, shape, snapshots: affectedSnapshots(patches) });
}

function validSnapshots(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > RUNTIME_LIMITS.patchBatch) return false;
  const valid = entries.every(([key, record]) => {
    const typedRecord = record as OrmRecord;
    return (
      key.length <= 16_384 &&
      record !== null &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      typeof typedRecord["@id"] === "string" &&
      typeof typedRecord["@graph"] === "string" &&
      key === `${typedRecord["@graph"]}|${typedRecord["@id"]}`
    );
  });
  if (!valid) return false;
  try {
    return JSON.stringify(value).length <= RUNTIME_LIMITS.storedBytes;
  } catch {
    return false;
  }
}

function recoverMissedCreations(
  patches: Patch[],
  snapshots: CrossTabSnapshots | undefined,
): Patch[] {
  if (!snapshots) return patches;
  const missing = new Set(
    patches.map(patchRootKey).filter((key): key is string => Boolean(key && !store[key])),
  );
  if (missing.size === 0) return patches;

  const recovered = new Set<string>();
  const fullPatches: Patch[] = [];
  for (const key of missing) {
    const record = snapshots[key];
    if (!record) continue;
    recovered.add(key);
    fullPatches.push(...snapshotPatches(key, record));
  }
  if (fullPatches.length === 0) return patches;
  const untouched = patches.filter((patch) => {
    const key = patchRootKey(patch);
    return !key || !recovered.has(key);
  });
  const effective = [...untouched, ...fullPatches];
  return effective.length <= RUNTIME_LIMITS.patchBatch ? effective : patches;
}

/**
 * A Set is identity-keyed: adding an object whose graph+subject already exists
 * must be insert-only. This also prevents a delayed bootstrap from another tab
 * overwriting edits that arrived while the ORM was still establishing its
 * subscription and draining the queued create batch.
 */
function omitDuplicateCreations(patches: Patch[]): Patch[] {
  const duplicates = new Set<string>();
  for (const patch of patches) {
    const key = patchRootKey(patch);
    if (
      key &&
      store[key] &&
      patch.path === `/${encodePathSegment(key)}` &&
      patch.op === "add" &&
      patch.value !== null &&
      typeof patch.value === "object"
    ) {
      duplicates.add(key);
    }
  }
  if (duplicates.size === 0) return patches;
  return patches.filter((patch) => {
    const key = patchRootKey(patch);
    return !key || !duplicates.has(key);
  });
}

/**
 * Apply patches that originated outside this store's own call path (another
 * tab via BroadcastChannel, or the remote sync server) and notify local
 * subscriptions, exactly as a local edit would.
 */
function applyExternalPatches(
  patches: Patch[],
  shape: string,
  relayToTabs: boolean,
  snapshots?: CrossTabSnapshots,
) {
  patches = omitDuplicateCreations(patches);
  if (patches.length === 0) return;
  clearRestoredUndoValues(patches);
  const effectivePatches = recoverMissedCreations(patches, snapshots);
  try {
    applyPatchesToStore(effectivePatches);
    applyPatchesToStore(effectivePatches, undoSnapshotStore, false);
  } catch (error) {
    reportRuntimeIssue(error, "An external data update was stopped");
    return;
  }
  schedulePersist();
  broadcastToLocalSubscriptions(effectivePatches, undefined, shape);
  if (relayToTabs) {
    try {
      postCrossTabPatches(effectivePatches, shape);
    } catch (error) {
      reportRuntimeIssue(error, "Cross-tab synchronization was paused", "warning");
    }
  }
}

function onChannelMessage(event: MessageEvent) {
  const payload = event.data as
    | {
        patches?: unknown;
        shape?: string;
        snapshots?: unknown;
        snapshotGraph?: unknown;
        snapshotRecords?: unknown;
      }
    | null;
  if (
    payload &&
    (payload.snapshotGraph !== undefined || payload.snapshotRecords !== undefined)
  ) {
    if (typeof payload.snapshotGraph !== "string") {
      reportRuntimeIssue(
        "Ignored a cross-tab snapshot with no graph identity.",
        "Cross-tab synchronization safety circuit opened",
        "warning",
      );
      return;
    }
    reconcileGraphSnapshotInternal(
      payload.snapshotGraph,
      payload.snapshotRecords,
      false,
    );
    return;
  }
  if (!payload || !validPatchBatch(payload.patches, "cross-tab update")) return;
  if (typeof payload.shape !== "string") {
    reportRuntimeIssue(
      "Ignored a cross-tab update with no shape identity.",
      "Cross-tab synchronization safety circuit opened",
      "warning",
    );
    return;
  }
  if (!validSnapshots(payload.snapshots)) {
    reportRuntimeIssue(
      "Ignored a cross-tab update with malformed record snapshots.",
      "Cross-tab synchronization safety circuit opened",
      "warning",
    );
    return;
  }
  // Don't relay back onto the channel: BroadcastChannel already fans this
  // message out to every other tab directly, so re-posting would just echo.
  applyExternalPatches(
    payload.patches as Patch[],
    payload.shape,
    false,
    payload.snapshots as CrossTabSnapshots | undefined,
  );
}

/**
 * Apply a patch batch received from the remote sync server
 * (src/utils/remoteSyncEngine.ts) to the local store, notify local
 * subscriptions, and relay it to other open tabs of this browser — a remote
 * update only reaches one tab's EventSource connection, so it has to be
 * forwarded locally the same way a same-tab edit already is.
 */
export function applyRemoteSyncPatches(patches: Patch[], shape: string): boolean {
  if (!validPatchBatch(patches, "remote sync update")) return false;
  applyExternalPatches(patches, shape, true);
  return true;
}

function validGraphSnapshot(graph: string, value: unknown): value is Store {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > RUNTIME_LIMITS.graphNodes) return false;
  const valid = entries.every(([key, record]) => {
    const typed = record as OrmRecord;
    return (
      key.length <= 16_384 &&
      record !== null &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      typeof typed["@id"] === "string" &&
      typed["@graph"] === graph &&
      key === `${graph}|${typed["@id"]}`
    );
  });
  if (!valid) return false;
  try {
    return JSON.stringify(value).length <= RUNTIME_LIMITS.storedBytes;
  } catch {
    return false;
  }
}

function recordMatchesSubscription(record: OrmRecord, sub: Subscription): boolean {
  return (
    graphMatches(record["@graph"], sub.graphs) &&
    subjectMatches(record["@id"], sub.subjects) &&
    typeMatches(record, sub.shapeType)
  );
}

function reconcileGraphSnapshotInternal(
  graph: string,
  value: unknown,
  relayToTabs: boolean,
): boolean {
  if (!validGraphSnapshot(graph, value)) {
    reportRuntimeIssue(
      "Ignored an invalid or oversized remote snapshot.",
      "Remote sync snapshot safety circuit opened",
      "warning",
    );
    return false;
  }
  const records = value as Store;
  const previous = Object.fromEntries(
    Object.entries(store).filter(([, record]) => record["@graph"] === graph),
  ) as Store;
  const nextEntries = [
    ...Object.entries(store).filter(([, record]) => record["@graph"] !== graph),
    ...Object.entries(records),
  ];
  const projectedBytes =
    JSON.stringify(nextEntries.map(([key]) => key)).length +
    nextEntries.reduce((total, [, record]) => total + JSON.stringify(record).length, 0);
  if (projectedBytes > RUNTIME_LIMITS.storedBytes) {
    reportRuntimeIssue(
      `The reconciled browser data needs ${projectedBytes.toLocaleString()} bytes; the safety limit is ${RUNTIME_LIMITS.storedBytes.toLocaleString()} bytes.`,
      "Remote sync snapshot safety circuit opened",
      "warning",
    );
    return false;
  }
  const replacementPatches: Patch[] = [
    ...Object.keys(previous).map((key) => ({
      op: "remove" as const,
      path: `/${encodePathSegment(key)}`,
    })),
    ...Object.entries(records).flatMap(([key, record]) => snapshotPatches(key, record)),
  ];

  try {
    applyPatchesToStore(replacementPatches);
    applyPatchesToStore(replacementPatches, undoSnapshotStore, false);
  } catch (error) {
    reportRuntimeIssue(error, "Remote sync snapshot reconciliation failed", "warning");
    return false;
  }
  schedulePersist();

  // A flat server snapshot has no shape identity. Each mounted subscription
  // already has that information, so derive its before/after membership here
  // and replace only the records belonging to that shape and scope.
  for (const [subscriptionId, sub] of [...subscriptions]) {
    const oldMatches = Object.entries(previous)
      .filter(([, record]) => recordMatchesSubscription(record, sub));
    const newMatches = Object.entries(records)
      .filter(([, record]) => recordMatchesSubscription(record, sub));
    const patches: Patch[] = [
      ...oldMatches.map(([key]) => ({
        op: "remove" as const,
        path: `/${encodePathSegment(key)}`,
      })),
      ...newMatches.flatMap(([key, record]) => snapshotPatches(key, record)),
    ];
    if (patches.length === 0) continue;
    try {
      sub.callback({ V0: { GraphOrmUpdate: patches } });
    } catch (error) {
      retireSubscription(subscriptionId);
      reportRuntimeIssue(error, "A failing live-data subscription was disconnected");
    }
  }

  if (relayToTabs) {
    try {
      channel?.postMessage({ snapshotGraph: graph, snapshotRecords: records });
    } catch (error) {
      reportRuntimeIssue(error, "Cross-tab snapshot synchronization was paused", "warning");
    }
  }
  return true;
}

/** Replace one graph from a remote snapshot without reloading the page. */
export function reconcileGraphSnapshot(graph: string, records: Store): boolean {
  return reconcileGraphSnapshotInternal(graph, records, true);
}

/** Flush pending record writes before an operation that is about to reload the page. */
export function flushLocalPersistence() {
  persistNow();
}

/**
 * Wholesale-replace one graph's records with a server snapshot and reload.
 * Used when a client's resume cursor has fallen outside the sync server's
 * retained patch log. A reload is simpler and more robust than re-targeting
 * every open subscription from a flat snapshot payload, which carries record
 * data but not shape identity — after reload, each subscription's normal
 * startup path recomputes its own matching records from the updated store.
 */
export function replaceGraphAndReload(graph: string, records: Store) {
  // Mutates `store` directly rather than via applyPatchesToStore, so it
  // must mark its own touched ids dirty - persistNow() only flushes what's
  // in dirtyIds, and this function calls it directly right below.
  for (const key of Object.keys(store)) {
    if (store[key]?.["@graph"] === graph && !(key in records)) {
      delete store[key];
      delete undoSnapshotStore[key];
      dirtyIds.add(key);
    }
  }
  for (const [key, record] of Object.entries(records)) {
    store[key] = record;
    undoSnapshotStore[key] = JSON.parse(JSON.stringify(record)) as OrmRecord;
    dirtyIds.add(key);
  }
  persistNow();
  window.location.reload();
}

/** Create a portable backup of one graph, including builder metadata. */
export function exportGraphBackup(graph: string): LocalGraphBackup {
  return {
    format: "localgraph-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    graph,
    records: Object.entries(store)
      .filter(([, record]) => record["@graph"] === graph)
      .map(([key, record]) => ({ key, record: JSON.parse(JSON.stringify(record)) as OrmRecord })),
  };
}

/**
 * Validate and restore a portable graph backup onto this browser's active
 * graph. Graph-qualified subject keys are remapped along with each record's
 * `@graph`, so a backup remains usable in a fresh browser profile whose local
 * session id differs from the exporter.
 */
export function importGraphBackup(targetGraph: string, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The selected file is not a Local Graph backup.");
  }
  const candidate = value as Partial<LocalGraphBackup>;
  if (
    candidate.format !== "localgraph-backup" ||
    candidate.version !== 1 ||
    typeof candidate.graph !== "string" ||
    !Array.isArray(candidate.records)
  ) {
    throw new Error("The selected file uses an unsupported backup format or version.");
  }
  if (candidate.records.length > RUNTIME_LIMITS.graphNodes) {
    throw new Error(
      `The backup contains ${candidate.records.length.toLocaleString()} records; the safety limit is ${RUNTIME_LIMITS.graphNodes.toLocaleString()}.`,
    );
  }

  const restored = Object.create(null) as Store;
  const sourcePrefix = `${candidate.graph}|`;
  const targetPrefix = `${targetGraph}|`;
  for (const entry of candidate.records) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("The backup contains a malformed record entry.");
    }
    const { key, record } = entry as { key?: unknown; record?: unknown };
    if (
      typeof key !== "string" ||
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      typeof (record as OrmRecord)["@id"] !== "string" ||
      typeof (record as OrmRecord)["@graph"] !== "string"
    ) {
      throw new Error("The backup contains a malformed graph record.");
    }
    if (
      !key.startsWith(sourcePrefix) ||
      (record as OrmRecord)["@graph"] !== candidate.graph ||
      key !== `${sourcePrefix}${(record as OrmRecord)["@id"]}`
    ) {
      throw new Error("The backup contains a record outside its declared graph.");
    }
    const nextKey = targetPrefix + key.slice(sourcePrefix.length);
    if (nextKey === "__proto__" || nextKey === "prototype" || nextKey === "constructor") {
      throw new Error("The backup contains an unsafe record key.");
    }
    if (nextKey in restored) throw new Error("The backup contains duplicate record keys.");
    restored[nextKey] = { ...(record as OrmRecord), "@graph": targetGraph };
  }

  const nextEntries = [
    ...Object.entries(store).filter(([, record]) => record["@graph"] !== targetGraph),
    ...Object.entries(restored),
  ];
  const projectedBytes =
    JSON.stringify(nextEntries.map(([key]) => key)).length +
    nextEntries.reduce((total, [, record]) => total + JSON.stringify(record).length, 0);
  if (projectedBytes > RUNTIME_LIMITS.storedBytes) {
    throw new Error(
      `The restored browser data needs ${projectedBytes.toLocaleString()} bytes; the safety limit is ${RUNTIME_LIMITS.storedBytes.toLocaleString()} bytes.`,
    );
  }
  replaceGraphAndReload(targetGraph, restored);
}

channel?.addEventListener("message", onChannelMessage);

function onVisibilityChange() {
  if (document.visibilityState === "hidden") persistNow();
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", persistNow);
  document.addEventListener("visibilitychange", onVisibilityChange);
}

/**
 * Vite's dev-mode HMR replaces this module's code in place while keeping the
 * page alive, but a `BroadcastChannel` connection isn't torn down just
 * because the module that opened it was replaced - it's a live browser
 * object, independent of the JS module graph. Without this, every edit to
 * this file during development leaves the previous channel+listener running
 * forever alongside the new one: each accumulated stale listener still
 * re-processes every future patch (a full store serialize + localStorage
 * write), so a long dev session slows down more with every hot-reload.
 * Production builds have no `import.meta.hot`, so this is a no-op there.
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (persistTimer !== undefined) clearTimeout(persistTimer);
    persistNow();
    channel?.removeEventListener("message", onChannelMessage);
    channel?.close();
    window.removeEventListener("pagehide", persistNow);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });
}

function graphMatches(objGraph: string, graphs: string[]): boolean {
  if (graphs.length === 0) return false;
  if (graphs.includes("did:ng:i")) return true;
  return graphs.includes(objGraph);
}

function subjectMatches(id: string, subjects: string[]): boolean {
  return subjects.length === 0 || subjects.includes(id);
}

function typeMatches(record: OrmRecord, shapeType: ShapeType): boolean {
  const shapeDef = shapeType.schema[shapeType.shape];
  const typePredicate = shapeDef?.predicates.find((p) => p.iri === TYPE_PREDICATE);
  const allowedTypes = typePredicate?.dataTypes.flatMap((dt) => dt.literals ?? []) ?? [];
  if (allowedTypes.length === 0) return true;
  const objType = record["@type"];
  const objTypes = Array.isArray(objType) ? objType : objType == null ? [] : [objType];
  return objTypes.some((t) => allowedTypes.includes(t as string));
}

function matchingRecords(
  graphs: string[],
  subjects: string[],
  shapeType: ShapeType,
): OrmRecord[] {
  return Object.values(store).filter(
    (record) =>
      graphMatches(record["@graph"], graphs) &&
      subjectMatches(record["@id"], subjects) &&
      typeMatches(record, shapeType),
  );
}

/** Decode a JSON-Pointer-style path segment (RFC 6901: ~1 -> /, ~0 -> ~). */
function decodePathSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function identityFromStoreKey(key: string): OrmRecord {
  const separator = key.lastIndexOf("|");
  return {
    "@graph": separator === -1 ? "" : key.slice(0, separator),
    "@id": separator === -1 ? key : key.slice(separator + 1),
  };
}

function applyPatchesToStore(
  patches: Patch[],
  target: Store = store,
  trackDirty = true,
) {
  if (target === store) labelPropertyNameCache.clear();
  for (const patch of patches) {
    if (!patch.path.startsWith("/")) continue;
    const parts = patch.path.slice(1).split("/").filter(Boolean).map(decodePathSegment);
    if (parts.length === 0) continue;
    const [subjectId, propKey] = parts;

    if (parts.length === 1) {
      if (patch.op === "add") {
        target[subjectId] ??= identityFromStoreKey(subjectId);
      } else if (patch.op === "remove") {
        delete target[subjectId];
      }
      if (trackDirty) dirtyIds.add(subjectId);
      continue;
    }

    const record = (target[subjectId] ??= identityFromStoreKey(subjectId));
    if (trackDirty) dirtyIds.add(subjectId);

    // Current alien-deepsignals patches use `type`; older ORM/backend
    // payloads used `valType`. Accept both so multi-value properties are
    // merged member-by-member instead of each addition replacing the set.
    const isSetPatch = patch.type === "set" || patch.valType === "set";
    if (isSetPatch) {
      const current = Array.isArray(record[propKey]) ? (record[propKey] as unknown[]) : [];
      const raw = patch.value;
      const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
      if (patch.op === "add") {
        for (const v of values) if (!current.includes(v)) current.push(v);
      } else if (patch.op === "remove") {
        for (const v of values) {
          const idx = current.indexOf(v);
          if (idx !== -1) current.splice(idx, 1);
        }
      }
      record[propKey] = current;
    } else if (patch.op === "add") {
      if (patch.value instanceof Set) {
        // Properties the schema declares max cardinality 1 (such as @type)
        // get patched as a single scalar
        // assignment carrying the whole Set object, rather than one set
        // patch per member the way multi-valued properties do. A raw Set
        // silently serializes to "{}" via JSON.stringify,
        // silently losing its contents on persist - unwrap it first.
        record[propKey] = [...(patch.value as Set<unknown>)];
      } else if (
        patch.value !== null &&
        typeof patch.value === "object" &&
        !Array.isArray(patch.value)
      ) {
        // A container-creation placeholder (plain empty object) from the
        // same batch as separate set member-add patches - don't
        // clobber data those patches already put here.
        record[propKey] ??= patch.value;
      } else {
        record[propKey] = patch.value;
      }
    } else if (patch.op === "remove") {
      delete record[propKey];
    }
  }
}

function validPatchBatch(value: unknown, source: string): value is Patch[] {
  if (!Array.isArray(value)) {
    reportRuntimeIssue(`Ignored an invalid ${source}.`, "Data update safety circuit opened");
    return false;
  }
  if (value.length > RUNTIME_LIMITS.patchBatch) {
    reportRuntimeIssue(
      `Ignored ${value.length.toLocaleString()} patches from one ${source}; the limit is ${RUNTIME_LIMITS.patchBatch.toLocaleString()}.`,
      "Data update safety circuit opened",
    );
    return false;
  }
  const valid = value.every(
    (patch) =>
      patch !== null &&
      typeof patch === "object" &&
      ((patch as Patch).op === "add" || (patch as Patch).op === "remove") &&
      typeof (patch as Patch).path === "string" &&
      (patch as Patch).path.length <= 16_384,
  );
  if (!valid) {
    reportRuntimeIssue(`Ignored a malformed ${source}.`, "Data update safety circuit opened");
  }
  return valid;
}

function patchMatchesScope(patch: Patch, sub: Subscription): boolean {
  if (!patch.path.startsWith("/")) return false;
  const key = decodePathSegment(patch.path.slice(1).split("/", 1)[0]);
  const record = store[key];
  if (record) {
    return graphMatches(record["@graph"], sub.graphs) && subjectMatches(record["@id"], sub.subjects);
  }

  // Whole-record removal patches no longer have a store entry. ORM keys use
  // graph|subject, so recover their scope without delivering them globally.
  const separator = key.lastIndexOf("|");
  if (separator === -1) return true;
  return (
    graphMatches(key.slice(0, separator), sub.graphs) &&
    subjectMatches(key.slice(separator + 1), sub.subjects)
  );
}

/**
 * Deliver patches to other subscriptions. If `shapeFilter` is given, only
 * subscriptions watching that same shape are notified, so an update to one
 * shape's objects can't be misapplied to an unrelated shape's signal set.
 */
function broadcastToLocalSubscriptions(
  patches: Patch[],
  excludeSubscriptionId?: string,
  shapeFilter?: string,
  expectUndoEcho = false,
) {
  for (const [subscriptionId, sub] of subscriptions) {
    if (subscriptionId === excludeSubscriptionId) continue;
    if (shapeFilter && sub.shapeType.shape !== shapeFilter) continue;
    const scopedPatches = patches.filter((patch) => patchMatchesScope(patch, sub));
    if (scopedPatches.length > 0) {
      try {
        if (expectUndoEcho) {
          expectedUndoEchoes.set(subscriptionId, {
            signature: JSON.stringify(scopedPatches),
            expiresAt: Date.now() + 1_000,
          });
        }
        sub.callback({ V0: { GraphOrmUpdate: scopedPatches } });
      } catch (error) {
        retireSubscription(subscriptionId);
        reportRuntimeIssue(
          error,
          "A failing live-data subscription was disconnected",
        );
      }
    }
  }
}

/** Find live shapes that own the records touched by a late/stale update. */
function inferActiveShapes(patches: Patch[]): Set<string> {
  const shapes = new Set<string>();
  for (const sub of subscriptions.values()) {
    const matches = patches.some((patch) => {
      if (!patch.path.startsWith("/")) return false;
      const key = decodePathSegment(patch.path.slice(1).split("/", 1)[0]);
      const record = store[key];
      return (
        record !== undefined &&
        graphMatches(record["@graph"], sub.graphs) &&
        subjectMatches(record["@id"], sub.subjects) &&
        typeMatches(record, sub.shapeType)
      );
    });
    if (matches) shapes.add(sub.shapeType.shape);
  }
  return shapes;
}

/**
 * Defer `fn` until after React has flushed the passive effects from the
 * current commit (e.g. `useSyncExternalStore`'s subscribe call in `useShape`).
 *
 * `useShape` subscribes to its signal object from a passive effect, which
 * React schedules via a `MessageChannel` task - a macrotask. If we deliver
 * the first patch on a microtask (or even a bare `setTimeout(fn, 0)`, whose
 * relative order against that MessageChannel task isn't guaranteed), it can
 * land before the subscription exists: the mutation happens, nothing is
 * listening yet, and the component is left permanently showing stale (empty)
 * data with no further signal to re-render. `requestAnimationFrame` runs
 * after pending macrotasks (including React's effect flush) and before the
 * next paint, so a double rAF reliably lands after subscription with no
 * visible delay. The real network-backed engine never hits this, since a
 * postMessage round trip to another origin is far slower than a paint frame.
 */
function scheduleAfterEffectsFlush(fn: () => void) {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => requestAnimationFrame(fn));
  } else {
    setTimeout(fn, 0);
  }
}

let subscriptionCounter = 0;

/**
 * Subscribe to all locally stored objects matching a shape and scope.
 * Mirrors the real engine's `orm_start_graph` wasm binding used by `@ng-org/orm`.
 */
function orm_start_graph(
  graphs: string[],
  subjects: string[],
  shapeType: ShapeType,
  _sessionId: unknown,
  callback: (message: unknown) => void,
): () => void {
  const subscriptionId = `sub-${++subscriptionCounter}`;
  subscriptions.set(subscriptionId, { graphs, subjects, shapeType, callback });

  const initialRecords = matchingRecords(graphs, subjects, shapeType);
  const initialPayload = Object.fromEntries(
    initialRecords.map((record) => [`${record["@graph"]}|${record["@id"]}`, record]),
  );

  scheduleAfterEffectsFlush(() => {
    if (!subscriptions.has(subscriptionId)) return;
    try {
      callback({ V0: { GraphOrmInitial: [initialPayload, subscriptionId] } });
    } catch (error) {
      retireSubscription(subscriptionId);
      reportRuntimeIssue(
        error,
        "A failing live-data subscription was disconnected",
      );
    }
  });

  return () => {
    retireSubscription(subscriptionId);
  };
}

/**
 * Apply local edits (from a `useShape` signal object) to the store and
 * propagate them to any other subscription watching the same shape.
 * Mirrors the real engine's `graph_orm_update` wasm binding.
 */
async function graph_orm_update(
  subscriptionId: string,
  patches: Patch[],
  _sessionId: unknown,
): Promise<void> {
  if (!validPatchBatch(patches, "local update")) return;
  const expectedUndoEcho = expectedUndoEchoes.get(subscriptionId);
  if (expectedUndoEcho) {
    expectedUndoEchoes.delete(subscriptionId);
    if (
      expectedUndoEcho.expiresAt >= Date.now() &&
      expectedUndoEcho.signature === JSON.stringify(patches)
    ) return;
  }
  patches = omitDuplicateCreations(patches);
  if (patches.length === 0) return;
  if (batchIsInert(patches)) return;
  const automaticSingletonCreation = isAutomaticSingletonCreation(patches);
  const inversePatches = inversePatchesFor(patches);
  const activeOriginShape = subscriptions.get(subscriptionId)?.shapeType.shape;
  const inferredBefore = activeOriginShape ? new Set<string>() : inferActiveShapes(patches);
  try {
    applyPatchesToStore(patches);
    applyPatchesToStore(patches, undoSnapshotStore, false);
  } catch (error) {
    reportRuntimeIssue(error, "A local data update was stopped");
    return;
  }
  schedulePersist();

  const originShapes = new Set<string>();
  if (activeOriginShape) {
    originShapes.add(activeOriginShape);
  } else {
    const closedShape = recentlyClosedShape(subscriptionId);
    if (closedShape) originShapes.add(closedShape);
    for (const shape of inferredBefore) originShapes.add(shape);
    for (const shape of inferActiveShapes(patches)) originShapes.add(shape);
  }

  if (originShapes.size > 0 && inversePatches.length > 0 && !automaticSingletonCreation) {
    pushUndo(
      { patches: inversePatches, shapes: [...originShapes] },
      singleFieldTarget(patches),
    );
  }

  for (const originShape of originShapes) {
    broadcastToLocalSubscriptions(patches, subscriptionId, originShape);
    try {
      postCrossTabPatches(patches, originShape);
    } catch (error) {
      reportRuntimeIssue(error, "Cross-tab synchronization was paused", "warning");
    }
    for (const listener of localPatchListeners) listener(patches, originShape);
  }
}

/** The local engine's "ng" surface, structurally compatible with what `@ng-org/orm` calls. */
export const localEngine = {
  orm_start_graph,
  graph_orm_update,
};
