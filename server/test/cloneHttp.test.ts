import assert from "node:assert/strict";
import { once } from "node:events";
import { after, test } from "node:test";
import { createSyncServer } from "../src/httpServer.js";
import { redis } from "../src/redis/client.js";
import { closeNeo4j } from "../src/neo4j/client.js";
import { applyBatch, createVault, deleteVault, readAcceptedRecords } from "../src/vaultStore.js";

after(async () => {
  redis().disconnect();
  await closeNeo4j();
});

async function withServer<T>(run: (origin: string) => Promise<T>): Promise<T> {
  // Copy redemption is rate-limited per IP, and every test here shares
  // 127.0.0.1. Clearing the counter keeps these tests about copying; the limit
  // itself is exercised where it belongs, in the pair-code tests.
  const counters = await redis().keys("clone:*");
  if (counters.length > 0) await redis().del(...counters);

  const server = createSyncServer("/tmp/localgraph-no-static-files");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}

/** A vault holding one record, which is what a copy has to carry across. */
async function seedVault() {
  const vault = await createVault();
  const result = await applyBatch(vault.vaultId, {
    nodeId: "seed",
    batchId: `seed-${vault.vaultId}`,
    hlc: "000000000000001-000000-seed",
    shape: "did:ng:z:Seed",
    patches: [
      { op: "add", path: "/subject-1" },
      { op: "add", path: "/subject-1/@id", value: "subject-1" },
      { op: "add", path: "/subject-1/@graph", value: `did:ng:${vault.vaultId}` },
      { op: "add", path: "/subject-1/@type", value: "did:ng:z:Tab" },
      { op: "add", path: "/subject-1/title", value: "Reference" },
    ],
  });
  assert.equal(result.accepted, true);
  return vault;
}

const skipWithoutInfra = async (t: { skip: (why: string) => void }) => {
  try {
    await redis().ping();
    return false;
  } catch (error) {
    if (process.env.REQUIRE_SYNC_INTEGRATION === "1") throw error;
    t.skip(`Redis unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
};

test("a copy code yields a separate vault, not access to the original", async (t) => {
  if (await skipWithoutInfra(t)) return;
  const source = await seedVault();
  const made: string[] = [];
  try {
    await withServer(async (origin) => {
      const issued = await fetch(`${origin}/sync/clone-codes?vault=${source.vaultId}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${source.vaultToken}` },
      });
      assert.equal(issued.status, 200);
      const { code } = await issued.json() as { code: string };
      assert.match(code, /^COPY-/);

      const redeemed = await fetch(`${origin}/sync/clone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      assert.equal(redeemed.status, 200);
      const clone = await redeemed.json() as { vaultId: string; vaultToken: string };
      made.push(clone.vaultId);

      // The property that makes this a clone and not a join.
      assert.notEqual(clone.vaultId, source.vaultId);
      assert.notEqual(clone.vaultToken, source.vaultToken);

      // The source's own credential is untouched by having been copied.
      const stillWorks = await fetch(`${origin}/sync/snapshot?vault=${source.vaultId}`, {
        headers: { Authorization: `Bearer ${source.vaultToken}` },
      });
      assert.equal(stillWorks.status, 200);

      // And the clone's token grants nothing over the source.
      const crossed = await fetch(`${origin}/sync/snapshot?vault=${source.vaultId}`, {
        headers: { Authorization: `Bearer ${clone.vaultToken}` },
      });
      assert.equal(crossed.status, 401);
    });
  } finally {
    for (const vaultId of made) await deleteVault(vaultId).catch(() => undefined);
    await deleteVault(source.vaultId).catch(() => undefined);
  }
});

test("the copy carries the records, rewritten into its own graph", async (t) => {
  if (await skipWithoutInfra(t)) return;
  const source = await seedVault();
  const made: string[] = [];
  try {
    await withServer(async (origin) => {
      const { code } = await (await fetch(`${origin}/sync/clone-codes?vault=${source.vaultId}`, {
        method: "POST", headers: { Authorization: `Bearer ${source.vaultToken}` },
      })).json() as { code: string };
      const clone = await (await fetch(`${origin}/sync/clone`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      })).json() as { vaultId: string };
      made.push(clone.vaultId);

      // Read the accepted state, not the Neo4j mirror: no materializer runs in
      // this test, and a copy is complete the moment the writes are accepted.
      const copied = await readAcceptedRecords(clone.vaultId);
      const record = copied["subject-1"];
      assert(record, "expected the record to be copied");
      assert.equal(record.title, "Reference");
      // Rewritten, or the clone would claim to belong to the source's graph.
      assert.equal(record["@graph"], `did:ng:${clone.vaultId}`);
    });
  } finally {
    for (const vaultId of made) await deleteVault(vaultId).catch(() => undefined);
    await deleteVault(source.vaultId).catch(() => undefined);
  }
});

test("a revoked code stops working, and revoking one leaves the others", async (t) => {
  if (await skipWithoutInfra(t)) return;
  const source = await seedVault();
  try {
    await withServer(async (origin) => {
      const issue = async () => (await (await fetch(
        `${origin}/sync/clone-codes?vault=${source.vaultId}`,
        { method: "POST", headers: { Authorization: `Bearer ${source.vaultToken}` } },
      )).json() as { code: string }).code;
      const first = await issue();
      const second = await issue();

      const listed = await (await fetch(`${origin}/sync/clone-codes?vault=${source.vaultId}`, {
        headers: { Authorization: `Bearer ${source.vaultToken}` },
      })).json() as { codes: { code: string }[] };
      // A code that cannot be found again cannot be withdrawn, so listing is
      // part of the feature rather than a convenience.
      assert.deepEqual(listed.codes.map((entry) => entry.code).sort(), [first, second].sort());

      const revoked = await fetch(
        `${origin}/sync/clone-codes?vault=${source.vaultId}&code=${encodeURIComponent(first)}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${source.vaultToken}` } },
      );
      assert.equal(revoked.status, 200);

      const afterRevoke = await fetch(`${origin}/sync/clone`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: first }),
      });
      assert.equal(afterRevoke.status, 404);

      const other = await fetch(`${origin}/sync/clone`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: second }),
      });
      assert.equal(other.status, 200);
      await deleteVault((await other.json() as { vaultId: string }).vaultId).catch(() => undefined);
    });
  } finally {
    await deleteVault(source.vaultId).catch(() => undefined);
  }
});

test("issuing and listing copy codes needs the vault's own token", async (t) => {
  if (await skipWithoutInfra(t)) return;
  const source = await seedVault();
  try {
    await withServer(async (origin) => {
      for (const method of ["POST", "GET", "DELETE"]) {
        const response = await fetch(`${origin}/sync/clone-codes?vault=${source.vaultId}`, {
          method, headers: { Authorization: "Bearer not-the-token" },
        });
        assert.equal(response.status, 401, `${method} should refuse a wrong token`);
      }
    });
  } finally {
    await deleteVault(source.vaultId).catch(() => undefined);
  }
});

test("a mistyped or unknown code is refused without saying which", async (t) => {
  if (await skipWithoutInfra(t)) return;
  await withServer(async (origin) => {
    const mistyped = await fetch(`${origin}/sync/clone`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "COPY-AAAA-AAAA-A" }),
    });
    // Either a checksum failure (400) or an unknown code (404); never a 500,
    // and never anything that distinguishes withdrawn from never-existed.
    assert.ok([400, 404].includes(mistyped.status), `got ${mistyped.status}`);
  });
});
