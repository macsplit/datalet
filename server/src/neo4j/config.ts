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

// Which consumer group all materializer processes share on every vault
// stream. A single shared group name is what makes multiple materializer
// processes divide a vault's entries between them safely (Redis guarantees
// each stream entry goes to exactly one consumer within a group) - not used
// yet at MVP scale (one process, see materializer.ts), but the group name
// is fixed now so a future multi-worker split doesn't need a migration.
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
