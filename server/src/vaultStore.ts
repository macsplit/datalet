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
import {
  BATCH_DEDUP_TTL_SECONDS,
  PAIR_CODE_TTL_SECONDS,
  STREAM_MAXLEN,
  VAULT_QUOTA_BYTES,
} from "./redis/config.js";
import { generatePairCode, normalizePairCode } from "./pairCode.js";
import {
  deleteVaultData,
  deleteVaultMeta,
  markVaultDeleting,
  purgeExpiredTombstones,
  readVaultMeta,
  readVaultRecords,
  upsertVaultMeta,
} from "./neo4j/materialize.js";
import { TOMBSTONE_RETENTION_MS } from "./config.js";
import { MATERIALIZER_GROUP } from "./neo4j/config.js";
import type { Patch, Store } from "./patchApply.js";

const VAULTS_INDEX_KEY = "vaults:index";
export const VAULT_DELETED_CHANNEL = "vault:lifecycle:deleted";

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
  | { accepted: true; seq: number; acceptedCount: number; submittedCount: number; reason?: string }
  | { accepted: false; seq: number; acceptedCount: number; submittedCount: number; reason: string };

const metaKey = (vaultId: string) => `vault:${vaultId}:meta`;
const seqKey = (vaultId: string) => `vault:${vaultId}:seq`;
const storeKey = (vaultId: string) => `vault:${vaultId}:store`;
const hlcKey = (vaultId: string) => `vault:${vaultId}:hlc`;
const bytesKey = (vaultId: string) => `vault:${vaultId}:bytes`;
export const streamKey = (vaultId: string) => `vault:${vaultId}:stream`;
const batchKey = (vaultId: string, batchId: string) => `vault:${vaultId}:batch:${batchId}`;
const tombstoneKey = (vaultId: string) => `vault:${vaultId}:tombstones`;
const streamTicketKey = (vaultId: string, ticketHash: string) =>
  `vault:${vaultId}:stream-ticket:${ticketHash}`;
const STREAM_TICKET_TTL_SECONDS = 60 * 60;
const pairCodeKey = (code: string) =>
  `vault:pair-code:${createHash("sha256").update(code).digest("hex")}`;

export async function createVault(): Promise<{ vaultId: string; vaultToken: string }> {
  const vaultId = randomUUID();
  const vaultToken = randomBytes(24).toString("base64url");
  const tokenHash = createHash("sha256").update(vaultToken).digest("hex");
  const createdAt = Date.now();
  await upsertVaultMeta({ vaultId, tokenHash, createdAt });
  try {
    await redis().hset(metaKey(vaultId), { token: tokenHash, createdAt });
    await redis().set(bytesKey(vaultId), "0");
    // Lets the materializer (materializer.ts) discover this vault's stream
    // without scanning Redis's whole keyspace - see its doc comment.
    await redis().sadd(VAULTS_INDEX_KEY, vaultId);
  } catch (error) {
    await redis().del(metaKey(vaultId), bytesKey(vaultId)).catch(() => undefined);
    await redis().srem(VAULTS_INDEX_KEY, vaultId).catch(() => undefined);
    await deleteVaultMeta(vaultId).catch(() => undefined);
    throw error;
  }
  return { vaultId, vaultToken };
}

/**
 * Issues a fresh token and immediately invalidates the old one (§9's
 * "only rotatable" promise for a leaked/compromised token). The old token
 * stops working the instant this returns - any other device still holding
 * it will get 401s until it's manually given the new one, which is
 * inherent to a shared-secret scheme with no per-device identity.
 */
export async function rotateVaultToken(vaultId: string): Promise<string> {
  const vaultToken = randomBytes(24).toString("base64url");
  const tokenHash = createHash("sha256").update(vaultToken).digest("hex");
  const previous = await redis().hgetall(metaKey(vaultId));
  const rotatedAt = Date.now();
  await redis().hset(metaKey(vaultId), { token: tokenHash, rotatedAt });
  try {
    await upsertVaultMeta({
      vaultId,
      tokenHash,
      createdAt: Number(previous.createdAt ?? rotatedAt),
      rotatedAt,
    });
  } catch (error) {
    if (previous.token) await redis().hset(metaKey(vaultId), previous);
    throw error;
  }
  return vaultToken;
}

