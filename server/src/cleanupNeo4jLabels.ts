// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { pathToFileURL } from "node:url";
import { closeNeo4j, neo4jSession } from "./neo4j/client.js";
import { staleRecordTypeLabels } from "./neo4j/labels.js";

export type LabelCleanupResult = {
  staleLabels: string[];
  affectedNodes: number;
  applied: boolean;
};

/** Dry-run by default; pass apply=true only after reviewing staleLabels. */
export async function cleanupNeo4jLabels(apply = false): Promise<LabelCleanupResult> {
  const session = neo4jSession();
  try {
    const result = await session.run("CALL db.labels() YIELD label RETURN label");
    const candidates = staleRecordTypeLabels(result.records.map((row) => String(row.get("label"))));
    const staleLabels: string[] = [];
    let affectedNodes = 0;
    for (const label of candidates) {
      // staleRecordTypeLabels accepts only exact [A-Za-z0-9_] identifiers.
      // Cypher cannot parameterize labels, so keep that filter adjacent to
      // these deliberate interpolations.
      const matched = await session.run(
        `MATCH (r:Record:\`${label}\`) RETURN count(r) AS count`,
      );
      const count = Number(matched.records[0]?.get("count") ?? 0);
      if (count === 0) continue;
      staleLabels.push(label);
      affectedNodes += count;
      if (apply) {
        const removed = await session.run(
          `MATCH (r:Record:\`${label}\`) REMOVE r:\`${label}\` RETURN count(r) AS count`,
        );
        const removedCount = Number(removed.records[0]?.get("count") ?? 0);
        if (removedCount !== count) {
          throw new Error(
            `Neo4j label cleanup changed concurrently for ${label}: ` +
              `expected ${count}, removed ${removedCount}`,
          );
        }
      }
    }
    return { staleLabels, affectedNodes, applied: apply };
  } finally {
    await session.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const result = await cleanupNeo4jLabels(process.argv.includes("--apply"));
    console.log(JSON.stringify(result, null, 2));
    if (!result.applied && result.staleLabels.length > 0) {
      console.log("Dry run only. Re-run with --apply to remove these labels from Record nodes.");
    }
  } finally {
    await closeNeo4j();
  }
}
