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
import { BATCH_DEDUP_TTL_SECONDS, PAIR_CODE_TTL_SECONDS, STREAM_MAXLEN } from "./redis/config.js";
import { generatePairCode, normalizePairCode } from "./pairCode.js";
import {
  deleteVaultMeta,
  purgeExpiredTombstones,
  readVaultMeta,
  readVaultRecords,
  upsertVaultMeta,
} from "./neo4j/materialize.js";
import { TOMBSTONE_RETENTION_MS } from "./config.js";
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
  | { accepted: true; seq: number; acceptedCount: number; submittedCount: number; reason?: string }
  | { accepted: false; seq: number; acceptedCount: number; submittedCount: number; reason: string };

const metaKey = (vaultId: string) => `vault:${vaultId}:meta`;
const seqKey = (vaultId: string) => `vault:${vaultId}:seq`;
const storeKey = (vaultId: string) => `vault:${vaultId}:store`;
const hlcKey = (vaultId: string) => `vault:${vaultId}:hlc`;
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
    // Lets the materializer (materializer.ts) discover this vault's stream
    // without scanning Redis's whole keyspace - see its doc comment.
    await redis().sadd(VAULTS_INDEX_KEY, vaultId);
  } catch (error) {
    await redis().del(metaKey(vaultId)).catch(() => undefined);
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

export async function vaultExists(vaultId: string): Promise<boolean> {
  if ((await redis().exists(metaKey(vaultId))) === 1) return true;
  const durable = await readVaultMeta(vaultId);
  if (!durable) return false;
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
  const storedHex = await redis().hget(metaKey(vaultId), "token");
  if (!storedHex) return false;
  const candidate = createHash("sha256").update(token).digest();
  const stored = Buffer.from(storedHex, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

/** Issue a short-lived, stream-only credential so the vault token never appears in an SSE URL. */
export async function createStreamTicket(vaultId: string): Promise<string> {
  const ticket = randomBytes(24).toString("base64url");
  const hash = createHash("sha256").update(ticket).digest("hex");
  const tokenHash = await redis().hget(metaKey(vaultId), "token");
  if (!tokenHash) throw new Error("Cannot issue a stream ticket for an unknown vault.");
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

export async function applyBatch(vaultId: string, input: PatchBatchInput): Promise<ApplyResult> {
  const [accepted, seq, reason, acceptedCount, submittedCount] = await redis().applyBatch(
    seqKey(vaultId),
    storeKey(vaultId),
    hlcKey(vaultId),
    streamKey(vaultId),
    batchKey(vaultId, input.batchId),
    tombstoneKey(vaultId),
    input.nodeId,
    input.hlc,
    input.shape,
    JSON.stringify(input.patches),
    String(BATCH_DEDUP_TTL_SECONDS),
    String(STREAM_MAXLEN),
    input.batchId,
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