/** All known vault IDs, for the materializer's vault-discovery loop. */
export async function listVaultIds(): Promise<string[]> {
  return redis().smembers(VAULTS_INDEX_KEY);
}

/**
 * One page of vault IDs. The admin API pages rather than reading the whole
 * index (listVaultIds) because it is the one caller whose cost scales with
 * tenant count on every request; the materializer reads the index whole
 * because it must own the complete set to shard it.
 */
export async function scanVaultIds(
  cursor: string,
  count: number,
): Promise<{ cursor: string; vaultIds: string[] }> {
  const [nextCursor, vaultIds] = await redis().sscan(VAULTS_INDEX_KEY, cursor, "COUNT", count);
  return { cursor: nextCursor, vaultIds };
}

export type VaultStats = {
  vaultId: string;
  records: number;
  tombstones: number;
  bytes: number;
  quotaBytes: number;
  acceptedBatches: number;
  streamEntries: number;
  materializerLag: number | null;
  materializerPending: number | null;
  createdAt: number | undefined;
  lastActiveAt: number | undefined;
  deleting: boolean;
};

function numberOrUndefined(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * How far the materializer is behind on this vault, read from the consumer
 * group rather than inferred: `lag` is entries the group has never read and
 * `pending` is entries it read but has not acknowledged, so the two together
 * separate "not started" from "started and stuck". Redis reports a null lag
 * when trimming has made it uncomputable, which is passed through rather
 * than flattened to zero - an unknown lag is not a healthy one.
 */
async function materializerBacklog(
  vaultId: string,
): Promise<{ lag: number | null; pending: number | null }> {
  try {
    const groups = await redis().xinfo("GROUPS", streamKey(vaultId)) as unknown[];
    for (const group of groups) {
      if (!Array.isArray(group)) continue;
      const fields = new Map<string, unknown>();
      for (let index = 0; index + 1 < group.length; index += 2) {
        fields.set(String(group[index]), group[index + 1]);
      }
      if (fields.get("name") !== MATERIALIZER_GROUP) continue;
      const lag = numberOrUndefined(fields.get("lag") as string | null);
      const pending = numberOrUndefined(fields.get("pending") as string | null);
      return { lag: lag ?? null, pending: pending ?? null };
    }
  } catch {
    // No stream yet, or no consumer group on it: nothing has been written or
    // no materializer has ever attached. Neither is an error to report here.
  }
  return { lag: null, pending: null };
}

/**
 * Per-vault numbers for the admin API and the materializer's structured
 * stats log. Read-only and best-effort: it never repairs what it observes,
 * so a drifting counter is reported rather than silently corrected.
 */
export async function vaultStats(vaultId: string): Promise<VaultStats> {
  const [records, tombstones, storedBytes, seq, streamEntries, meta, backlog] = await Promise.all([
    redis().hlen(storeKey(vaultId)),
    redis().hlen(tombstoneKey(vaultId)),
    redis().get(bytesKey(vaultId)),
    redis().get(seqKey(vaultId)),
    redis().xlen(streamKey(vaultId)),
    redis().hmget(metaKey(vaultId), "createdAt", "lastActiveAt", "deletingAt"),
    materializerBacklog(vaultId),
  ]);

  // A vault written before the quota landed has no byte counter until its
  // next accepted write backfills one inside applyBatch.lua. Summing the
  // stored records here reports the same number without writing it, since
  // only the atomic accept path may set it.
  let bytes = numberOrUndefined(storedBytes);
  if (bytes === undefined) {
    const stored = await redis().hvals(storeKey(vaultId));
    bytes = stored.reduce((total, record) => total + Buffer.byteLength(record), 0);
  }

  return {
    vaultId,
    records,
    tombstones,
    bytes,
    quotaBytes: VAULT_QUOTA_BYTES,
    acceptedBatches: numberOrUndefined(seq) ?? 0,
    streamEntries,
    materializerLag: backlog.lag,
    materializerPending: backlog.pending,
    createdAt: numberOrUndefined(meta[0]),
    lastActiveAt: numberOrUndefined(meta[1]),
    deleting: meta[2] !== null,
  };
}

export async function vaultExists(vaultId: string): Promise<boolean> {
  const cached = await redis().hgetall(metaKey(vaultId));
  if (cached.token) return !cached.deletingAt;
  const durable = await readVaultMeta(vaultId);
  if (!durable || durable.deletingAt !== undefined) return false;
  await redis().hset(metaKey(vaultId), {
    token: durable.tokenHash,
    createdAt: durable.createdAt,
    ...(durable.rotatedAt !== undefined && { rotatedAt: durable.rotatedAt }),
  });
  await redis().sadd(VAULTS_INDEX_KEY, vaultId);
  return true;
}

export async function checkVaultToken(vaultId: string, token: string): Promise<boolean> {
  if (!(await vaultExists(vaultId))) return false;
  const [storedHex, deletingAt] = await redis().hmget(metaKey(vaultId), "token", "deletingAt");
  if (!storedHex || deletingAt) return false;
  const candidate = createHash("sha256").update(token).digest();
  const stored = Buffer.from(storedHex, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

async function deleteVaultRedisKeys(vaultId: string): Promise<void> {
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis().scan(
      cursor,
      "MATCH",
      `vault:${vaultId}:*`,
      "COUNT",
      "1000",
    );
    cursor = nextCursor;
    if (keys.length > 0) await redis().unlink(...keys);
  } while (cursor !== "0");
}

/**
 * Permanently delete a vault. The Redis deleting marker closes the race with
 * already-authenticated writes (applyBatch.lua checks it atomically), while
 * the durable marker prevents vaultExists() from restoring credentials if a
 * later cleanup step fails. This operation is intentionally user-triggered;
 * idle-vault reporting never calls it.
 */
export async function deleteVault(vaultId: string): Promise<void> {
  const deletingAt = Date.now();
  await redis().hset(metaKey(vaultId), { deletingAt });
  try {
    await markVaultDeleting(vaultId, deletingAt);
  } catch (error) {
    await redis().hdel(metaKey(vaultId), "deletingAt").catch(() => undefined);
    throw error;
  }
  await redis().srem(VAULTS_INDEX_KEY, vaultId);
  await deleteVaultRedisKeys(vaultId);
  await deleteVaultData(vaultId);
  await redis().publish(VAULT_DELETED_CHANNEL, vaultId);
}

export async function vaultActivityAt(vaultId: string): Promise<number | undefined> {
  const meta = await redis().hmget(metaKey(vaultId), "lastActiveAt", "createdAt");
  const raw = meta[0] ?? meta[1];
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Issue a short-lived, stream-only credential so the vault token never appears in an SSE URL. */
export async function createStreamTicket(vaultId: string): Promise<string> {
  const ticket = randomBytes(24).toString("base64url");
  const hash = createHash("sha256").update(ticket).digest("hex");
  const [tokenHash, deletingAt] = await redis().hmget(metaKey(vaultId), "token", "deletingAt");
  if (!tokenHash || deletingAt) throw new Error("Cannot issue a stream ticket for an unknown vault.");
  // Bind the ticket to the current token generation. Rotation therefore
  // invalidates unused/reconnecting tickets without scanning ticket keys.
  await redis().set(
    streamTicketKey(vaultId, hash),
    tokenHash,
    "EX",
    STREAM_TICKET_TTL_SECONDS,
  );
  return ticket;
}

export async function checkStreamTicket(vaultId: string, ticket: string): Promise<boolean> {
  if (!ticket) return false;
  const hash = createHash("sha256").update(ticket).digest("hex");
  const [ticketGeneration, currentGeneration] = await Promise.all([
    redis().get(streamTicketKey(vaultId, hash)),
    redis().hget(metaKey(vaultId), "token"),
  ]);
  return Boolean(ticketGeneration && currentGeneration && ticketGeneration === currentGeneration);
}

export async function createPairCode(
  vaultId: string,
  vaultToken: string,
  ttlSeconds = PAIR_CODE_TTL_SECONDS,
): Promise<{ code: string; expiresAt: number }> {
  const tokenHash = createHash("sha256").update(vaultToken).digest("hex");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generatePairCode();
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const stored = await redis().set(
      pairCodeKey(code),
      JSON.stringify({ vaultId, vaultToken, tokenHash }),
      "EX",
      ttlSeconds,
      "NX",
    );
    if (stored === "OK") return { code, expiresAt };
  }
  throw new Error("Could not allocate a unique temporary pair code.");
}

export async function redeemPairCode(
  input: string,
): Promise<{ vaultId: string; vaultToken: string } | undefined> {
  const code = normalizePairCode(input);
  const serialized = await redis().get(pairCodeKey(code));
  if (!serialized) return undefined;
  const parsed = JSON.parse(serialized) as { vaultId?: string };
  if (!parsed.vaultId) {
    await redis().del(pairCodeKey(code));
    return undefined;
  }
  const redeemed = await redis().redeemPairCode(pairCodeKey(code), metaKey(parsed.vaultId));
  return redeemed ? { vaultId: redeemed[0], vaultToken: redeemed[1] } : undefined;
}

/** Backfill durable metadata for vaults created before Neo4j mirroring existed. */
export async function mirrorVaultMetadataToNeo4j(): Promise<number> {
  const vaultIds = await listVaultIds();
  let mirrored = 0;
  for (const vaultId of vaultIds) {
    const meta = await redis().hgetall(metaKey(vaultId));
    if (!meta.token) continue;
    await upsertVaultMeta({
      vaultId,
      tokenHash: meta.token,
      createdAt: Number(meta.createdAt ?? Date.now()),
      ...(meta.rotatedAt ? { rotatedAt: Number(meta.rotatedAt) } : {}),
    });
    mirrored += 1;
  }
  return mirrored;
}

export async function applyBatch(
  vaultId: string,
  input: PatchBatchInput,
  vaultQuotaBytes = VAULT_QUOTA_BYTES,
): Promise<ApplyResult> {
  if (!Number.isInteger(vaultQuotaBytes) || vaultQuotaBytes < 1) {
    throw new Error("vault quota must be a positive integer");
  }
  const [accepted, seq, reason, acceptedCount, submittedCount] = await redis().applyBatch(
    seqKey(vaultId),
    storeKey(vaultId),
    hlcKey(vaultId),
    streamKey(vaultId),
    batchKey(vaultId, input.batchId),
    tombstoneKey(vaultId),
    bytesKey(vaultId),
    metaKey(vaultId),
    input.nodeId,
    input.hlc,
    input.shape,
    JSON.stringify(input.patches),
    String(BATCH_DEDUP_TTL_SECONDS),
    String(STREAM_MAXLEN),
    input.batchId,
    String(vaultQuotaBytes),
    String(Date.now()),
  );
  return accepted === 1
    ? {
        accepted: true,
        seq,
        acceptedCount,
        submittedCount,
        ...(reason ? { reason } : {}),
      }
    : {
        accepted: false,
        seq,
        acceptedCount,
        submittedCount,
        reason: reason || "rejected",
      };
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
 * Purges tombstones older than TOMBSTONE_RETENTION_MS from both durable
 * stores (Neo4j's :Deleted nodes, this vault's Redis tombstone hash), so
 * neither grows unbounded with one entry per record ever deleted. Called
 * periodically by the materializer (materializer.ts) - see
 * remote-sync-architecture.md §5. Returns the number of tombstones purged,
 * for logging.
 */
export async function sweepVaultTombstones(vaultId: string): Promise<number> {
  const cutoffHlc = String(Date.now() - TOMBSTONE_RETENTION_MS).padStart(15, "0");
  const purgedIds = await purgeExpiredTombstones(vaultId, cutoffHlc);
  if (purgedIds.length > 0) {
    await redis().hdel(tombstoneKey(vaultId), ...purgedIds);
  }
  return purgedIds.length;
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
