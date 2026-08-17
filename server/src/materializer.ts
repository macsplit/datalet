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
 * inside every sync-server replica. Multiple processes divide vaults by a
 * stable FNV-1a shard, and a short Redis lease prevents duplicate ownership
 * of a configured shard. Each shard keeps one stable consumer name so a
 * restarted process can drain that shard's pending entries.
 */

import { newBlockingConnection, redis } from "./redis/client.js";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  listVaultIds,
  parseLogEntry,
  streamKey,
  sweepVaultTombstones,
  vaultStats,
  vaultActivityAt,
  type LogEntry,
} from "./vaultStore.js";
import { applyPatchesToStore, patchTarget, type Store } from "./patchApply.js";
import { ensureNeo4jSchema } from "./neo4j/client.js";
import { readRecord, tombstoneRecord, upsertRecord } from "./neo4j/materialize.js";
import {
  MATERIALIZER_GROUP,
  MATERIALIZER_SHARD_COUNT,
  MATERIALIZER_SHARD_HEARTBEAT_MS,
  MATERIALIZER_SHARD_INDEX,
  MATERIALIZER_SHARD_LEASE_SECONDS,
  MATERIALIZER_STREAMS_PER_CONNECTION,
  VAULT_DISCOVERY_INTERVAL_MS,
} from "./neo4j/config.js";
import { TOMBSTONE_SWEEP_INTERVAL_MS, VAULT_IDLE_REPORT_AFTER_MS } from "./config.js";

type StreamEntryRow = [string, string[] | null];
type StreamResponse = Array<[string, StreamEntryRow[]]> | null;
type WatchedVault = { vaultId: string; key: string; recovered: boolean };
const READ_COUNT = 50;
const BLOCK_MS = 5_000;

/** Stable unsigned FNV-1a over UTF-8 bytes, used for coordination-free ownership. */
export function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function materializerShardFor(vaultId: string, shardCount: number): number {
  return fnv1a(vaultId) % shardCount;
}

export function materializerConsumerName(shardIndex: number): string {
  return `materializer-${shardIndex}`;
}

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
    private readonly consumerName: string,
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
      this.consumerName,
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
    const safeConsumerName = this.consumerName.replace(/[^A-Za-z0-9_-]/g, "_");
    await this.connection.client("SETNAME", `localgraph-materializer-batch-${this.id}-${safeConsumerName}`);
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
 * (remote-sync-architecture.md §5) across every known vault, and emits one
 * structured stats line per owned vault. The sweep is where per-vault
 * reporting belongs because it is already the one loop that visits every
 * vault this process owns; the same numbers are available on demand from
 * GET /sync/admin/vaults. One vault's failure is logged and skipped rather
 * than aborting the rest, matching discoverAndWatch's per-vault fault
 * isolation below.
 */
