// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

export type Patch = {
  op: "add" | "remove";
  path: string;
  value?: unknown;
  type?: string;
  valType?: string;
};

export type OrmRecord = Record<string, unknown> & { "@id": string; "@graph": string };
export type Store = Record<string, OrmRecord>;

const MAX_PATCH_BATCH = 5_000;
const MAX_PATH_LENGTH = 16_384;

/** Decode a JSON-Pointer-style path segment (RFC 6901: ~1 -> /, ~0 -> ~). */
export function decodePathSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function validatePatchBatch(
  value: unknown,
): { valid: true; patches: Patch[] } | { valid: false; reason: string } {
  if (!Array.isArray(value)) return { valid: false, reason: "patches must be an array" };
  if (value.length > MAX_PATCH_BATCH) {
    return { valid: false, reason: `batch of ${value.length} exceeds limit of ${MAX_PATCH_BATCH}` };
  }
  const ok = value.every(
    (patch) =>
      patch !== null &&
      typeof patch === "object" &&
      ((patch as Patch).op === "add" || (patch as Patch).op === "remove") &&
      typeof (patch as Patch).path === "string" &&
      (patch as Patch).path.length <= MAX_PATH_LENGTH,
  );
  if (!ok) return { valid: false, reason: "malformed patch in batch" };
  return { valid: true, patches: value as Patch[] };
}

/** Which subject/property a patch targets, or undefined if its path is malformed. */
export function patchTarget(patch: Patch): { subjectId: string; propKey?: string } | undefined {
  if (!patch.path.startsWith("/")) return undefined;
  const parts = patch.path.slice(1).split("/").filter(Boolean).map(decodePathSegment);
  if (parts.length === 0) return undefined;
  const [subjectId, propKey] = parts;
  return { subjectId, propKey };
}

export function isSetPatch(patch: Patch): boolean {
  return patch.type === "set" || patch.valType === "set";
}

/**
 * Apply patches to a materialized record store. Ported from the browser
 * engine's algorithm (src/utils/localNgEngine.ts, applyPatchesToStore) so
 * the server's materialized view and snapshot payloads stay compatible with
 * what a client computes applying the same patches locally. Unlike the
 * client, patches arriving here always came over the wire as JSON, so the
 * client-only `value instanceof Set` case (a same-process ORM signal
 * artifact that can't survive JSON transport) doesn't apply.
 */
export function applyPatchesToStore(store: Store, patches: Patch[]): void {
  for (const patch of patches) {
    const target = patchTarget(patch);
    if (!target) continue;
    const { subjectId, propKey } = target;

    if (propKey === undefined) {
      if (patch.op === "add") {
        store[subjectId] ??= { "@id": subjectId, "@graph": "" } as OrmRecord;
      } else if (patch.op === "remove") {
        delete store[subjectId];
      }
      continue;
    }

    const record = (store[subjectId] ??= { "@id": subjectId, "@graph": "" } as OrmRecord);

    if (isSetPatch(patch)) {
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
      if (patch.value !== null && typeof patch.value === "object" && !Array.isArray(patch.value)) {
        record[propKey] ??= patch.value;
      } else {
        record[propKey] = patch.value;
      }
    } else if (patch.op === "remove") {
      delete record[propKey];
    }
  }
}
