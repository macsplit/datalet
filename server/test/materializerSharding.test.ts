import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import {
  fnv1a,
  MaterializerService,
  materializerConsumerName,
  materializerShardFor,
} from "../src/materializer.js";
import { closeNeo4j, neo4jDriver, neo4jSession } from "../src/neo4j/client.js";
import { MATERIALIZER_GROUP } from "../src/neo4j/config.js";
import { readRecord } from "../src/neo4j/materialize.js";
import { redis } from "../src/redis/client.js";
import { streamKey, type LogEntry } from "../src/vaultStore.js";

const vaultIds: string[] = [];
const leaseKeys = new Set<string>();

function entry(vaultId: string, index: number): LogEntry {
  const subject = `sharded-subject-${index}`;
  return {
    seq: 1,
    nodeId: "sharding-test",
    batchId: `sharding-batch-${index}`,
    hlc: `${String(Date.now()).padStart(15, "0")}-000000-sharding-test`,
    shape: "did:ng:z:ShardingTest",
    patches: [
      { op: "add", path: `/${subject}` },
      { op: "add", path: `/${subject}/@id`, value: subject },
      { op: "add", path: `/${subject}/@graph`, value: vaultId },
      { op: "add", path: `/${subject}/@type`, value: "did:ng:z:ShardingTest" },
      { op: "add", path: `/${subject}/value`, value: index },
    ],
  };
}

async function seedStream(vaultId: string, index: number): Promise<void> {
  vaultIds.push(vaultId);
  await redis().sadd("vaults:index", vaultId);
  await redis().xadd(streamKey(vaultId), "1-0", "data", JSON.stringify(entry(vaultId, index)));
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
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
  for (const key of leaseKeys) await redis().del(key);
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

test("FNV-1a ownership and consumer names are deterministic", () => {
  assert.equal(fnv1a(""), 0x811c9dc5);
  assert.equal(fnv1a("a"), 0xe40c292c);
  assert.equal(fnv1a("foobar"), 0xbf9cf968);
  assert.equal(materializerConsumerName(0), "materializer-0");
  assert.equal(materializerConsumerName(7), "materializer-7");

  for (const vaultId of ["vault-a", "vault-b", "vault-c", "vault-d"]) {
    const owners = Array.from({ length: 4 }, (_, index) => index)
      .filter((index) => materializerShardFor(vaultId, 4) === index);
    assert.equal(owners.length, 1);
    assert.equal(materializerShardFor(vaultId, 4), materializerShardFor(vaultId, 4));
  }
});

test("two shard processes cover disjoint vault sets and materialize each stream once", async (t) => {
  if (!(await integrationAvailable())) {
    t.skip("Redis/Neo4j unavailable");
    return;
  }

  const prefix = `a2-shards-${randomUUID()}`;
  const ids = Array.from({ length: 12 }, (_, index) => `${prefix}-${index}`);
  for (let index = 0; index < ids.length; index += 1) await seedStream(ids[index], index);

  const services = [0, 1].map((shardIndex) => {
    leaseKeys.add(`materializer:shard:${shardIndex}`);
    return new MaterializerService({
      shardIndex,
      shardCount: 2,
      leaseSeconds: 3,
      heartbeatMs: 200,
      discoveryIntervalMs: 50,
      blockMs: 50,
      ownsVault: (vaultId) =>
        vaultId.startsWith(prefix) && materializerShardFor(vaultId, 2) === shardIndex,
    });
  });

  try {
    await Promise.all(services.map((service) => service.start()));
    await eventually(async () => {
      const records = await Promise.all(
        ids.map((vaultId, index) => readRecord(vaultId, `sharded-subject-${index}`)),
      );
      return records.every(Boolean);
    });

    const expected = [0, 1].map((shardIndex) =>
      ids.filter((vaultId) => materializerShardFor(vaultId, 2) === shardIndex));
    assert.equal(services[0].stats().watchedVaults, expected[0].length);
    assert.equal(services[1].stats().watchedVaults, expected[1].length);
    assert.equal(expected[0].length + expected[1].length, ids.length);
    assert.equal(expected[0].filter((vaultId) => expected[1].includes(vaultId)).length, 0);

    for (const [index, vaultId] of ids.entries()) {
      const consumers = await redis().xinfo("CONSUMERS", streamKey(vaultId), MATERIALIZER_GROUP);
      const names = (consumers as unknown[][]).map((fields) => fields[1]);
      assert.deepEqual(names, [materializerConsumerName(materializerShardFor(vaultId, 2))]);
      const pending = await redis().xpending(streamKey(vaultId), MATERIALIZER_GROUP);
      assert.equal(Number(pending[0]), 0, `vault ${index} should have no pending entries`);
    }
  } finally {
    await Promise.all(services.map((service) => service.stop()));
  }
});

test("a duplicate shard claim is loud and a graceful stop releases it", async (t) => {
  if (!(await integrationAvailable())) {
    t.skip("Redis/Neo4j unavailable");
    return;
  }

  const shardIndex = 97;
  const shardCount = 100;
  const leaseKey = `materializer:shard:${shardIndex}`;
  leaseKeys.add(leaseKey);
  const options = {
    shardIndex,
    shardCount,
    leaseSeconds: 3,
    heartbeatMs: 200,
    ownsVault: () => false,
  };
  const owner = new MaterializerService(options);
  const duplicate = new MaterializerService(options);
  const messages: string[] = [];
  const originalError = console.error;

  try {
    await owner.start();
    console.error = (...args: unknown[]) => messages.push(args.map(String).join(" "));
    await assert.rejects(duplicate.start(), /already claimed/);
    assert.ok(messages.some((message) => message.includes(`shard ${shardIndex}/${shardCount}`)));
    console.error = originalError;

    await owner.stop();
    assert.equal(await redis().exists(leaseKey), 0);
    await duplicate.start();
    assert.equal(await redis().exists(leaseKey), 1);
  } finally {
    console.error = originalError;
    await Promise.all([owner.stop(), duplicate.stop()]);
  }
});

test("a shard that loses its lease fails closed", async (t) => {
  if (!(await integrationAvailable())) {
    t.skip("Redis/Neo4j unavailable");
    return;
  }

  const shardIndex = 96;
  const shardCount = 100;
  const leaseKey = `materializer:shard:${shardIndex}`;
  const prefix = `a2-lost-lease-${randomUUID()}`;
  leaseKeys.add(leaseKey);
  await seedStream(`${prefix}-0`, 100);
  const service = new MaterializerService({
    shardIndex,
    shardCount,
    leaseSeconds: 3,
    heartbeatMs: 100,
    discoveryIntervalMs: 50,
    blockMs: 50,
    ownsVault: (vaultId) => vaultId.startsWith(prefix),
  });
  const messages: string[] = [];
  const originalError = console.error;

  try {
    await service.start();
    assert.equal(service.stats().watchedVaults, 1);
    console.error = (...args: unknown[]) => messages.push(args.map(String).join(" "));
    await redis().set(leaseKey, "replacement-owner", "EX", 3);
    await eventually(async () => service.stats().watchedVaults === 0);
    assert.ok(messages.some((message) => message.includes("LOST SHARD")));
    assert.equal(await redis().get(leaseKey), "replacement-owner");
  } finally {
    console.error = originalError;
    await service.stop();
  }
});
