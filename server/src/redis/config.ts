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
// Redis store hash: a server-enforced bound on modified clients and direct API
// callers.
//
// Deliberately NOT a restatement of the browser's cap, and not to be "tidied"
// into parity with it. The two do different jobs - this one bounds an abusive
// tenant, `RUNTIME_LIMITS.storedBytes` keeps a store loadable - and they do not
// share a unit: this counts UTF-8 bytes (`#raw` over `cjson.encode` output in
// applyBatch.lua), the browser counts UTF-16 code units (`String.length`). They
// agree on ASCII and diverge sharply otherwise - `日本語` is 3 units and 9
// bytes, `🙂` is 2 and 4 - so a single shared number would cut a CJK user off at
// roughly a third of what an English user gets. See
// docs/datalet-add-and-clone-plan.md A2.
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

const configuredVaultWriteRateLimit = Number(process.env.VAULT_WRITE_RATE_LIMIT ?? 600);
const configuredVaultWriteRateWindowSeconds = Number(process.env.VAULT_WRITE_RATE_WINDOW_SECONDS ?? 60);
if (!Number.isInteger(configuredVaultWriteRateLimit) || configuredVaultWriteRateLimit < 1) {
  throw new Error("VAULT_WRITE_RATE_LIMIT must be a positive integer.");
}
if (!Number.isInteger(configuredVaultWriteRateWindowSeconds) || configuredVaultWriteRateWindowSeconds < 1) {
  throw new Error("VAULT_WRITE_RATE_WINDOW_SECONDS must be a positive integer.");
}
export const VAULT_WRITE_RATE_LIMIT = configuredVaultWriteRateLimit;
export const VAULT_WRITE_RATE_WINDOW_SECONDS = configuredVaultWriteRateWindowSeconds;
