import assert from "node:assert/strict";
import { once } from "node:events";
import { after, test } from "node:test";
import type { Server } from "node:http";
import { createSyncServer } from "../src/httpServer.js";
import { closeNeo4j, neo4jDriver } from "../src/neo4j/client.js";
import { readRecord, readVaultMeta, upsertRecord } from "../src/neo4j/materialize.js";
import { redis } from "../src/redis/client.js";
import {
  applyBatch,
  createStreamTicket,
  createVault,
  streamKey,
} from "../src/vaultStore.js";

after(async () => {
  redis().disconnect();
  await closeNeo4j();
});

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.close();
  await once(server, "close");
}

test("vault deletion removes both stores and disconnects SSE listeners on another replica", async (t) => {
  try {
    await Promise.all([redis().ping(), neo4jDriver().verifyConnectivity()]);
  } catch (error) {
    if (process.env.REQUIRE_SYNC_INTEGRATION === "1") throw error;
    t.skip(`Redis/Neo4j unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const { vaultId, vaultToken } = await createVault();
  const subjectId = "lifecycle-subject";
  const oldActivity = Date.now() - 60_000;
  await redis().hset(`vault:${vaultId}:meta`, "lastActiveAt", oldActivity);
  const accepted = await applyBatch(vaultId, {
    nodeId: "lifecycle-node",
    batchId: "lifecycle-accepted",
    hlc: "000000000002000-000000-lifecycle-node",
    shape: "lifecycle-shape",
    patches: [
      { op: "add", path: `/${subjectId}` },
      { op: "add", path: `/${subjectId}/@id`, value: subjectId },
      { op: "add", path: `/${subjectId}/@graph`, value: vaultId },
      { op: "add", path: `/${subjectId}/title`, value: "kept until deletion" },
    ],
  });
  assert.equal(accepted.accepted, true);
  const lastActiveAt = Number(await redis().hget(`vault:${vaultId}:meta`, "lastActiveAt"));
  assert.ok(lastActiveAt > oldActivity);

  const rejected = await applyBatch(vaultId, {
    nodeId: "lifecycle-node",
    batchId: "lifecycle-rejected",
    hlc: "000000000001000-000000-lifecycle-node",
    shape: "lifecycle-shape",
    patches: [{ op: "add", path: `/${subjectId}/title`, value: "stale" }],
  });
  assert.equal(rejected.accepted, false);
  assert.equal(Number(await redis().hget(`vault:${vaultId}:meta`, "lastActiveAt")), lastActiveAt);

  await upsertRecord(vaultId, subjectId, {
    "@id": subjectId,
    "@graph": vaultId,
    title: "durable",
  });
  await redis().set(`vault:${vaultId}:wrate`, "7", "EX", 60);
  const ticket = await createStreamTicket(vaultId);

  const deletingServer = createSyncServer("/tmp/localgraph-no-static-files");
  const streamingServer = createSyncServer("/tmp/localgraph-no-static-files");
  const [deletingBase, streamingBase] = await Promise.all([
    listen(deletingServer),
    listen(streamingServer),
  ]);

  try {
    // Let the second replica's lifecycle subscription become active before
    // attaching its stream. Deletion is published after all storage cleanup.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const streamResponse = await fetch(
      `${streamingBase}/sync/stream?vault=${vaultId}&ticket=${ticket}&since=1`,
    );
    assert.equal(streamResponse.status, 200);
    assert(streamResponse.body);
    const closed = streamResponse.body.getReader().read();

    const unauthorized = await fetch(`${deletingBase}/sync/vaults?vault=${vaultId}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(await redis().sismember("vaults:index", vaultId), 1);

    const deleted = await fetch(`${deletingBase}/sync/vaults?vault=${vaultId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${vaultToken}` },
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true });
    const streamEnd = await Promise.race([
      closed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("remote SSE listener did not disconnect")), 2_000)),
    ]);
    assert.equal(streamEnd.done, true);

    assert.equal(await redis().sismember("vaults:index", vaultId), 0);
    assert.deepEqual(await redis().keys(`vault:${vaultId}:*`), []);
    assert.equal(await readVaultMeta(vaultId), undefined);
    assert.equal(await readRecord(vaultId, subjectId), undefined);

    const afterDelete = await fetch(`${streamingBase}/sync/snapshot?vault=${vaultId}`, {
      headers: { Authorization: `Bearer ${vaultToken}` },
    });
    assert.equal(afterDelete.status, 404);

    const racedWrite = await applyBatch(vaultId, {
      nodeId: "lifecycle-node",
      batchId: "lifecycle-after-delete",
      hlc: "000000000003000-000000-lifecycle-node",
      shape: "lifecycle-shape",
      patches: [{ op: "add", path: "/resurrected/title", value: "no" }],
    });
    assert.equal(racedWrite.accepted, false);
    assert.deepEqual(await redis().keys(`vault:${vaultId}:*`), []);
    assert.equal(await redis().xlen(streamKey(vaultId)), 0);
  } finally {
    await Promise.all([close(deletingServer), close(streamingServer)]);
    const keys = await redis().keys(`vault:${vaultId}:*`);
    if (keys.length > 0) await redis().del(...keys);
    await redis().srem("vaults:index", vaultId);
  }
});
