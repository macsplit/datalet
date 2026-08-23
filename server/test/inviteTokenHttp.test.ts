import assert from "node:assert/strict";
import { once } from "node:events";
import { after, test } from "node:test";
import { createSyncServer } from "../src/httpServer.js";
import { redis } from "../src/redis/client.js";
import { deleteVault } from "../src/vaultStore.js";

const progress = (line: string) => process.stdout.write(`invite-token: ${line}\n`);

after(() => redis().disconnect());

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = createSyncServer("/tmp/localgraph-no-static-files");
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}

async function reachable(t: { skip: (reason: string) => void }): Promise<boolean> {
  try {
    await redis().ping();
    return true;
  } catch (error) {
    if (process.env.REQUIRE_SYNC_INTEGRATION === "1") throw error;
    t.skip(`Redis unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

test("a COPY code's invite token round-trips end to end through real HTTP", async (t) => {
  progress("checking reachability...");
  if (!(await reachable(t))) return;

  await withServer(async (base) => {
    progress("creating a vault...");
    const vault = await (await fetch(`${base}/sync/vaults`, { method: "POST" })).json() as
      { vaultId: string; vaultToken: string };

    try {
      progress("creating a clone (COPY) code for that vault...");
      const cloneRes = await fetch(`${base}/sync/clone-codes?vault=${vault.vaultId}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${vault.vaultToken}` },
      });
      assert.equal(cloneRes.status, 200, await cloneRes.clone().text());
      const { code } = await cloneRes.json() as { code: string };
      progress(`  got code ${code}`);

      progress("minting an invite token wrapping that code...");
      const tokenRes = await fetch(`${base}/sync/invite-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codeType: "COPY", code }),
      });
      assert.equal(tokenRes.status, 200, await tokenRes.clone().text());
      const { inviteToken, expiresAt } = await tokenRes.json() as { inviteToken: string; expiresAt: number };
      progress(`  got token ${inviteToken}, expires ${new Date(expiresAt).toISOString()}`);
      assert.match(inviteToken, /^[0-9a-f-]{36}$/, "invite token should be a UUID");
      assert.ok(expiresAt > Date.now(), "expiry must be in the future");
      assert.ok(expiresAt <= Date.now() + 7 * 24 * 60 * 60 * 1000 + 5_000, "expiry must be about 7 days out");

      progress("redeeming the invite token (first time - should succeed)...");
      const redeemRes = await fetch(`${base}/sync/invite-redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codeType: "COPY", inviteToken }),
      });
      assert.equal(redeemRes.status, 200, await redeemRes.clone().text());
      const { code: redeemedCode } = await redeemRes.json() as { code: string };
      assert.equal(redeemedCode, code, "redeemed code must match the original");
      progress(`  redeemed correctly: ${redeemedCode}`);

      progress("redeeming the same token again (should fail - single use)...");
      const secondRedeemRes = await fetch(`${base}/sync/invite-redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codeType: "COPY", inviteToken }),
      });
      assert.equal(secondRedeemRes.status, 404, "a second redemption must be refused");
      progress("  correctly refused second use");

      progress("redeeming with the wrong codeType (should fail)...");
      const wrongTypeRes = await fetch(`${base}/sync/invite-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codeType: "COPY", code }),
      });
      const { inviteToken: freshToken } = await wrongTypeRes.json() as { inviteToken: string };
      const crossTypeRes = await fetch(`${base}/sync/invite-redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codeType: "PAIR", inviteToken: freshToken }),
      });
      assert.equal(crossTypeRes.status, 404, "a COPY token must not redeem as PAIR");
      progress("  correctly refused cross-type redemption");
    } finally {
      await deleteVault(vault.vaultId).catch(() => undefined);
    }
  });
});

test("a nonexistent invite token is refused cleanly", async (t) => {
  progress("checking reachability...");
  if (!(await reachable(t))) return;

  await withServer(async (base) => {
    progress("redeeming a token that was never issued...");
    const res = await fetch(`${base}/sync/invite-redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codeType: "COPY", inviteToken: "00000000-0000-0000-0000-000000000000" }),
    });
    assert.equal(res.status, 404);
    progress("  correctly refused");
  });
});

test("invite token minting is rejected for a malformed code", async (t) => {
  progress("checking reachability...");
  if (!(await reachable(t))) return;

  await withServer(async (base) => {
    progress("trying to mint a token for garbage input...");
    const res = await fetch(`${base}/sync/invite-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codeType: "COPY", code: "not-a-real-code" }),
    });
    assert.equal(res.status, 400);
    progress("  correctly refused");
  });
});
