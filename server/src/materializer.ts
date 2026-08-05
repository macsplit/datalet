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
 * Replays each vault's accepted-patches stream into Neo4j in order, via a
 * Redis Streams consumer group (remote-sync-architecture.md §6.3) - kept
 * decoupled from the ingest tier (httpServer.ts) so a slow/down Neo4j never
 * blocks accepting or fanning out new patches to already-connected clients.
 *
 * Runs as its own process (`ROLE=materializer`, see index.ts) rather than
 * inside every sync-server replica: the consumer group already lets
 * multiple materializer processes divide the work safely (each stream
 * entry is delivered to exactly one group member), so scaling this out
 * later is a matter of running more `ROLE=materializer` processes, not a
 * redesign. One process is enough at this app's likely write volume - see
 * §6.3's sharded-worker-pool note for the scale-out path.
 */

import { newBlockingConnection, redis } from "./redis/client.js";
import { listVaultIds, parseLogEntry, streamKey, type LogEntry } from "./vaultStore.js";
import { applyPatchesToStore, patchTarget, type Store } from "./patchApply.js";
import { ensureNeo4jSchema } from "./neo4j/client.js";
import { readRecord, tombstoneRecord, upsertRecord } from "./neo4j/materialize.js";
import { MATERIALIZER_GROUP, VAULT_DISCOVERY_INTERVAL_MS } from "./neo4j/config.js";

// Stable across restarts (unlike process.pid) - a consumer group only
// redelivers a crashed consumer's still-pending entries to a *later read
// under the same consumer name*. A name that changed on every restart
// would silently orphan whatever was in flight when the process died.
const CONSUMER_NAME = process.env.MATERIALIZER_CONSUMER_ID ?? "materializer-1";

type StreamEntryRow = [string, string[] | null];

async function ensureConsumerGroup(key: string): Promise<void> {
  try {
    await redis().xgroup("CREATE", key, MATERIALIZER_GROUP, "0", "MKSTREAM");
  } catch (error) {
    if (error instanceof Error && error.message.includes("BUSYGROUP")) return;
    throw error;
  }
}

async function materializeEntry(vaultId: string, entry: LogEntry): Promise<void> {
  const subjectIds = new Set<string>();
  for (const patch of entry.patches) {
    const target = patchTarget(patch);
    if (target) subjectIds.add(target.subjectId);
  }
  if (subjectIds.size === 0) return;

  const scratch: Store = {};
  for (const subjectId of subjectIds) {
    const existing = await readRecord(vaultId, subjectId);
    if (existing) scratch[subjectId] = existing;
  }
  applyPatchesToStore(scratch, entry.patches);

  for (const subjectId of subjectIds) {
    const record = scratch[subjectId];
    if (record) {
      await upsertRecord(vaultId, subjectId, record);
    } else {
      // Removed by this batch's patches (a root "remove") - tombstone
      // rather than leaving no trace, per §6.4.
      await tombstoneRecord(vaultId, subjectId, entry.hlc);
    }
  }
}

async function processRows(vaultId: string, key: string, rows: StreamEntryRow[]): Promise<void> {
  for (const [id, fields] of rows) {
    if (fields) {
      const entry = parseLogEntry([id, fields]);
      if (entry) await materializeEntry(vaultId, entry);
    }
    await redis().xack(key, MATERIALIZER_GROUP, id);
  }
}

/** One dedicated blocking connection per actively-materialized vault, mirroring redis/streamWatcher.ts's pattern. */
async function runVaultConsumer(vaultId: string): Promise<void> {
  const key = streamKey(vaultId);
  await ensureConsumerGroup(key);
  const connection = newBlockingConnection();
  try {
    // Crash recovery: replay this consumer's own previously-delivered but
    // never-acked entries (ID "0") before joining the live tail (ID ">").
    // A prior run that died mid-batch resumes exactly where it left off.
    for (;;) {
      const pending = await connection.xreadgroup(
        "GROUP",
        MATERIALIZER_GROUP,
        CONSUMER_NAME,
        "COUNT",
        "50",
        "STREAMS",
        key,
        "0",
      );
      const rows = pending?.[0]?.[1] ?? [];
      if (rows.length === 0) break;
      await processRows(vaultId, key, rows);
    }

    for (;;) {
      const response = await connection.xreadgroup(
        "GROUP",
        MATERIALIZER_GROUP,
        CONSUMER_NAME,
        "COUNT",
        "50",
        "BLOCK",
        "5000",
        "STREAMS",
        key,
        ">",
      );
      const rows = response?.[0]?.[1] ?? [];
      if (rows.length > 0) await processRows(vaultId, key, rows);
    }
  } finally {
    connection.disconnect();
  }
}

const watchedVaults = new Set<string>();

async function discoverAndWatch(): Promise<void> {
  const vaultIds = await listVaultIds();
  for (const vaultId of vaultIds) {
    if (watchedVaults.has(vaultId)) continue;
    watchedVaults.add(vaultId);
    runVaultConsumer(vaultId).catch((error) => {
      watchedVaults.delete(vaultId);
      console.error(`materializer: vault ${vaultId} consumer stopped, will retry`, error);
    });
  }
}

export async function startMaterializer(): Promise<void> {
  await ensureNeo4jSchema();
  await discoverAndWatch();
  setInterval(() => {
    discoverAndWatch().catch((error) => console.error("materializer: vault discovery failed", error));
  }, VAULT_DISCOVERY_INTERVAL_MS);
}
