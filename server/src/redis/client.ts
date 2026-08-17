// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Redis, type Result } from "ioredis";
import { REDIS_URL } from "./config.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const APPLY_BATCH_LUA = readFileSync(join(moduleDir, "applyBatch.lua"), "utf8");
const REDEEM_PAIR_CODE_LUA = readFileSync(join(moduleDir, "redeemPairCode.lua"), "utf8");
const MANAGE_SHARD_LEASE_LUA = readFileSync(join(moduleDir, "manageShardLease.lua"), "utf8");
const INCREMENT_RATE_LIMIT_LUA = readFileSync(join(moduleDir, "incrementRateLimit.lua"), "utf8");

declare module "ioredis" {
  interface RedisCommander<Context> {
    /**
     * Atomically accept/reject and apply one patch batch. See
     * redis/applyBatch.lua for the full contract. Returns
     * [accepted (0 or 1), seq, reason, accepted count, submitted count].
     */
    applyBatch(
      seqKey: string,
      storeKey: string,
      hlcKey: string,
      streamKey: string,
      batchKey: string,
      tombstoneKey: string,
      bytesKey: string,
      metaKey: string,
      nodeId: string,
      hlc: string,
      shape: string,
      patchesJson: string,
      batchTtlSeconds: string,
      streamMaxLen: string,
      batchId: string,
      vaultQuotaBytes: string,
      lastActiveAt: string,
    ): Result<[
      accepted: number,
      seq: number,
      reason: string,
      acceptedCount: number,
      submittedCount: number,
    ], Context>;
    redeemPairCode(
      pairCodeKey: string,
      vaultMetaKey: string,
    ): Result<[vaultId: string, vaultToken: string] | null, Context>;
    manageShardLease(
      leaseKey: string,
      owner: string,
      ttlSeconds: string,
    ): Result<number, Context>;
    incrementRateLimit(
      rateKey: string,
      windowSeconds: string,
    ): Result<number, Context>;
  }
}

let sharedClient: Redis | undefined;

/** The process-wide connection for ordinary (non-blocking) commands. */
export function redis(): Redis {
  if (!sharedClient) {
    sharedClient = new Redis(REDIS_URL);
    sharedClient.defineCommand("applyBatch", { numberOfKeys: 8, lua: APPLY_BATCH_LUA });
    sharedClient.defineCommand("redeemPairCode", { numberOfKeys: 2, lua: REDEEM_PAIR_CODE_LUA });
    sharedClient.defineCommand("manageShardLease", { numberOfKeys: 1, lua: MANAGE_SHARD_LEASE_LUA });
    sharedClient.defineCommand("incrementRateLimit", { numberOfKeys: 1, lua: INCREMENT_RATE_LIMIT_LUA });
  }
  return sharedClient;
}

/**
 * A fresh, independent connection for a blocking command (XREAD BLOCK).
 * ioredis connections can't serve other commands while blocked, so blocking
 * reads always get their own connection - see redis/streamWatcher.ts.
 */
export function newBlockingConnection(): Redis {
  return new Redis(REDIS_URL);
}
