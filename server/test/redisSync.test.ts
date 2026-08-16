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
  createStreamTicket,
  createVault,
  entriesSince,
  rotateVaultToken,
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
  const preRotationTicket = await createStreamTicket(vaultId);
  assert.equal(await checkStreamTicket(vaultId, preRotationTicket), true);
  const rotated = await rotateVaultToken(vaultId);
  assert.equal(await checkVaultToken(vaultId, vaultToken), false);
  assert.equal(await checkVaultToken(vaultId, rotated), true);
  assert.equal(await checkStreamTicket(vaultId, preRotationTicket), false);
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
