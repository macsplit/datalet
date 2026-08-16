import assert from "node:assert/strict";
import { once } from "node:events";
import { after, test } from "node:test";
import { createSyncServer } from "../src/httpServer.js";
import { redis } from "../src/redis/client.js";
import { PAIR_REDEEM_RATE_LIMIT } from "../src/redis/config.js";

after(() => redis().disconnect());

test("temporary-code redemption is rate-limited per client IP", async (t) => {
  try {
    await redis().ping();
  } catch (error) {
    if (process.env.REQUIRE_SYNC_INTEGRATION === "1") throw error;
    t.skip(`Redis unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const server = createSyncServer("/tmp/localgraph-no-static-files");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const ip = `pair-test-${Date.now()}`;
  try {
    for (let attempt = 0; attempt < PAIR_REDEEM_RATE_LIMIT; attempt += 1) {
      const response = await fetch(`http://127.0.0.1:${address.port}/sync/pair-redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({ code: "not-a-code" }),
      });
      assert.equal(response.status, 400);
    }
    const refused = await fetch(`http://127.0.0.1:${address.port}/sync/pair-redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ code: "not-a-code" }),
    });
    assert.equal(refused.status, 429);
  } finally {
    server.close();
    await once(server, "close");
    await redis().del(`rate:pair-redeem:${ip}`);
  }
});
