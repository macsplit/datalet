// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import neo4j, { type Driver } from "neo4j-driver";
import { NEO4J_DATABASE, NEO4J_PASSWORD, NEO4J_URL, NEO4J_USER } from "./config.js";

let sharedDriver: Driver | undefined;

export function neo4jDriver(): Driver {
  if (!sharedDriver) {
    // disableLosslessIntegers: this app's numeric fields are plain JS
    // numbers end to end (JSON over the wire, JS objects in the store) -
    // the driver's default lossless-Integer wrapper would silently change
    // their type on the way back out of Neo4j.
    sharedDriver = neo4j.driver(NEO4J_URL, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD), {
      disableLosslessIntegers: true,
    });
  }
  return sharedDriver;
}

export function neo4jSession() {
  return neo4jDriver().session({ database: NEO4J_DATABASE });
}

/**
 * Idempotent - safe to call on every process start. `(graph, id)` is this
 * app's upsert/lookup key (one record per subject per vault); `(graph,
 * type)` supports future partial/filtered snapshots (see
 * remote-sync-architecture.md §6.4) without a query-time full scan.
 */
export async function ensureNeo4jSchema(): Promise<void> {
  const session = neo4jSession();
  try {
    await session.run(
      "CREATE CONSTRAINT record_graph_id IF NOT EXISTS " +
        "FOR (r:Record) REQUIRE (r.graph, r.id) IS UNIQUE",
    );
    await session.run("CREATE INDEX record_graph_type IF NOT EXISTS FOR (r:Record) ON (r.graph, r.type)");
    await session.run(
      "CREATE CONSTRAINT vault_meta_id IF NOT EXISTS " +
        "FOR (v:VaultMeta) REQUIRE v.id IS UNIQUE",
    );
  } finally {
    await session.close();
  }
}

export async function closeNeo4j(): Promise<void> {
  await sharedDriver?.close();
  sharedDriver = undefined;
}
