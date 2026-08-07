// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { redis } from "./client.js";

/**
 * Fixed-window request counter (not a sliding window or token bucket) - a
 * request right at a window boundary can technically let slightly more than
 * `limit` through over time. Acceptable here: this guards an abuse-
 * mitigation path (POST /sync/vaults), not a security-critical accept/
 * reject decision like applyBatch.lua's, so the simpler primitive is fine.
 * Returns true if the request is within the limit (and counts it either
 * way, so a client kept refused doesn't get free additional counted tries).
 */
export async function checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const count = await redis().incr(key);
  if (count === 1) {
    await redis().expire(key, windowSeconds);
  }
  return count <= limit;
}
