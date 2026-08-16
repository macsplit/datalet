import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeNeo4j, neo4jDriver, neo4jSession } from "../src/neo4j/client.js";
import {
  BOUNDED_RECORD_TYPE_LABELS,
  sanitizeLabel,
  staleRecordTypeLabels,
} from "../src/neo4j/labels.js";
import { readRecord, upsertRecord } from "../src/neo4j/materialize.js";

const testGraphs: string[] = [];

async function integrationAvailable(): Promise<boolean> {
  try {
    await neo4jDriver().verifyConnectivity();
    return true;
  } catch (error) {
    if (process.env.REQUIRE_SYNC_INTEGRATION === "1") throw error;
    return false;
  }
}

async function databaseLabels(): Promise<Set<string>> {
  const session = neo4jSession();
  try {
    const result = await session.run("CALL db.labels() YIELD label RETURN label");
    return new Set(result.records.map((row) => String(row.get("label"))));
  } finally {
    await session.close();
  }
}

after(async () => {
  if (testGraphs.length > 0) {
    const session = neo4jSession();
    try {
      await session.run("MATCH (r:Record) WHERE r.graph IN $graphs DETACH DELETE r", {
        graphs: testGraphs,
      });
    } finally {
      await session.close();
    }
  }
  await closeNeo4j();
});

test("record type labels are a closed bounded set", () => {
  assert.equal(sanitizeLabel("did:ng:z:Tab"), "Type_Tab");
  assert.equal(sanitizeLabel("did:ng:z:Block"), "Type_Block");
  assert.equal(sanitizeLabel("did:ng:z:Widget"), "Type_Widget");
  assert.equal(sanitizeLabel("did:ng:z:SchemaDef"), "Type_SchemaDef");
  assert.equal(sanitizeLabel("did:ng:z:PropertyDef"), "Type_PropertyDef");
  assert.equal(sanitizeLabel("did:ng:z:Settings"), "Type_Settings");
  assert.equal(sanitizeLabel(`did:ng:z:user:${randomUUID()}`), "Type_User");
  assert.equal(sanitizeLabel("did:ng:z:Task`) MATCH (n) DETACH DELETE n //"), "Type_User");
  assert.equal(sanitizeLabel(undefined), "Type_User");
  assert.equal(BOUNDED_RECORD_TYPE_LABELS.size, 7);
});

test("cleanup selection accepts only safe stale Type labels", () => {
  assert.deepEqual(
    staleRecordTypeLabels([
      "Record",
      "Deleted",
      "Type_User",
      "Type_Tab",
      "Type_legacy_uuid_123",
      "Type_bad` MATCH (n)",
      "Type_",
    ]),
    ["Type_legacy_uuid_123"],
  );
});

test("changing a metadata type replaces its previous bounded label", async (t) => {
  if (!(await integrationAvailable())) {
    t.skip("Neo4j unavailable");
    return;
  }

  const graph = `a3-metadata-${randomUUID()}`;
  const subjectId = "changing-metadata-record";
  testGraphs.push(graph);
  await upsertRecord(graph, subjectId, {
    "@id": subjectId,
    "@graph": graph,
    "@type": "did:ng:z:Tab",
  });
  await upsertRecord(graph, subjectId, {
    "@id": subjectId,
    "@graph": graph,
    "@type": "did:ng:z:Block",
  });

  const session = neo4jSession();
  try {
    const result = await session.run(
      "MATCH (r:Record {graph: $graph, id: $subjectId}) RETURN r.type AS type, labels(r) AS labels",
      { graph, subjectId },
    );
    assert.equal(result.records[0].get("type"), "did:ng:z:Block");
    assert.deepEqual(
      (result.records[0].get("labels") as string[]).filter((label) => label.startsWith("Type_")),
      ["Type_Block"],
    );
  } finally {
    await session.close();
  }
});

test("50 user schemas across 10 vaults add at most Type_User and retain exact types", async (t) => {
  if (!(await integrationAvailable())) {
    t.skip("Neo4j unavailable");
    return;
  }

  const run = randomUUID();
  const graphs = Array.from({ length: 10 }, (_, index) => `a3-labels-${run}-${index}`);
  testGraphs.push(...graphs);
  const records = Array.from({ length: 50 }, (_, index) => ({
    graph: graphs[index % graphs.length],
    subjectId: `a3-subject-${index}`,
    type: `did:ng:z:user:${randomUUID()}`,
  }));
  const before = await databaseLabels();
  const session = neo4jSession();
  try {
    for (const [index, record] of records.entries()) {
      await upsertRecord(record.graph, record.subjectId, {
        "@id": record.subjectId,
        "@graph": record.graph,
        "@type": record.type,
        value: index,
      }, session);
    }
  } finally {
    await session.close();
  }

  const afterLabels = await databaseLabels();
  const introducedTypeLabels = [...afterLabels]
    .filter((label) => label.startsWith("Type_") && !before.has(label));
  assert.ok(introducedTypeLabels.every((label) => BOUNDED_RECORD_TYPE_LABELS.has(label)));

  const inspect = neo4jSession();
  try {
    const result = await inspect.run(
      "MATCH (r:Record) WHERE r.graph IN $graphs RETURN r.id AS id, r.type AS type, labels(r) AS labels",
      { graphs },
    );
    assert.equal(result.records.length, records.length);
    for (const row of result.records) {
      const labels = row.get("labels") as string[];
      assert.ok(labels.includes("Record"));
      assert.ok(labels.includes("Type_User"));
      assert.deepEqual(labels.filter((label) => label.startsWith("Type_")), ["Type_User"]);
      const expected = records.find((record) => record.subjectId === row.get("id"));
      assert.equal(row.get("type"), expected?.type);
    }
  } finally {
    await inspect.close();
  }

  for (const record of [records[0], records[records.length - 1]]) {
    assert.equal((await readRecord(record.graph, record.subjectId))?.["@type"], record.type);
  }
});
