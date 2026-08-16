import assert from "node:assert/strict";
import { after, test } from "node:test";
import { redis } from "../src/redis/client.js";
import { closeNeo4j, ensureNeo4jSchema, neo4jDriver, neo4jSession } from "../src/neo4j/client.js";
import {
  deleteVaultMeta,
  readRecord,
  tombstoneRecord,
  upsertRecord,
} from "../src/neo4j/materialize.js";
import {
  applyBatch,
  checkVaultToken,
  checkStreamTicket,
  createPairCode,
  createStreamTicket,
  createVault,
  entriesSince,
  rotateVaultToken,
  redeemPairCode,
  snapshot,
  streamKey,
  sweepVaultTombstones,
  vaultExists,
} from "../src/vaultStore.js";

const createdVaults: string[] = [];

after(async () => {
  const client = redis();
  for (const vaultId of createdVaults) {
    const keys = await client.keys(`vault:${vaultId}:*`);
    if (keys.length > 0) await client.del(...keys);
    await client.srem("vaults:index", vaultId);
    await deleteVaultMeta(vaultId).catch(() => undefined);
    const session = neo4jSession();
    await session.run("MATCH (r:Record {graph: $graph}) DETACH DELETE r", { graph: vaultId }).catch(() => undefined);
    await session.close();
  }
  client.disconnect();
  await closeNeo4j();
});

