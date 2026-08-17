import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, test } from "node:test";
import { createSyncServer } from "../src/httpServer.js";
import { redis } from "../src/redis/client.js";
import { closeNeo4j } from "../src/neo4j/client.js";
import { applyBatch } from "../src/vaultStore.js";

after(async () => {
  redis().disconnect();
  // An unknown vault falls through to Neo4j (vaultExists), which opens a
  // driver this process would otherwise keep open forever.
  await closeNeo4j();
});

const ADMIN_TOKEN = "admin-secret-token";

async function seedVault(): Promise<{ vaultId: string; vaultToken: string }> {
  const vaultId = randomUUID();
  const vaultToken = `admin-stats-token-${randomUUID()}`;
  await redis().hset(`vault:${vaultId}:meta`, {
    token: createHash("sha256").update(vaultToken).digest("hex"),
    createdAt: Date.now(),
  });
  await redis().set(`vault:${vaultId}:bytes`, "0");
  await redis().sadd("vaults:index", vaultId);
  return { vaultId, vaultToken };
}

async function dropVault(vaultId: string): Promise<void> {
  const keys = await redis().keys(`vault:${vaultId}:*`);
  if (keys.length > 0) await redis().del(...keys);
  await redis().srem("vaults:index", vaultId);
}

async function withServer<T>(
  adminToken: string,
  run: (origin: string) => Promise<T>,
): Promise<T> {
  const server = createSyncServer("/tmp/localgraph-no-static-files", { adminToken });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    // fetch keeps its sockets alive, and a kept-alive socket holds the server
    // (and this process) open long after the assertions are done.
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}

test("per-vault stats match independently computed Redis state", async (t) => {
  try {
    await redis().ping();
  } catch (error) {
    if (process.env.REQUIRE_SYNC_INTEGRATION === "1") throw error;
    t.skip(`Redis unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const { vaultId } = await seedVault();
  try {
    for (const suffix of ["a", "b"]) {
      const result = await applyBatch(vaultId, {
        nodeId: "admin-stats-test",
        batchId: `admin-stats-${suffix}`,
        hlc: `00000000000000${suffix === "a" ? "1" : "2"}-000000-admin-stats-test`,
        shape: "admin-stats-shape",
        patches: [
          { op: "add", path: `/subject-${suffix}` },
          { op: "add", path: `/subject-${suffix}/@id`, value: `subject-${suffix}` },
          { op: "add", path: `/subject-${suffix}/@graph`, value: vaultId },
          { op: "add", path: `/subject-${suffix}/value`, value: suffix },
        ],
      });
      assert.equal(result.accepted, true);
    }

    await withServer(ADMIN_TOKEN, async (origin) => {
      const response = await fetch(`${origin}/sync/admin/vaults?vault=${vaultId}`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(response.status, 200);
      const stats = await response.json() as Record<string, unknown>;

      const [records, storedBytes, seq, streamEntries] = await Promise.all([
        redis().hlen(`vault:${vaultId}:store`),
        redis().get(`vault:${vaultId}:bytes`),
        redis().get(`vault:${vaultId}:seq`),
        redis().xlen(`vault:${vaultId}:stream`),
      ]);

      assert.equal(stats.vaultId, vaultId);
      assert.equal(stats.records, records);
      assert.equal(stats.records, 2);
      assert.equal(stats.bytes, Number(storedBytes));
      assert.equal(stats.acceptedBatches, Number(seq));
      assert.equal(stats.streamEntries, streamEntries);
      assert.equal(stats.deleting, false);
      assert.ok(typeof stats.quotaBytes === "number" && stats.quotaBytes > 0);
      // No materializer has attached in this test, so every accepted entry is
      // still unread rather than silently reported as zero backlog.
      assert.equal(stats.materializerLag, null);
      assert.ok(typeof stats.lastActiveAt === "number");
    });
  } finally {
    await dropVault(vaultId);
  }
});

test("a vault token cannot read the admin API", async (t) => {
  try {
    await redis().ping();
  } catch (error) {
    if (process.env.REQUIRE_SYNC_INTEGRATION === "1") throw error;
    t.skip(`Redis unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const { vaultId, vaultToken } = await seedVault();
  try {
    await withServer(ADMIN_TOKEN, async (origin) => {
      // The credential that grants full read/write over this vault's data
      // must not grant a single number about any vault, including its own.
      for (const target of [
        `${origin}/sync/admin/vaults`,
        `${origin}/sync/admin/vaults?vault=${vaultId}`,
      ]) {
        const response = await fetch(target, {
          headers: { Authorization: `Bearer ${vaultToken}` },
        });
        assert.equal(response.status, 401);
      }

      const anonymous = await fetch(`${origin}/sync/admin/vaults`);
      assert.equal(anonymous.status, 401);
    });
  } finally {
    await dropVault(vaultId);
  }
});

test("the admin API does not exist when no operator secret is configured", async (t) => {
  try {
    await redis().ping();
  } catch (error) {
    if (process.env.REQUIRE_SYNC_INTEGRATION === "1") throw error;
    t.skip(`Redis unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  await withServer("", async (origin) => {
    const response = await fetch(`${origin}/sync/admin/vaults`, {
      headers: { Authorization: "Bearer anything-at-all" },
    });
    assert.equal(response.status, 404);
  });
});

test("listing pages through every vault without repeating one", async (t) => {
  try {
    await redis().ping();
  } catch (error) {
    if (process.env.REQUIRE_SYNC_INTEGRATION === "1") throw error;
    t.skip(`Redis unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const seeded = await Promise.all(Array.from({ length: 12 }, () => seedVault()));
  const expected = new Set(seeded.map(({ vaultId }) => vaultId));
  try {
    await withServer(ADMIN_TOKEN, async (origin) => {
      const seen = new Set<string>();
      let duplicates = 0;
      let cursor = "0";
      // SSCAN gives no ordering or per-page size guarantee, only that a full
      // cycle visits every member, so the assertion is coverage - not page
      // boundaries.
      do {
        const response = await fetch(
          `${origin}/sync/admin/vaults?limit=5&cursor=${encodeURIComponent(cursor)}`,
          { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
        );
        assert.equal(response.status, 200);
        const page = await response.json() as { cursor: string; vaults: Array<{ vaultId: string }> };
        for (const { vaultId } of page.vaults) {
          if (expected.has(vaultId)) {
            if (seen.has(vaultId)) duplicates += 1;
            seen.add(vaultId);
          }
        }
        cursor = page.cursor;
      } while (cursor !== "0");

      assert.equal(seen.size, expected.size);
      assert.equal(duplicates, 0);
    });
  } finally {
    await Promise.all(seeded.map(({ vaultId }) => dropVault(vaultId)));
  }
});

test("an unknown vault is a 404 rather than an empty report", async (t) => {
  try {
    await redis().ping();
  } catch (error) {
    if (process.env.REQUIRE_SYNC_INTEGRATION === "1") throw error;
    t.skip(`Redis unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  await withServer(ADMIN_TOKEN, async (origin) => {
    const response = await fetch(`${origin}/sync/admin/vaults?vault=${randomUUID()}`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    assert.equal(response.status, 404);
  });
});
