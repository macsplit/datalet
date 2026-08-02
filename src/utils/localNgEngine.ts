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

const STORAGE_KEY = "expense-tracker:ng-local-store";
const TYPE_PREDICATE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const BROADCAST_CHANNEL_NAME = "expense-tracker:ng-local-engine";

type SchemaPredicate = {
  iri: string;
  dataTypes: Array<{ valType: string; literals?: string[] }>;
};
type Schema = Record<string, { iri: string; predicates: SchemaPredicate[] }>;
type ShapeType = { schema: Schema; shape: string };

type OrmRecord = Record<string, unknown> & { "@id": string; "@graph": string };
type Store = Record<string, OrmRecord>;

type Patch = {
  op: "add" | "remove";
  path: string;
  value?: unknown;
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
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

let store: Store = loadStore();

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

const subscriptions = new Map<string, Subscription>();

const channel =
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel(BROADCAST_CHANNEL_NAME)
    : undefined;

channel?.addEventListener("message", (event: MessageEvent) => {
  const { patches, shape } = event.data as { patches: Patch[]; shape?: string };
  applyPatchesToStore(patches);
  persist();
  broadcastToLocalSubscriptions(patches, undefined, shape);
});

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

    if (patch.valType === "set") {
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
      record[propKey] = patch.value;
    } else if (patch.op === "remove") {
      delete record[propKey];
    }
  }
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
    sub.callback({ V0: { GraphOrmUpdate: patches } });
  }
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
    callback({ V0: { GraphOrmInitial: [initialPayload, subscriptionId] } });
  });

  return () => {
    subscriptions.delete(subscriptionId);
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
  applyPatchesToStore(patches);
  persist();
  const originShape = subscriptions.get(subscriptionId)?.shapeType.shape;
  broadcastToLocalSubscriptions(patches, subscriptionId, originShape);
  channel?.postMessage({ patches, shape: originShape });
}

/** The local engine's "ng" surface, structurally compatible with what `@ng-org/orm` calls. */
export const localEngine = {
  orm_start_graph,
  graph_orm_update,
};
