// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

// Cross-cutting settings shared by both durable tombstone stores (Redis's
// vault:<id>:tombstones hash and Neo4j's :Deleted nodes - see
// server/src/vaultStore.ts's sweepVaultTombstones and
// server/src/neo4j/materialize.ts's purgeExpiredTombstones), not owned by
// either store specifically.

// How long a tombstone is kept before it's eligible for purging
// (remote-sync-architecture.md §5's "e.g. 30 days"). Must comfortably
// exceed any realistic offline duration for a node holding a stale queued
// edit predating the delete - once a tombstone is purged, a stale edit
// older than the deletion can resurrect the record again, since there's no
// longer anything recording that it was ever deleted.
export const TOMBSTONE_RETENTION_MS = Number(process.env.TOMBSTONE_RETENTION_MS ?? 30 * 24 * 60 * 60 * 1000);

// How often the materializer sweeps all known vaults for expired
// tombstones (materializer.ts). Purging is a low-urgency background task
// relative to the retention window itself, so an hourly cadence is plenty.
export const TOMBSTONE_SWEEP_INTERVAL_MS = Number(process.env.TOMBSTONE_SWEEP_INTERVAL_MS ?? 60 * 60 * 1000);

// Vaults older than this with no later accepted write are reported by the
// materializer's maintenance sweep. Reporting is deliberately not deletion:
// retention policy belongs to the deployment operator.
const configuredVaultIdleReportAfterMs = Number(
  process.env.VAULT_IDLE_REPORT_AFTER_MS ?? 30 * 24 * 60 * 60 * 1000,
);
if (!Number.isFinite(configuredVaultIdleReportAfterMs) || configuredVaultIdleReportAfterMs < 1) {
  throw new Error("VAULT_IDLE_REPORT_AFTER_MS must be a positive number.");
}
export const VAULT_IDLE_REPORT_AFTER_MS = configuredVaultIdleReportAfterMs;
