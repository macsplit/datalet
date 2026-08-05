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

type SchemaPredicate = {
  iri: string;
  dataTypes: Array<{ valType: string; literals?: string[] }>;
};
type Schema = Record<string, { iri: string; predicates: SchemaPredicate[] }>;
type ShapeType = { schema: Schema; shape: string };

export type OrmRecord = Record<string, unknown> & { "@id": string; "@graph": string };
export type Store = Record<string, OrmRecord>;

export type Patch = {
  op: "add" | "remove";
  path: string;
  value?: unknown;
  type?: string;
  valType?: string;
};

type Subscription = {
  graphs: string[];
  subjects: string[];
  shapeType: ShapeType;
  callback: (message: unknown) => void;
};

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && raw.length > RUNTIME_LIMITS.storedBytes) {
      reportRuntimeIssue(
        `Saved data is ${raw.length.toLocaleString()} bytes; the safety limit is ${RUNTIME_LIMITS.storedBytes.toLocaleString()} bytes. Loading was stopped.`,
        "Local data safety circuit opened",
      );
      return {};
    }
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Saved browser data does not contain a valid object store.");
    }
    return parsed as Store;
  } catch (error) {
    reportRuntimeIssue(error, "Saved browser data could not be loaded");
    return {};
  }
}

let store: Store = loadStore();
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let persistenceDisabled = false;

function persistNow() {
  if (persistenceDisabled) return;
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = undefined;
  try {
    const serialized = JSON.stringify(store);
    if (serialized.length > RUNTIME_LIMITS.storedBytes) {
      persistenceDisabled = true;
      throw new Error(
        `Local data reached ${serialized.length.toLocaleString()} bytes. Saving has been paused to keep the page responsive.`,
      );
    }
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch (error) {
    persistenceDisabled = true;
    reportRuntimeIssue(error, "Browser persistence was paused");
  }
}

/** Coalesce rapid field edits into one expensive stringify/storage write. */
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

/**
 * Apply patches that originated outside this store's own call path (another
 * tab via BroadcastChannel, or the remote sync server) and notify local
 * subscriptions, exactly as a local edit would.
 */
function applyExternalPatches(patches: Patch[], shape: string, relayToTabs: boolean) {
  try {
    applyPatchesToStore(patches);
  } catch (error) {
    reportRuntimeIssue(error, "An external data update was stopped");
    return;
  }
  schedulePersist();
  broadcastToLocalSubscriptions(patches, undefined, shape);
  if (relayToTabs) {
    try {
      channel?.postMessage({ patches, shape });
    } catch (error) {
      reportRuntimeIssue(error, "Cross-tab synchronization was paused", "warning");
    }
  }
}

function onChannelMessage(event: MessageEvent) {
  const payload = event.data as { patches?: unknown; shape?: string } | null;
  if (!payload || !validPatchBatch(payload.patches, "cross-tab update")) return;
  if (typeof payload.shape !== "string") {
    reportRuntimeIssue(
      "Ignored a cross-tab update with no shape identity.",
      "Cross-tab synchronization safety circuit opened",
      "warning",
    );
    return;
  }
  // Don't relay back onto the channel: BroadcastChannel already fans this
  // message out to every other tab directly, so re-posting would just echo.
  applyExternalPatches(payload.patches as Patch[], payload.shape, false);
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

/**
 * Wholesale-replace one graph's records with a server snapshot and reload.
 * Used when a client's resume cursor has fallen outside the sync server's
 * retained patch log. A reload is simpler and more robust than re-targeting
 * every open subscription from a flat snapshot payload, which carries record
 * data but not shape identity — after reload, each subscription's normal
 * startup path recomputes its own matching records from the updated store.
 */
export function replaceGraphAndReload(graph: string, records: Store) {
  for (const key of Object.keys(store)) {
    if (store[key]?.["@graph"] === graph && !(key in records)) delete store[key];
  }
  for (const [key, record] of Object.entries(records)) {
    store[key] = record;
  }
  persistNow();
  window.location.reload();
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

function applyPatchesToStore(patches: Patch[]) {
  for (const patch of patches) {
    if (!patch.path.startsWith("/")) continue;
    const parts = patch.path.slice(1).split("/").filter(Boolean).map(decodePathSegment);
    if (parts.length === 0) continue;
    const [subjectId, propKey] = parts;

    if (parts.length === 1) {
      if (patch.op === "add") {
        store[subjectId] ??= { "@id": subjectId, "@graph": "" } as OrmRecord;
      } else if (patch.op === "remove") {
        delete store[subjectId];
      }
      continue;
    }

    const record = (store[subjectId] ??= { "@id": subjectId, "@graph": "" } as OrmRecord);

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
) {
  for (const [subscriptionId, sub] of subscriptions) {
    if (subscriptionId === excludeSubscriptionId) continue;
    if (shapeFilter && sub.shapeType.shape !== shapeFilter) continue;
    const scopedPatches = patches.filter((patch) => patchMatchesScope(patch, sub));
    if (scopedPatches.length > 0) {
      try {
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
  const activeOriginShape = subscriptions.get(subscriptionId)?.shapeType.shape;
  const inferredBefore = activeOriginShape ? new Set<string>() : inferActiveShapes(patches);
  try {
    applyPatchesToStore(patches);
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

  for (const originShape of originShapes) {
    broadcastToLocalSubscriptions(patches, subscriptionId, originShape);
    try {
      channel?.postMessage({ patches, shape: originShape });
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
