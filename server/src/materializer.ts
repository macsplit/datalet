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
import { listVaultIds, parseLogEntry, streamKey, sweepVaultTombstones, type LogEntry } from "./vaultStore.js";
import { applyPatchesToStore, patchTarget, type Store } from "./patchApply.js";
import { ensureNeo4jSchema } from "./neo4j/client.js";
import { readRecord, tombstoneRecord, upsertRecord } from "./neo4j/materialize.js";
import {
  MATERIALIZER_GROUP,
  MATERIALIZER_STREAMS_PER_CONNECTION,
  VAULT_DISCOVERY_INTERVAL_MS,
} from "./neo4j/config.js";
import { TOMBSTONE_SWEEP_INTERVAL_MS } from "./config.js";

// Stable across restarts (unlike process.pid) - a consumer group only
// redelivers a crashed consumer's still-pending entries to a *later read
// under the same consumer name*. A name that changed on every restart
// would silently orphan whatever was in flight when the process died.
const CONSUMER_NAME = process.env.MATERIALIZER_CONSUMER_ID ?? "materializer-1";

type StreamEntryRow = [string, string[] | null];
type StreamResponse = Array<[string, StreamEntryRow[]]> | null;
type WatchedVault = { vaultId: string; key: string; recovered: boolean };
const READ_COUNT = 50;
const BLOCK_MS = 5_000;

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

class MaterializerStreamBatch {
  private readonly connection = newBlockingConnection();
  private readonly vaults: WatchedVault[] = [];
  private running = true;
  private loopPromise: Promise<void> | undefined;

  constructor(
    readonly id: number,
    readonly capacity: number,
    private readonly blockMs: number,
    private readonly onFailure: (batch: MaterializerStreamBatch, error: unknown) => void,
  ) {}

  get size(): number {
    return this.vaults.length;
  }

  get vaultIds(): string[] {
    return this.vaults.map(({ vaultId }) => vaultId);
  }

  add(vaultId: string): void {
    if (this.size >= this.capacity) throw new Error("materializer stream batch is full");
    this.vaults.push({ vaultId, key: streamKey(vaultId), recovered: false });
    if (!this.loopPromise) {
      this.loopPromise = this.loop().catch((error) => {
        if (this.running) this.onFailure(this, error);
      }).finally(() => this.connection.disconnect());
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.connection.disconnect();
    await this.loopPromise;
  }

  private async read(vaults: WatchedVault[], id: "0" | ">", block = false): Promise<StreamResponse> {
    if (vaults.length === 0) return null;
    const args = [
      "GROUP",
      MATERIALIZER_GROUP,
      CONSUMER_NAME,
      "COUNT",
      String(READ_COUNT),
      ...(block ? ["BLOCK", String(this.blockMs)] : []),
      "STREAMS",
      ...vaults.map(({ key }) => key),
      ...vaults.map(() => id),
    ];
    const xreadgroup = this.connection.xreadgroup.bind(this.connection) as unknown as
      (...commandArgs: string[]) => Promise<StreamResponse>;
    return await xreadgroup(...args);
  }

  private async processResponse(response: StreamResponse): Promise<number> {
    let processed = 0;
    for (const [key, rows] of response ?? []) {
      const vault = this.vaults.find((candidate) => candidate.key === key);
      if (!vault || rows.length === 0) continue;
      await processRows(vault.vaultId, key, rows);
      processed += rows.length;
    }
    return processed;
  }

  private async recoverNewVaults(): Promise<void> {
    const recovering = this.vaults.filter(({ recovered }) => !recovered);
    if (recovering.length === 0) return;
    for (;;) {
      const processed = await this.processResponse(await this.read(recovering, "0"));
      if (processed === 0) break;
    }
    for (const vault of recovering) vault.recovered = true;
  }

  private async loop(): Promise<void> {
    await this.connection.client("SETNAME", `localgraph-materializer-batch-${this.id}`);
    while (this.running) {
      // A vault added while this batch was already blocking must drain the
      // stable consumer's pending entries before its first ">" live read.
      await this.recoverNewVaults();
      const liveVaults = this.vaults.filter(({ recovered }) => recovered);
      if (liveVaults.length === 0) continue;
      await this.processResponse(await this.read(liveVaults, ">", true));
    }
  }
}

/**
 * Purges tombstones (both Neo4j's and Redis's) past their retention window
 * (remote-sync-architecture.md §5) across every known vault. One vault's
 * failure is logged and skipped rather than aborting the rest, matching
 * discoverAndWatch's per-vault fault isolation below.
 */
async function sweepAllTombstones(): Promise<void> {
  const vaultIds = await listVaultIds();
  for (const vaultId of vaultIds) {
    try {
      const purged = await sweepVaultTombstones(vaultId);
      if (purged > 0) console.log(`materializer: purged ${purged} expired tombstone(s) in vault ${vaultId}`);
    } catch (error) {
      console.error(`materializer: tombstone sweep failed for vault ${vaultId}`, error);
    }
  }
}

export type MaterializerStats = {
  watchedVaults: number;
  streamBatches: number;
  blockingConnections: number;
};

export class MaterializerService {
  private readonly watchedVaults = new Set<string>();
  private readonly batches = new Set<MaterializerStreamBatch>();
  private nextBatchId = 1;
  private discoveryTimer: ReturnType<typeof setInterval> | undefined;
  private tombstoneTimer: ReturnType<typeof setInterval> | undefined;
  private discoveryPromise: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly streamsPerConnection = MATERIALIZER_STREAMS_PER_CONNECTION,
    private readonly discoveryIntervalMs = VAULT_DISCOVERY_INTERVAL_MS,
    private readonly blockMs = BLOCK_MS,
    private readonly ownsVault: (vaultId: string) => boolean = () => true,
  ) {}

