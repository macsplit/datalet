// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createSyncServer } from "./httpServer.js";
import { REDIS_URL } from "./redis/config.js";
import { redis } from "./redis/client.js";
import { MATERIALIZER_SHARD_COUNT, MATERIALIZER_SHARD_INDEX, NEO4J_URL } from "./neo4j/config.js";
import { closeNeo4j, ensureNeo4jSchema, neo4jDriver } from "./neo4j/client.js";
import { startMaterializer } from "./materializer.js";
import { mirrorVaultMetadataToNeo4j } from "./vaultStore.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));

await redis().ping();
await neo4jDriver().verifyConnectivity();
await ensureNeo4jSchema();

// Same binary, two roles (remote-sync-architecture.md §6.3): the
// materializer is a separate deployable process from the HTTP ingest tier,
// selected by ROLE so both share one build/deploy artifact. Multiple
// `ROLE=materializer` processes can run at once when each has a distinct
// configured shard index within the same shard count.
if (process.env.ROLE === "materializer") {
  const materializer = await startMaterializer();
  console.log(
    `localgraph materializer shard ${MATERIALIZER_SHARD_INDEX}/${MATERIALIZER_SHARD_COUNT} started, ` +
      `redis ${REDIS_URL}, neo4j ${NEO4J_URL}`,
  );
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`localgraph materializer received ${signal}, releasing shard`);
    await materializer.stop();
    redis().disconnect();
    await closeNeo4j();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
} else {
  const mirroredVaults = await mirrorVaultMetadataToNeo4j();
  const staticDir = process.env.STATIC_DIR ?? resolve(moduleDir, "../dist");
  const port = Number(process.env.PORT ?? 3000);
  const server = createSyncServer(staticDir);
  server.listen(port, () => {
    console.log(
      `localgraph sync server listening on :${port}, serving ${staticDir}, redis ${REDIS_URL}, neo4j ${NEO4J_URL}`,
    );
    if (mirroredVaults > 0) console.log(`mirrored ${mirroredVaults} vault metadata records to Neo4j`);
  });
}
