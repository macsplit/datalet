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

// Counts the exact UTF-8 bytes of serialized record values in the vault's
// Redis store hash. This is intentionally twice the browser's 4 MiB safety
// ceiling, leaving room for builder metadata while placing a server-enforced
// bound on modified clients and direct API callers.
const configuredVaultQuotaBytes = Number(process.env.VAULT_QUOTA_BYTES ?? 8 * 1024 * 1024);
if (!Number.isInteger(configuredVaultQuotaBytes) || configuredVaultQuotaBytes < 1) {
  throw new Error("VAULT_QUOTA_BYTES must be a positive integer.");
}
export const VAULT_QUOTA_BYTES = configuredVaultQuotaBytes;

// POST /sync/vaults has no other gate (no accounts - anyone who can reach
// the server can create a vault), so it's rate-limited per client IP as
// basic abuse/storage-exhaustion mitigation (remote-sync-architecture.md
// §9). Identified via X-Forwarded-For (see httpServer.ts's clientIp) -
// this assumes a reverse proxy sits in front and sets that header
// truthfully, which the deployment doc already requires for TLS
// termination; if this server is ever exposed directly with no proxy in
// front, X-Forwarded-For becomes attacker-supplied and this limit is
// trivially bypassable.
export const VAULT_CREATE_RATE_LIMIT = Number(process.env.VAULT_CREATE_RATE_LIMIT ?? 10);
export const VAULT_CREATE_RATE_WINDOW_SECONDS = Number(process.env.VAULT_CREATE_RATE_WINDOW_SECONDS ?? 60 * 60);

export const PAIR_CODE_TTL_SECONDS = Number(process.env.PAIR_CODE_TTL_SECONDS ?? 10 * 60);
export const PAIR_REDEEM_RATE_LIMIT = Number(process.env.PAIR_REDEEM_RATE_LIMIT ?? 10);
export const PAIR_REDEEM_RATE_WINDOW_SECONDS = Number(process.env.PAIR_REDEEM_RATE_WINDOW_SECONDS ?? 60);