test("Redis sync path enforces token rotation, idempotency, LWW, and tombstones", async (t) => {
  try {
    await Promise.all([redis().ping(), neo4jDriver().verifyConnectivity()]);
    await ensureNeo4jSchema();
  } catch (error) {
    if (process.env.REQUIRE_SYNC_INTEGRATION === "1") throw error;
    t.skip(`Redis/Neo4j unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const { vaultId, vaultToken } = await createVault();
  createdVaults.push(vaultId);
  assert.equal(await checkVaultToken(vaultId, vaultToken), true);
  const oneTimePair = await createPairCode(vaultId, vaultToken);
  assert.deepEqual(await redeemPairCode(oneTimePair.code), { vaultId, vaultToken });
  assert.equal(await redeemPairCode(oneTimePair.code), undefined);

  const expiringPair = await createPairCode(vaultId, vaultToken, 1);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(await redeemPairCode(expiringPair.code), undefined);

  const preRotationTicket = await createStreamTicket(vaultId);
  const preRotationPair = await createPairCode(vaultId, vaultToken);
  assert.equal(await checkStreamTicket(vaultId, preRotationTicket), true);
  const rotated = await rotateVaultToken(vaultId);
  assert.equal(await checkVaultToken(vaultId, vaultToken), false);
  assert.equal(await checkVaultToken(vaultId, rotated), true);
  assert.equal(await checkStreamTicket(vaultId, preRotationTicket), false);
  assert.equal(await redeemPairCode(preRotationPair.code), undefined);
  const streamTicket = await createStreamTicket(vaultId);
  assert.equal(await checkStreamTicket(vaultId, streamTicket), true);
  assert.equal(await checkStreamTicket(vaultId, rotated), false);

  const subject = "subject-1";
  const initial = {
    nodeId: "node-a",
    batchId: "batch-initial",
    hlc: "000000000001000-000000-node-a",
    shape: "shape",
    patches: [
      { op: "add" as const, path: `/${subject}` },
      { op: "add" as const, path: `/${subject}/@id`, value: "record-1" },
      { op: "add" as const, path: `/${subject}/@graph`, value: vaultId },
      { op: "add" as const, path: `/${subject}/title`, value: "initial" },
    ],
  };
  const accepted = await applyBatch(vaultId, initial);
  assert.equal(accepted.accepted, true);
  assert.deepEqual(await applyBatch(vaultId, initial), accepted);
  assert.equal(await redis().xlen(streamKey(vaultId)), 1);

  const stale = await applyBatch(vaultId, {
    ...initial,
    batchId: "batch-stale",
    hlc: "000000000000999-000000-node-b",
    patches: [{ op: "add", path: `/${subject}/title`, value: "stale" }],
  });
  assert.equal(stale.accepted, false);
  assert.match(stale.reason, /superseded/);

  const partial = await applyBatch(vaultId, {
    ...initial,
    batchId: "batch-partial",
    hlc: "000000000001500-000000-node-b",
    patches: [
      { op: "add", path: `/${subject}/@id`, value: "duplicate-identity" },
      { op: "add", path: `/${subject}/subtitle`, value: "accepted field" },
    ],
  });
  assert.equal(partial.accepted, true);
  assert.equal(partial.acceptedCount, 1);
  assert.equal(partial.submittedCount, 2);
  assert.match(partial.reason ?? "", /superseded/);
  assert.deepEqual(await applyBatch(vaultId, {
    ...initial,
    batchId: "batch-partial",
    hlc: "000000000001500-000000-node-b",
    patches: [
      { op: "add", path: `/${subject}/@id`, value: "duplicate-identity" },
      { op: "add", path: `/${subject}/subtitle`, value: "accepted field" },
    ],
  }), partial);

  // An undo restores a field by removing it and re-adding the previous
  // value in one batch. Both patches carry the batch's single hlc, so the
  // re-add must not be rejected as superseded by the removal ahead of it --
  // that would leave the vault holding a bare deletion of the field.
  const undoShaped = await applyBatch(vaultId, {
    ...initial,
    batchId: "batch-undo",
    hlc: "000000000001800-000000-node-a",
    patches: [
      { op: "remove", path: `/${subject}/title` },
      { op: "add", path: `/${subject}/title`, value: "initial" },
    ],
  });
  assert.equal(undoShaped.accepted, true);
  assert.equal(undoShaped.acceptedCount, 2);
  assert.equal(undoShaped.submittedCount, 2);
  assert.equal(undoShaped.reason ?? "", "");
  // Read Redis directly: snapshot() serves Neo4j, which only catches up once
  // the materializer has drained the stream, and no materializer runs here.
  const afterUndo = await redis().hget(`vault:${vaultId}:store`, subject);
  assert.equal(JSON.parse(afterUndo ?? "{}").title, "initial");

  const deleted = await applyBatch(vaultId, {
    ...initial,
    batchId: "batch-delete",
    hlc: "000000000002000-000000-node-a",
    patches: [{ op: "remove", path: `/${subject}` }],
  });
  assert.equal(deleted.accepted, true);
  const staleRevival = await applyBatch(vaultId, {
    ...initial,
    batchId: "batch-stale-revival",
    hlc: "000000000001500-000000-node-b",
    patches: [{ op: "add", path: `/${subject}/title`, value: "revived-too-late" }],
  });
  assert.equal(staleRevival.accepted, false);
  assert.match(staleRevival.reason, /deleted after/);

  const freshRevival = await applyBatch(vaultId, {
    ...initial,
    batchId: "batch-fresh-revival",
    hlc: "000000000003000-000000-node-b",
    patches: [
      { op: "add", path: `/${subject}` },
      { op: "add", path: `/${subject}/@id`, value: "record-1" },
      { op: "add", path: `/${subject}/@graph`, value: vaultId },
      { op: "add", path: `/${subject}/title`, value: "revived" },
    ],
  });
  assert.equal(freshRevival.accepted, true);
  const replay = await entriesSince(vaultId, 0);
  assert.ok(replay);
  assert.deepEqual(
    replay.map((entry) => entry.batchId),
    ["batch-initial", "batch-partial", "batch-undo", "batch-delete", "batch-fresh-revival"],
  );

  const durableSubject = "durable-subject";
  await upsertRecord(vaultId, durableSubject, {
    "@id": "durable-record",
    "@graph": vaultId,
    "@type": "did:ng:z:DurableTest",
    value: "survives Redis loss",
  });
  const vaultKeys = await redis().keys(`vault:${vaultId}:*`);
  if (vaultKeys.length > 0) await redis().del(...vaultKeys);
  await redis().srem("vaults:index", vaultId);
  assert.equal(await vaultExists(vaultId), true);
  assert.equal(await checkVaultToken(vaultId, rotated), true);
  const recoveredSnapshot = await snapshot(vaultId);
  assert.equal(recoveredSnapshot.records[durableSubject]?.value, "survives Redis loss");

  const expiredSubject = "expired-tombstone";
  await upsertRecord(vaultId, expiredSubject, {
    "@id": expiredSubject,
    "@graph": vaultId,
    "@type": "did:ng:z:TombstoneTest",
  });
  await tombstoneRecord(vaultId, expiredSubject, "000000000000001-000000-test");
  await redis().hset(`vault:${vaultId}:tombstones`, expiredSubject, "000000000000001-000000-test");
  assert.equal(await sweepVaultTombstones(vaultId), 1);
  assert.equal(await readRecord(vaultId, expiredSubject), undefined);
  assert.equal(await redis().hget(`vault:${vaultId}:tombstones`, expiredSubject), null);
});

test("vault quota is atomic, credits deletion, and serializes concurrent writers", async (t) => {
  try {
    await Promise.all([redis().ping(), neo4jDriver().verifyConnectivity()]);
    await ensureNeo4jSchema();
  } catch (error) {
    if (process.env.REQUIRE_SYNC_INTEGRATION === "1") throw error;
    t.skip(`Redis/Neo4j unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const first = await createVault();
  createdVaults.push(first.vaultId);
  const subject = "quota-subject";
  const initial = await applyBatch(first.vaultId, {
    nodeId: "quota-node",
    batchId: "quota-initial",
    hlc: "000000000010000-000000-quota-node",
    shape: "quota-shape",
    patches: [
      { op: "add", path: `/${subject}` },
      { op: "add", path: `/${subject}/@id`, value: subject },
      { op: "add", path: `/${subject}/@graph`, value: first.vaultId },
      { op: "add", path: `/${subject}/value`, value: "under quota" },
    ],
  }, 1_024);
  assert.equal(initial.accepted, true);
  const initialBytes = Number(await redis().get(`vault:${first.vaultId}:bytes`));
  assert.ok(initialBytes > 0 && initialBytes < 1_024);

  const underQuota = await applyBatch(first.vaultId, {
    nodeId: "quota-node",
    batchId: "quota-under",
    hlc: "000000000011000-000000-quota-node",
    shape: "quota-shape",
    patches: [{ op: "add", path: `/${subject}/small`, value: "still fits 🌍" }],
  }, initialBytes + 100);
  assert.equal(underQuota.accepted, true);

  const beforeBytes = Number(await redis().get(`vault:${first.vaultId}:bytes`));
  const exactStoreBytes = (await redis().hvals(`vault:${first.vaultId}:store`))
    .reduce((total, raw) => total + Buffer.byteLength(raw), 0);
  assert.equal(beforeBytes, exactStoreBytes);
  await redis().del(`vault:${first.vaultId}:bytes`);
  const backfilled = await applyBatch(first.vaultId, {
    nodeId: "quota-node",
    batchId: "quota-backfill",
    hlc: "000000000011500-000000-quota-node",
    shape: "quota-shape",
    patches: [{ op: "add", path: `/${subject}/backfilled`, value: true }],
  }, beforeBytes + 100);
  assert.equal(backfilled.accepted, true);

  const projectedBytes = Number(await redis().get(`vault:${first.vaultId}:bytes`));
  assert.equal(
    projectedBytes,
    (await redis().hvals(`vault:${first.vaultId}:store`))
      .reduce((total, raw) => total + Buffer.byteLength(raw), 0),
  );
  const beforeStore = await redis().hgetall(`vault:${first.vaultId}:store`);
  const beforeHlc = await redis().hgetall(`vault:${first.vaultId}:hlc`);
  const beforeSeq = Number(await redis().get(`vault:${first.vaultId}:seq`));
  const beforeStreamLength = await redis().xlen(streamKey(first.vaultId));
  const crossing = await applyBatch(first.vaultId, {
    nodeId: "quota-node",
    batchId: "quota-crossing",
    hlc: "000000000012000-000000-quota-node",
    shape: "quota-shape",
    patches: [
      { op: "add", path: `/${subject}/large-a`, value: "a".repeat(200) },
      { op: "add", path: `/${subject}/large-b`, value: "b".repeat(200) },
    ],
  }, projectedBytes + 10);
  assert.equal(crossing.accepted, false);
  assert.equal(crossing.acceptedCount, 0);
  assert.equal(crossing.submittedCount, 2);
  assert.match(crossing.reason, /vault storage quota exceeded/);
  assert.deepEqual(await redis().hgetall(`vault:${first.vaultId}:store`), beforeStore);
  assert.deepEqual(await redis().hgetall(`vault:${first.vaultId}:hlc`), beforeHlc);
  assert.equal(Number(await redis().get(`vault:${first.vaultId}:bytes`)), projectedBytes);
  assert.equal(Number(await redis().get(`vault:${first.vaultId}:seq`)), beforeSeq);
  assert.equal(await redis().xlen(streamKey(first.vaultId)), beforeStreamLength);
  assert.equal(await redis().exists(`vault:${first.vaultId}:batch:quota-crossing`), 0);

  const removed = await applyBatch(first.vaultId, {
    nodeId: "quota-node",
    batchId: "quota-delete",
    hlc: "000000000013000-000000-quota-node",
    shape: "quota-shape",
    patches: [{ op: "remove", path: `/${subject}` }],
  }, 1);
  assert.equal(removed.accepted, true);
  assert.equal(await redis().hlen(`vault:${first.vaultId}:store`), 0);
  assert.equal(Number(await redis().get(`vault:${first.vaultId}:bytes`)), 0);

  const concurrent = await createVault();
  createdVaults.push(concurrent.vaultId);
  const payload = "x".repeat(220);
  const makeBatch = (suffix: string) => ({
    nodeId: `quota-${suffix}`,
    batchId: `quota-concurrent-${suffix}`,
    hlc: `000000000020000-000000-quota-${suffix}`,
    shape: "quota-shape",
    patches: [
      { op: "add" as const, path: `/subject-${suffix}` },
      { op: "add" as const, path: `/subject-${suffix}/@id`, value: `subject-${suffix}` },
      { op: "add" as const, path: `/subject-${suffix}/@graph`, value: concurrent.vaultId },
      { op: "add" as const, path: `/subject-${suffix}/value`, value: payload },
    ],
  });
  const recordBytes = ["a", "b"].map((suffix) => Buffer.byteLength(JSON.stringify({
    "@id": `subject-${suffix}`,
    "@graph": concurrent.vaultId,
    value: payload,
  })));
  const concurrentQuota = Math.max(...recordBytes) + 10;
  assert.ok(recordBytes.every((bytes) => bytes <= concurrentQuota));
  assert.ok(recordBytes[0] + recordBytes[1] > concurrentQuota);

  const concurrentResults = await Promise.all([
    applyBatch(concurrent.vaultId, makeBatch("a"), concurrentQuota),
    applyBatch(concurrent.vaultId, makeBatch("b"), concurrentQuota),
  ]);
  assert.equal(concurrentResults.filter((result) => result.accepted).length, 1);
  const refused = concurrentResults.find((result) => !result.accepted);
  assert.match(refused?.reason ?? "", /vault storage quota exceeded/);
  assert.equal(await redis().hlen(`vault:${concurrent.vaultId}:store`), 1);
  assert.equal(await redis().xlen(streamKey(concurrent.vaultId)), 1);
  assert.equal(Number(await redis().get(`vault:${concurrent.vaultId}:seq`)), 1);
  assert.ok(Number(await redis().get(`vault:${concurrent.vaultId}:bytes`)) <= concurrentQuota);
});
