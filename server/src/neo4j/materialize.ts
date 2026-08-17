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
 * Neo4j is the durable system of record (remote-sync-architecture.md
 * §6.3-6.4): the materializer (materializer.ts) replays each vault's
 * accepted-patches stream into here in order, and /sync/snapshot reads
 * records back from here rather than from Redis, so a vault's durability
 * doesn't depend on Redis's stream-trimming/eviction policy.
 *
 * Storage is keyed by (graph, subjectId) - the same pair Redis's store hash
 * uses (vault:<id>:store, HSET'd by subjectId - see vaultStore.ts). This
 * matters because subjectId (the first path segment of a patch, i.e. what
 * patchTarget() returns) is *not* the same string as the record's own
 * "@id" field in general: this app's ORM addresses records by a
 * graph-qualified path segment while a record's "@id" field is its bare,
 * unqualified NextGraph document id - the two just happen to look similar
 * for path segments with no graph-qualification. An earlier version of
 * this file keyed Neo4j nodes by record["@id"] instead of subjectId, which
 * silently produced a second, untyped orphan node on every update after a
 * record's first write (readRecord looked up by subjectId, upsertRecord
 * wrote under record["@id"] - two different keys for the same record).
 * Found via a direct Neo4j inspection during step-3 regression testing,
 * where the app's own generated ids (unlike hand-written test ids) made
 * subjectId and "@id" actually differ.
 */

import type { Session } from "neo4j-driver";
import { neo4jSession } from "./client.js";
import { BOUNDED_RECORD_TYPE_LABELS, sanitizeLabel } from "./labels.js";
import type { OrmRecord, Store } from "../patchApply.js";

// Internal Neo4j property names, reserved so a user-defined schema property
// happening to share one of these names can't collide with this module's
// own bookkeeping - stripped defensively out of $props in toNeo4jProps()
// even though no shape in this app currently names a field this way.
const RESERVED_PROPS = new Set(["id", "graph", "recordId", "recordGraph", "type", "deletedAtHlc"]);

export type DurableVaultMeta = {
  vaultId: string;
  tokenHash: string;
  createdAt: number;
  rotatedAt?: number;
  deletingAt?: number;
};

/** Durable copy of vault identity; plaintext bearer tokens are never stored. */
export async function upsertVaultMeta(meta: DurableVaultMeta): Promise<void> {
  const session = neo4jSession();
  try {
    await session.run(
      `MERGE (v:VaultMeta {id: $vaultId})
       SET v.tokenHash = $tokenHash,
           v.createdAt = $createdAt,
           v.rotatedAt = $rotatedAt
       FOREACH (_ IN CASE WHEN $deletingAt IS NULL THEN [] ELSE [1] END |
         SET v.deletingAt = $deletingAt
       )`,
      { ...meta, rotatedAt: meta.rotatedAt ?? null, deletingAt: meta.deletingAt ?? null },
    );
  } finally {
    await session.close();
  }
}

export async function readVaultMeta(vaultId: string): Promise<DurableVaultMeta | undefined> {
  const session = neo4jSession();
  try {
    const result = await session.run(
      "MATCH (v:VaultMeta {id: $vaultId}) RETURN v",
      { vaultId },
    );
    if (result.records.length === 0) return undefined;
    const props = result.records[0].get("v").properties as Record<string, unknown>;
    return {
      vaultId,
      tokenHash: String(props.tokenHash),
      createdAt: Number(props.createdAt),
      ...(props.rotatedAt !== null && props.rotatedAt !== undefined
        ? { rotatedAt: Number(props.rotatedAt) }
        : {}),
      ...(props.deletingAt !== null && props.deletingAt !== undefined
        ? { deletingAt: Number(props.deletingAt) }
        : {}),
    };
  } finally {
    await session.close();
  }
}

export async function deleteVaultMeta(vaultId: string): Promise<void> {
  const session = neo4jSession();
  try {
    await session.run("MATCH (v:VaultMeta {id: $vaultId}) DETACH DELETE v", { vaultId });
  } finally {
    await session.close();
  }
}

/** Mark deletion durably so a Redis cache miss cannot resurrect the vault. */
export async function markVaultDeleting(vaultId: string, deletingAt: number): Promise<void> {
  const session = neo4jSession();
  try {
    await session.run(
      "MATCH (v:VaultMeta {id: $vaultId}) SET v.deletingAt = $deletingAt",
      { vaultId, deletingAt },
    );
  } finally {
    await session.close();
  }
}

/** Permanently remove a vault's identity, live records, and tombstones together. */
export async function deleteVaultData(vaultId: string): Promise<void> {
  const session = neo4jSession();
  try {
    await session.run(
      `MATCH (n)
       WHERE (n:Record AND n.graph = $vaultId)
          OR (n:VaultMeta AND n.id = $vaultId)
       DETACH DELETE n`,
      { vaultId },
    );
  } finally {
    await session.close();
  }
}

/**
 * Container-creation placeholders (an empty plain object standing in for a
 * not-yet-populated set field - see patchApply.ts's applyPatchesToStore)
 * are the only non-primitive, non-array value this app's records ever end
 * up holding. Neo4j node properties must be primitives or arrays of
 * primitives, so any survivor is normalized to an empty array (an empty
 * set), matching applyBatch.lua's isContainerPlaceholder handling of the
 * same case.
 */
function isPlaceholderObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `id`/`graph` here are the Neo4j lookup identity (graph = vaultId,
 * id = subjectId). The record's own "@id"/"@graph" field values are kept
 * as separate `recordId`/`recordGraph` data properties so they round-trip
 * correctly even when they differ from the lookup identity.
 */
function toNeo4jProps(graph: string, subjectId: string, record: OrmRecord): Record<string, unknown> {
  const props: Record<string, unknown> = {
    graph,
    id: subjectId,
    recordId: record["@id"],
    recordGraph: record["@graph"],
    type: record["@type"] ?? null,
  };
  for (const [key, value] of Object.entries(record)) {
    if (key === "@id" || key === "@graph" || key === "@type") continue;
    if (RESERVED_PROPS.has(key)) continue;
    props[key] = isPlaceholderObject(value) ? [] : value;
  }
  return props;
}

function fromNeo4jProps(props: Record<string, unknown>): OrmRecord {
  const { recordId, recordGraph, type, id: _id, graph: _graph, deletedAtHlc: _deletedAtHlc, ...rest } = props;
  const record = { "@id": recordId, "@graph": recordGraph, ...rest } as OrmRecord;
  if (type !== null && type !== undefined) record["@type"] = type;
  return record;
}

/**
 * Full-replace upsert: callers pass the complete post-patch record (see
 * materializer.ts, which reads-modify-writes via the same
 * applyPatchesToStore used for the Redis-backed materialized view), so
 * `SET r = $props` (not `+=`) is used deliberately - it drops any Neo4j
 * property no longer present in the record, which is how a property
 * removal patch is reflected here.
 */
export async function upsertRecord(
  graph: string,
  subjectId: string,
  record: OrmRecord,
  session?: Session,
): Promise<void> {
  const s = session ?? neo4jSession();
  const label = sanitizeLabel(record["@type"] as string | undefined);
  const boundedLabels = [...BOUNDED_RECORD_TYPE_LABELS].map((name) => `\`${name}\``).join(":");
  try {
    await s.run(
      `MERGE (r:Record {graph: $graph, id: $id})
       SET r = $props
       REMOVE r:${boundedLabels}
       SET r:\`${label}\`
       REMOVE r:Deleted`,
      { graph, id: subjectId, props: toNeo4jProps(graph, subjectId, record) },
    );
  } finally {
    if (!session) await s.close();
  }
}

/**
 * Soft delete: keeps the node (and its last-known properties) rather than
 * removing it, per remote-sync-architecture.md §6.4's tombstone-retention
 * design - a node that's simply missing can't be distinguished from one
 * that never existed, which matters for future retention-window purging.
 */
export async function tombstoneRecord(
  graph: string,
  subjectId: string,
  deletedAtHlc: string,
  session?: Session,
): Promise<void> {
  const s = session ?? neo4jSession();
  try {
    await s.run(
      `MERGE (r:Record {graph: $graph, id: $id})
       SET r.deletedAtHlc = $deletedAtHlc
       SET r:Deleted`,
      { graph, id: subjectId, deletedAtHlc },
    );
  } finally {
    if (!session) await s.close();
  }
}

/** Current record for one subject, including tombstoned ones (callers decide what to do with a tombstone). */
export async function readRecord(
  graph: string,
  subjectId: string,
  session?: Session,
): Promise<OrmRecord | undefined> {
  const s = session ?? neo4jSession();
  try {
    const result = await s.run("MATCH (r:Record {graph: $graph, id: $id}) RETURN r", { graph, id: subjectId });
    if (result.records.length === 0) return undefined;
    return fromNeo4jProps(result.records[0].get("r").properties);
  } finally {
    if (!session) await s.close();
  }
}

/**
 * Permanently deletes every tombstone older than the retention cutoff
 * (remote-sync-architecture.md §5) and returns the subjectIds purged, so
 * the caller (vaultStore.ts's sweepVaultTombstones) can also drop the
 * matching entries from Redis's tombstone hash - after this, a stale patch
 * predating the deletion is no longer distinguishable from an ordinary
 * fresh write and will be accepted again. `cutoffHlc` is a 15-digit,
 * zero-padded millisecond string (matching the leading segment of the hlc
 * format minted by nextHlc() in remoteSyncEngine.ts): deletedAtHlc's own
 * leading digits make a plain string `<` comparison correct here, same
 * trick already used for HLC comparisons in applyBatch.lua.
 */
export async function purgeExpiredTombstones(graph: string, cutoffHlc: string): Promise<string[]> {
  const session = neo4jSession();
  try {
    const result = await session.run(
      `MATCH (r:Record:Deleted {graph: $graph})
       WHERE r.deletedAtHlc < $cutoffHlc
       WITH r, r.id AS id
       DETACH DELETE r
       RETURN id`,
      { graph, cutoffHlc },
    );
    return result.records.map((row) => row.get("id") as string);
  } finally {
    await session.close();
  }
}

/** Every non-tombstoned record in a vault - the durable source for /sync/snapshot, keyed by subjectId like Redis's store hash. */
export async function readVaultRecords(graph: string): Promise<Store> {
  const session = neo4jSession();
  try {
    const result = await session.run("MATCH (r:Record {graph: $graph}) WHERE NOT r:Deleted RETURN r", { graph });
    const store: Store = {};
    for (const row of result.records) {
      const props = row.get("r").properties as Record<string, unknown>;
      store[props.id as string] = fromNeo4jProps(props);
    }
    return store;
  } finally {
    await session.close();
  }
}
