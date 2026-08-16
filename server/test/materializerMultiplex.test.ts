import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { MaterializerService } from "../src/materializer.js";
import { closeNeo4j, neo4jDriver, neo4jSession } from "../src/neo4j/client.js";
import { MATERIALIZER_GROUP } from "../src/neo4j/config.js";
import { readRecord } from "../src/neo4j/materialize.js";
import { newBlockingConnection, redis } from "../src/redis/client.js";
import { streamKey, type LogEntry } from "../src/vaultStore.js";

const vaultIds: string[] = [];

function entry(vaultId: string, index: number): LogEntry {
  const subject = `subject-${index}`;
  return {
    seq: 1,
    nodeId: "multiplex-test",
    batchId: `batch-${index}`,
    hlc: `${String(Date.now()).padStart(15, "0")}-000000-multiplex-test`,
    shape: "did:ng:z:MultiplexTest",
    patches: [
      { op: "add", path: `/${subject}` },
      { op: "add", path: `/${subject}/@id`, value: subject },
      { op: "add", path: `/${subject}/@graph`, value: vaultId },
      { op: "add", path: `/${subject}/@type`, value: "did:ng:z:MultiplexTest" },
      { op: "add", path: `/${subject}/title`, value: `Vault ${index}` },
    ],
  };
}

async function seedStream(vaultId: string, index: number) {
  vaultIds.push(vaultId);
  await redis().sadd("vaults:index", vaultId);
  await redis().xadd(streamKey(vaultId), "1-0", "data", JSON.stringify(entry(vaultId, index)));
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition did not become true before timeout");
}

async function integrationAvailable(): Promise<boolean> {
  try {
    await Promise.all([redis().ping(), neo4jDriver().verifyConnectivity()]);
    return true;
  } catch (error) {
    if (process.env.REQUIRE_SYNC_INTEGRATION === "1") throw error;
    return false;
  }
}

after(async () => {
  for (const vaultId of vaultIds) {
    const keys = await redis().keys(`vault:${vaultId}:*`);
    if (keys.length > 0) await redis().del(...keys);
    await redis().srem("vaults:index", vaultId);
  }
  if (vaultIds.length > 0) {
    const session = neo4jSession();
    try {
      await session.run("MATCH (r:Record) WHERE r.graph IN $vaultIds DETACH DELETE r", { vaultIds });
    } finally {
      await session.close();
    }
  }
  redis().disconnect();
  await closeNeo4j();
});

test("materializer multiplexes streams and discovers a late vault into spare capacity", async (t) => {
  if (!(await integrationAvailable())) {
    t.skip("Redis/Neo4j unavailable");
    return;
  }

  const prefix = `a1-live-${randomUUID()}`;
  for (let index = 0; index < 5; index += 1) await seedStream(`${prefix}-${index}`, index);
  const service = new MaterializerService(2, 50, 50, (vaultId) => vaultId.startsWith(prefix));
  try {
    await service.start();
    await eventually(async () => {
      const records = await Promise.all(
        Array.from({ length: 5 }, (_, index) => readRecord(`${prefix}-${index}`, `subject-${index}`)),
      );
      return records.every(Boolean);
    });
    assert.deepEqual(service.stats(), {
      watchedVaults: 5,
      streamBatches: 3,
      blockingConnections: 3,
    });
    const clients = await redis().client("LIST") as string;
    assert.equal(
      clients.split("\n").filter((line) => line.includes("name=localgraph-materializer-batch-")).length,
      3,
    );

    const lateVault = `${prefix}-late`;
    await seedStream(lateVault, 5);
    await eventually(async () => service.stats().watchedVaults === 6);
    await eventually(async () => Boolean(await readRecord(lateVault, "subject-5")));
    assert.equal(service.stats().streamBatches, 3);
  } finally {
    await service.stop();
  }
});

test("one multiplexed recovery read drains pending entries from every stream", async (t) => {
  if (!(await integrationAvailable())) {
    t.skip("Redis/Neo4j unavailable");
    return;
  }

  const prefix = `a1-recovery-${randomUUID()}`;
  const ids = [`${prefix}-0`, `${prefix}-1`];
  for (let index = 0; index < ids.length; index += 1) {
    await seedStream(ids[index], index + 10);
    await redis().xgroup("CREATE", streamKey(ids[index]), MATERIALIZER_GROUP, "0");
  }
  const crashed = newBlockingConnection();
  try {
    const keys = ids.map(streamKey);
    const delivered = await crashed.xreadgroup(
      "GROUP",
      MATERIALIZER_GROUP,
      "materializer-1",
      "COUNT",
      "50",
      "STREAMS",
      keys[0],
      keys[1],
      ">",
      ">",
    );
    assert.equal(delivered.length, 2);
  } finally {
    crashed.disconnect();
  }

  const service = new MaterializerService(64, 50, 50, (vaultId) => vaultId.startsWith(prefix));
  try {
    await service.start();
    await eventually(async () => {
      const records = await Promise.all(ids.map((vaultId, index) => readRecord(vaultId, `subject-${index + 10}`)));
      return records.every(Boolean);
    });
    for (const vaultId of ids) {
      const pending = await redis().xpending(streamKey(vaultId), MATERIALIZER_GROUP);
      assert.equal(Number(pending[0]), 0);
    }
    assert.equal(service.stats().blockingConnections, 1);
  } finally {
    await service.stop();
  }
});
