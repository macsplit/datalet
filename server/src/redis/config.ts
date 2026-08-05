// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

export const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

// Once a vault's Redis Stream is trimmed past a node's resume cursor, that
// node is told to fetch a full /sync/snapshot instead of replaying deltas -
// see entriesSince() in vaultStore.ts. This caps unbounded growth of a busy
// vault's stream.
export const STREAM_MAXLEN = 5_000;

// How long an idempotency record for one submitted batch is kept. A retried
// POST with the same batchId within this window returns the same seq
// without reapplying; after it expires a genuine retry would be reapplied
// (safe: patch application is itself idempotent per-field via HLC).
export const BATCH_DEDUP_TTL_SECONDS = 24 * 60 * 60;