async function sweepAllTombstones(
  ownsVault: (vaultId: string) => boolean,
  idleReportAfterMs: number,
): Promise<void> {
  const vaultIds = await listVaultIds();
  const idleCutoff = Date.now() - idleReportAfterMs;
  for (const vaultId of vaultIds) {
    if (!ownsVault(vaultId)) continue;
    try {
      const purged = await sweepVaultTombstones(vaultId);
      if (purged > 0) console.log(`materializer: purged ${purged} expired tombstone(s) in vault ${vaultId}`);
      // One JSON object per line, so a log scraper can consume this without
      // parsing prose. Quota and rate limits are otherwise invisible until a
      // tenant complains, which is the gap this closes.
      console.log(JSON.stringify({ event: "vault-stats", ...await vaultStats(vaultId) }));
      const activityAt = await vaultActivityAt(vaultId);
      if (activityAt !== undefined && activityAt <= idleCutoff) {
        console.warn(
          `materializer: vault ${vaultId} has been idle since ${new Date(activityAt).toISOString()}; ` +
          "reporting only, no data was deleted",
        );
      }
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

export type MaterializerServiceOptions = {
  streamsPerConnection?: number;
  discoveryIntervalMs?: number;
  blockMs?: number;
  shardIndex?: number;
  shardCount?: number;
  leaseSeconds?: number;
  heartbeatMs?: number;
  claimShard?: boolean;
  ownsVault?: (vaultId: string) => boolean;
  consumerName?: string;
  idleReportAfterMs?: number;
};

export class MaterializerService {
  private readonly watchedVaults = new Set<string>();
  private readonly batches = new Set<MaterializerStreamBatch>();
  private nextBatchId = 1;
  private discoveryTimer: ReturnType<typeof setInterval> | undefined;
  private tombstoneTimer: ReturnType<typeof setInterval> | undefined;
  private discoveryPromise: Promise<void> | undefined;
  private stopping = false;
  private started = false;
  private leaseTimer: ReturnType<typeof setInterval> | undefined;
  private leaseOwned = false;
  private readonly streamsPerConnection: number;
  private readonly discoveryIntervalMs: number;
  private readonly blockMs: number;
  private readonly shardIndex: number;
  private readonly shardCount: number;
  private readonly leaseSeconds: number;
  private readonly heartbeatMs: number;
  private readonly claimShard: boolean;
  private readonly ownsVault: (vaultId: string) => boolean;
  private readonly consumerName: string;
  private readonly idleReportAfterMs: number;
  private readonly leaseKey: string;
  private readonly leaseOwner: string;

  constructor(options: MaterializerServiceOptions = {}) {
    this.streamsPerConnection = options.streamsPerConnection ?? MATERIALIZER_STREAMS_PER_CONNECTION;
    this.discoveryIntervalMs = options.discoveryIntervalMs ?? VAULT_DISCOVERY_INTERVAL_MS;
    this.blockMs = options.blockMs ?? BLOCK_MS;
    this.shardIndex = options.shardIndex ?? MATERIALIZER_SHARD_INDEX;
    this.shardCount = options.shardCount ?? MATERIALIZER_SHARD_COUNT;
    this.leaseSeconds = options.leaseSeconds ?? MATERIALIZER_SHARD_LEASE_SECONDS;
    this.heartbeatMs = options.heartbeatMs ?? MATERIALIZER_SHARD_HEARTBEAT_MS;
    this.claimShard = options.claimShard ?? true;
    if (!Number.isInteger(this.shardCount) || this.shardCount < 1) {
      throw new Error("materializer shard count must be a positive integer");
    }
    if (!Number.isInteger(this.shardIndex) || this.shardIndex < 0 || this.shardIndex >= this.shardCount) {
      throw new Error("materializer shard index must be an integer within the configured shard count");
    }
    if (!Number.isInteger(this.streamsPerConnection) || this.streamsPerConnection < 1) {
      throw new Error("materializer streams per connection must be a positive integer");
    }
    if (this.heartbeatMs >= this.leaseSeconds * 1_000) {
      throw new Error("materializer heartbeat must be shorter than its shard lease");
    }
    this.ownsVault = options.ownsVault ??
      ((vaultId) => materializerShardFor(vaultId, this.shardCount) === this.shardIndex);
    this.consumerName = options.consumerName ?? materializerConsumerName(this.shardIndex);
    this.idleReportAfterMs = options.idleReportAfterMs ?? VAULT_IDLE_REPORT_AFTER_MS;
    if (!Number.isFinite(this.idleReportAfterMs) || this.idleReportAfterMs < 1) {
      throw new Error("vault idle reporting window must be a positive number");
    }
    this.leaseKey = `materializer:shard:${this.shardIndex}`;
    this.leaseOwner = `${hostname()}:${process.pid}:${randomUUID()}:count-${this.shardCount}`;
  }

  stats(): MaterializerStats {
    return {
      watchedVaults: this.watchedVaults.size,
      streamBatches: this.batches.size,
      blockingConnections: this.batches.size,
    };
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("materializer service is already started");
    this.started = true;
    this.stopping = false;
    try {
      if (this.claimShard) await this.acquireShardLease();
      await ensureNeo4jSchema();
      await this.discoverNow();
      this.discoveryTimer = setInterval(() => {
        void this.discoverNow().catch((error) => console.error("materializer: vault discovery failed", error));
      }, this.discoveryIntervalMs);
      this.tombstoneTimer = setInterval(() => {
        void this.maintenanceNow()
          .catch((error) => console.error("materializer: tombstone sweep failed", error));
      }, TOMBSTONE_SWEEP_INTERVAL_MS);
    } catch (error) {
      this.started = false;
      await this.releaseShardLease();
      throw error;
    }
  }

  discoverNow(): Promise<void> {
    if (this.discoveryPromise) return this.discoveryPromise;
    this.discoveryPromise = this.discover().finally(() => {
      this.discoveryPromise = undefined;
    });
    return this.discoveryPromise;
  }

  async maintenanceNow(): Promise<void> {
    await sweepAllTombstones(this.ownsVault, this.idleReportAfterMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    if (this.tombstoneTimer) clearInterval(this.tombstoneTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.discoveryTimer = undefined;
    this.tombstoneTimer = undefined;
    this.leaseTimer = undefined;
    await this.discoveryPromise?.catch(() => undefined);
    const batches = [...this.batches];
    this.batches.clear();
    this.watchedVaults.clear();
    await Promise.all(batches.map((batch) => batch.stop()));
    await this.releaseShardLease();
    this.started = false;
  }

  private async discover(): Promise<void> {
    if (this.stopping) return;
    const vaultIds = await listVaultIds();
    const currentVaultIds = new Set(vaultIds);
    const obsoleteBatches = [...this.batches].filter((batch) =>
      batch.vaultIds.some((vaultId) => !currentVaultIds.has(vaultId)));
    for (const batch of obsoleteBatches) {
      this.batches.delete(batch);
      for (const vaultId of batch.vaultIds) this.watchedVaults.delete(vaultId);
    }
    await Promise.all(obsoleteBatches.map((batch) => batch.stop()));

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
            this.consumerName,
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

  private async acquireShardLease(): Promise<void> {
    const claimed = await redis().set(
      this.leaseKey,
      this.leaseOwner,
      "EX",
      this.leaseSeconds,
      "NX",
    );
    if (claimed !== "OK") {
      const current = await redis().get(this.leaseKey);
      const message =
        `materializer: shard ${this.shardIndex}/${this.shardCount} is already claimed by ${current ?? "another process"}`;
      console.error(message);
      throw new Error(message);
    }
    this.leaseOwned = true;
    this.leaseTimer = setInterval(() => void this.refreshShardLease(), this.heartbeatMs);
  }

  private async refreshShardLease(): Promise<void> {
    if (!this.leaseOwned || this.stopping) return;
    try {
      const refreshed = await redis().manageShardLease(
        this.leaseKey,
        this.leaseOwner,
        String(this.leaseSeconds),
      );
      if (refreshed === 1) return;
      throw new Error("lease is now owned by another process");
    } catch (error) {
      this.leaseOwned = false;
      console.error(
        `materializer: LOST SHARD ${this.shardIndex}/${this.shardCount}; stopping to prevent duplicate processing`,
        error,
      );
      await this.stop().catch((stopError) => console.error("materializer: failed while stopping", stopError));
    }
  }

  private async releaseShardLease(): Promise<void> {
    if (!this.leaseOwned) return;
    await redis().manageShardLease(this.leaseKey, this.leaseOwner, "0").catch(() => 0);
    this.leaseOwned = false;
  }
}

export async function startMaterializer(): Promise<MaterializerService> {
  const service = new MaterializerService();
  await service.start();
  return service;
}