  stats(): MaterializerStats {
    return {
      watchedVaults: this.watchedVaults.size,
      streamBatches: this.batches.size,
      blockingConnections: this.batches.size,
    };
  }

  async start(): Promise<void> {
    if (this.discoveryTimer || this.tombstoneTimer) throw new Error("materializer service is already started");
    this.stopping = false;
    await ensureNeo4jSchema();
    await this.discoverNow();
    this.discoveryTimer = setInterval(() => {
      void this.discoverNow().catch((error) => console.error("materializer: vault discovery failed", error));
    }, this.discoveryIntervalMs);
    this.tombstoneTimer = setInterval(() => {
      void sweepAllTombstones().catch((error) => console.error("materializer: tombstone sweep failed", error));
    }, TOMBSTONE_SWEEP_INTERVAL_MS);
  }

  discoverNow(): Promise<void> {
    if (this.discoveryPromise) return this.discoveryPromise;
    this.discoveryPromise = this.discover().finally(() => {
      this.discoveryPromise = undefined;
    });
    return this.discoveryPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.tombstoneTimer) clearInterval(this.tombstoneTimer);
    this.discoveryTimer = undefined;
    this.tombstoneTimer = undefined;
    await this.discoveryPromise?.catch(() => undefined);
    const batches = [...this.batches];
    this.batches.clear();
    this.watchedVaults.clear();
    await Promise.all(batches.map((batch) => batch.stop()));
  }

  private async discover(): Promise<void> {
    if (this.stopping) return;
    const vaultIds = await listVaultIds();
    for (const vaultId of vaultIds) {
      if (this.stopping) return;
      if (!this.ownsVault(vaultId)) continue;
      if (this.watchedVaults.has(vaultId)) continue;
      try {
        await ensureConsumerGroup(streamKey(vaultId));
        if (this.stopping) return;
        let batch = [...this.batches].find((candidate) => candidate.size < candidate.capacity);
        if (!batch) {
          batch = new MaterializerStreamBatch(
            this.nextBatchId++,
            this.streamsPerConnection,
            this.blockMs,
            (failed, error) => this.handleBatchFailure(failed, error),
          );
          this.batches.add(batch);
        }
        batch.add(vaultId);
        this.watchedVaults.add(vaultId);
      } catch (error) {
        console.error(`materializer: could not watch vault ${vaultId}, will retry`, error);
      }
    }
  }

  private handleBatchFailure(batch: MaterializerStreamBatch, error: unknown): void {
    this.batches.delete(batch);
    for (const vaultId of batch.vaultIds) this.watchedVaults.delete(vaultId);
    console.error(
      `materializer: stream batch ${batch.id} (${batch.vaultIds.length} vaults) stopped, will retry`,
      error,
    );
  }
}

export async function startMaterializer(): Promise<void> {
  const service = new MaterializerService();
  await service.start();
}
