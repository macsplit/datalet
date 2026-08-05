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

declare module "ioredis" {
  interface RedisCommander<Context> {
    /**
     * Atomically accept/reject and apply one patch batch. See
     * redis/applyBatch.lua for the full contract. Returns
     * [accepted (0 or 1), seq, reason].
     */
    applyBatch(
      seqKey: string,
      storeKey: string,
      hlcKey: string,
      streamKey: string,
      batchKey: string,
      nodeId: string,
      hlc: string,
      shape: string,
      patchesJson: string,
      batchTtlSeconds: string,
      streamMaxLen: string,
      batchId: string,
    ): Result<[accepted: number, seq: number, reason: string], Context>;
  }
}

let sharedClient: Redis | undefined;

/** The process-wide connection for ordinary (non-blocking) commands. */
export function redis(): Redis {
  if (!sharedClient) {
    sharedClient = new Redis(REDIS_URL);
    sharedClient.defineCommand("applyBatch", { numberOfKeys: 5, lua: APPLY_BATCH_LUA });
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
