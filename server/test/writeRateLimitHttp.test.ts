import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, test } from "node:test";
import { createSyncServer } from "../src/httpServer.js";
import { redis } from "../src/redis/client.js";
import { streamKey } from "../src/vaultStore.js";

after(() => redis().disconnect());

test("authenticated vault writes return 429 past the limit and recover after the window", async (t) => {
  try {
    await redis().ping();
  } catch (error) {
    if (process.env.REQUIRE_SYNC_INTEGRATION === "1") throw error;
    t.skip(`Redis unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const vaultId = randomUUID();
  const vaultToken = `write-rate-token-${randomUUID()}`;
  const tokenHash = createHash("sha256").update(vaultToken).digest("hex");
  await redis().hset(`vault:${vaultId}:meta`, { token: tokenHash, createdAt: Date.now() });
  await redis().set(`vault:${vaultId}:bytes`, "0");
  await redis().sadd("vaults:index", vaultId);

  const server = createSyncServer("/tmp/localgraph-no-static-files", {
    vaultWriteRateLimit: 1,
    vaultWriteRateWindowSeconds: 1,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/sync/patches?vault=${vaultId}`;

  const write = (suffix: string) => fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${vaultToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      nodeId: "write-rate-test",
      batchId: `write-rate-${suffix}`,
      hlc: `00000000000000${suffix === "a" ? "1" : "2"}-000000-write-rate-test`,
      shape: "write-rate-shape",
      patches: [
        { op: "add", path: `/subject-${suffix}` },
        { op: "add", path: `/subject-${suffix}/@id`, value: `subject-${suffix}` },
        { op: "add", path: `/subject-${suffix}/@graph`, value: vaultId },
        { op: "add", path: `/subject-${suffix}/value`, value: suffix },
      ],
    }),
  });

  try {
    const accepted = await write("a");
    assert.equal(accepted.status, 200);

    const refused = await write("b");
    assert.equal(refused.status, 429);
    assert.deepEqual(await refused.json(), {
      accepted: false,
      reason: "vault write rate limit exceeded - try again later",
    });
    assert.equal(await redis().xlen(streamKey(vaultId)), 1);
    assert.equal(await redis().hlen(`vault:${vaultId}:store`), 1);
    assert.ok((await redis().ttl(`vault:${vaultId}:wrate`)) > 0);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const retried = await write("b");
    assert.equal(retried.status, 200);
    assert.equal(await redis().xlen(streamKey(vaultId)), 2);
    assert.equal(await redis().hlen(`vault:${vaultId}:store`), 2);
  } finally {
    server.close();
    await once(server, "close");
    const keys = await redis().keys(`vault:${vaultId}:*`);
    if (keys.length > 0) await redis().del(...keys);
    await redis().srem("vaults:index", vaultId);
  }
});
