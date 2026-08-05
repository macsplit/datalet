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
 * Vault state now lives in Redis instead of process memory, so any number
 * of stateless sync-server processes can share one vault (build-order step
 * 2 in remote-sync-architecture.md §10). The accept/apply decision (dedup,
 * structural-creation write-once check, per-field HLC last-write-wins) and
 * the seq/stream-position assignment run atomically inside a Redis Lua
 * script (redis/applyBatch.lua) so they stay correct under concurrent
 * writes from multiple instances - see that file for the algorithm, which
 * mirrors this module's step-1 in-memory version.
 */

import { randomUUID, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { redis } from "./redis/client.js";
import { watchVaultStream } from "./redis/streamWatcher.js";
import { BATCH_DEDUP_TTL_SECONDS, STREAM_MAXLEN } from "./redis/config.js";
import { readVaultRecords } from "./neo4j/materialize.js";
import type { Patch, Store } from "./patchApply.js";

const VAULTS_INDEX_KEY = "vaults:index";

export type PatchBatchInput = {
  nodeId: string;
  batchId: string;
  hlc: string;
  shape: string;
  patches: Patch[];
};

export type LogEntry = {
  seq: number;
  nodeId: string;
  batchId: string;
  hlc: string;
  shape: string;
  patches: Patch[];
};

export type ApplyResult =
  | { accepted: true; seq: number }
  | { accepted: false; seq: number; reason: string };

const metaKey = (vaultId: string) => `vault:${vaultId}:meta`;
const seqKey = (vaultId: string) => `vault:${vaultId}:seq`;
const storeKey = (vaultId: string) => `vault:${vaultId}:store`;
const hlcKey = (vaultId: string) => `vault:${vaultId}:hlc`;
export const streamKey = (vaultId: string) => `vault:${vaultId}:stream`;
const batchKey = (vaultId: string, batchId: string) => `vault:${vaultId}:batch:${batchId}`;

export async function createVault(): Promise<{ vaultId: string; vaultToken: string }> {
  const vaultId = randomUUID();
  const vaultToken = randomBytes(24).toString("base64url");
  const tokenHash = createHash("sha256").update(vaultToken).digest("hex");
  await redis().hset(metaKey(vaultId), { token: tokenHash, createdAt: Date.now() });
  // Lets the materializer (materializer.ts) discover this vault's stream
  // without scanning Redis's whole keyspace - see its doc comment.
  await redis().sadd(VAULTS_INDEX_KEY, vaultId);
  return { vaultId, vaultToken };
}

/** All known vault IDs, for the materializer's vault-discovery loop. */
export async function listVaultIds(): Promise<string[]> {
  return redis().smembers(VAULTS_INDEX_KEY);
}

export async function vaultExists(vaultId: string): Promise<boolean> {
  return (await redis().exists(metaKey(vaultId))) === 1;
}

export async function checkVaultToken(vaultId: string, token: string): Promise<boolean> {
  const storedHex = await redis().hget(metaKey(vaultId), "token");
  if (!storedHex) return false;
  const candidate = createHash("sha256").update(token).digest();
  const stored = Buffer.from(storedHex, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

export async function applyBatch(vaultId: string, input: PatchBatchInput): Promise<ApplyResult> {
  const [accepted, seq, reason] = await redis().applyBatch(
    seqKey(vaultId),
    storeKey(vaultId),
    hlcKey(vaultId),
    streamKey(vaultId),
    batchKey(vaultId, input.batchId),
    input.nodeId,
    input.hlc,
    input.shape,
    JSON.stringify(input.patches),
    String(BATCH_DEDUP_TTL_SECONDS),
    String(STREAM_MAXLEN),
    input.batchId,
  );
  return accepted === 1
    ? { accepted: true, seq }
    : { accepted: false, seq, reason: reason || "rejected" };
}

/**
 * Records come from Neo4j, not Redis's store hash: Neo4j is the durable
 * system of record (remote-sync-architecture.md §6.3-6.4), materialized
 * there asynchronously by materializer.ts, so a snapshot stays correct even
 * after Redis's copy has been trimmed/evicted or Redis has been restarted
 * with data loss. `seq` still comes from Redis - accepting new writes at
 * all already requires Redis to be up, so this doesn't add a new
 * dependency, and it saves tracking a second durable seq counter in Neo4j.
 */
export async function snapshot(vaultId: string): Promise<{ seq: number; records: Store }> {
  const [seqStr, records] = await Promise.all([redis().get(seqKey(vaultId)), readVaultRecords(vaultId)]);
  return { seq: Number(seqStr ?? 0), records };
}

/** Shared by entriesSince and the materializer's stream consumer. */
export function parseLogEntry([, fields]: [string, string[]]): LogEntry | undefined {
  const dataIndex = fields.indexOf("data");
  if (dataIndex === -1) return undefined;
  return JSON.parse(fields[dataIndex + 1]) as LogEntry;
}

/** Entries with seq > since, or undefined if `since` has fallen out of the retained (trimmed) stream. */
export async function entriesSince(vaultId: string, since: number): Promise<LogEntry[] | undefined> {
  const key = streamKey(vaultId);
  const [earliest, raw] = await Promise.all([
    redis().xrange(key, "-", "+", "COUNT", 1),
    redis().xrange(key, `(${since}-0`, "+"),
  ]);
  if (earliest.length > 0) {
    const earliestSeq = Number(earliest[0][0].split("-")[0]);
    if (since < earliestSeq - 1) return undefined; // gap: trimmed past the client's cursor
  }
  return raw.map(parseLogEntry).filter((entry): entry is LogEntry => entry !== undefined);
}

/**
 * Subscribe to a vault's live stream. Callers should complete their own
 * historical catch-up (entriesSince) both before and after calling this, to
 * close the handoff race against the shared per-process watcher - see
 * redis/streamWatcher.ts's doc comment. Returns an unsubscribe function.
 */
export function subscribeLive(vaultId: string, listener: (entry: LogEntry) => void): () => void {
  return watchVaultStream(streamKey(vaultId), listener);
}
