// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

export const NEO4J_URL = process.env.NEO4J_URL ?? "bolt://127.0.0.1:7687";
export const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
export const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "";
export const NEO4J_DATABASE = process.env.NEO4J_DATABASE ?? "neo4j";

// Every vault stream uses the same group. Deterministic sharding decides
// which process watches a vault, while the per-shard consumer name preserves
// pending-entry recovery across restarts.
export const MATERIALIZER_GROUP = "materializer";

// How often the materializer re-scans vaults:index for newly created vaults
// it isn't watching yet (see materializer.ts). Vault creation is rare
// compared to patch traffic, so a cheap poll is fine - no need for a
// pub/sub "new vault" signal at this scale.
export const VAULT_DISCOVERY_INTERVAL_MS = 3_000;

// Redis XREADGROUP accepts many streams in one blocking call. Keeping this
// bounded avoids one permanent connection per vault while limiting the
// head-of-line coupling of sequential Neo4j writes within a shared read.
const configuredStreamsPerConnection = Number(process.env.MATERIALIZER_STREAMS_PER_CONNECTION ?? 64);
export const MATERIALIZER_STREAMS_PER_CONNECTION =
  Number.isInteger(configuredStreamsPerConnection) && configuredStreamsPerConnection > 0
    ? configuredStreamsPerConnection
    : 64;

function integerEnvironment(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

export const MATERIALIZER_SHARD_COUNT = integerEnvironment("MATERIALIZER_SHARD_COUNT", 1, 1);
export const MATERIALIZER_SHARD_INDEX = integerEnvironment("MATERIALIZER_SHARD_INDEX", 0, 0);
if (MATERIALIZER_SHARD_INDEX >= MATERIALIZER_SHARD_COUNT) {
  throw new Error("MATERIALIZER_SHARD_INDEX must be smaller than MATERIALIZER_SHARD_COUNT.");
}

export const MATERIALIZER_SHARD_LEASE_SECONDS = integerEnvironment(
  "MATERIALIZER_SHARD_LEASE_SECONDS",
  15,
  2,
);
export const MATERIALIZER_SHARD_HEARTBEAT_MS = integerEnvironment(
  "MATERIALIZER_SHARD_HEARTBEAT_MS",
  5_000,
  100,
);
if (MATERIALIZER_SHARD_HEARTBEAT_MS >= MATERIALIZER_SHARD_LEASE_SECONDS * 1_000) {
  throw new Error("MATERIALIZER_SHARD_HEARTBEAT_MS must be shorter than the shard lease.");
}
