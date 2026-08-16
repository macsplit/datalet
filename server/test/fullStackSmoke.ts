import { chromium, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { closeNeo4j, neo4jSession } from "../src/neo4j/client.js";
import { redis } from "../src/redis/client.js";
import { decodePairingCode } from "../../src/utils/pairingCode.ts";

const baseUrl = process.env.SMOKE_BASE_URL ??
  `http://127.0.0.1:${process.env.VITE_PORT ?? "5173"}`;
const syncUrl = process.env.SMOKE_SYNC_URL ?? "http://127.0.0.1:3000";
const marker = `Full-stack smoke ${Date.now()}`;
let vaultId = "";
let vaultToken = "";

const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined,
});

try {
  const firstDevice = await browser.newContext();
  const firstPage = await firstDevice.newPage();
  const patchResponses: Array<{ status: number; request: string | null; body: string }> = [];
  firstPage.on("response", async (response) => {
    if (response.url().includes("/sync/patches")) {
      patchResponses.push({
        status: response.status(),
        request: response.request().postData(),
        body: await response.text(),
      });
    }
  });
  await firstPage.goto(`${baseUrl}/settings`);
  await firstPage.getByRole("button", { name: "Create sync vault" }).click();
  await expect(firstPage.getByText("Connected", { exact: true })).toBeVisible({ timeout: 15_000 });
  await firstPage.getByRole("button", { name: "Show" }).click();
  const pairingCode = await firstPage.getByLabel("Pairing code").inputValue();
  ({ vaultId, vaultToken } = decodePairingCode(pairingCode));
  await firstPage.getByRole("button", { name: "Create temporary code" }).click();
  const temporaryCode = await firstPage.getByLabel("Temporary pair code").inputValue();
  expect(temporaryCode).toMatch(/^PAIR-/);

  // Pairing reloads immediately, while the deterministic Settings singleton
  // is created after its ORM subscription becomes ready. Wait for that real
  // writable record instead of typing into the temporary fallback value.
  await expect.poll(() => firstPage.evaluate(() => {
    const indexKey = "meta-ui-builder:ng-local-store:index";
    const prefix = "meta-ui-builder:ng-local-store:record:";
    const ids = JSON.parse(localStorage.getItem(indexKey) ?? "[]") as string[];
    return ids.some((id) => {
      const raw = localStorage.getItem(prefix + id);
      return raw && JSON.parse(raw)["@id"] === "did:ng:z:SettingsSingleton";
    });
  }), { timeout: 15_000 }).toBe(true);
  await firstPage.getByLabel("Shown in the nav bar and browser tab").fill(marker);
  await expect.poll(() => firstPage.evaluate((expected) => {
    const indexKey = "meta-ui-builder:ng-local-store:index";
    const prefix = "meta-ui-builder:ng-local-store:record:";
    const ids = JSON.parse(localStorage.getItem(indexKey) ?? "[]") as string[];
    return ids.some((id) => {
      const raw = localStorage.getItem(prefix + id);
      return raw && JSON.parse(raw).appTitle === expected;
    });
  }, marker), { timeout: 5_000 }).toBe(true);

  try {
    await expect.poll(async () => {
      const response = await fetch(
        `${syncUrl}/sync/snapshot?vault=${encodeURIComponent(vaultId)}`,
        { headers: { Authorization: `Bearer ${vaultToken}` } },
      );
      if (!response.ok) return undefined;
      const body = await response.json() as {
        records?: Record<string, Record<string, unknown>>;
      };
      return Object.values(body.records ?? {}).find(
        (record) => record["@id"] === "did:ng:z:SettingsSingleton",
      )?.appTitle;
    }, { timeout: 20_000 }).toBe(marker);
  } catch (error) {
    const redisClient = redis();
    const redisRecords = await redisClient.hgetall(`vault:${vaultId}:store`);
    redisClient.disconnect();
    console.error(JSON.stringify({ patchResponses, redisRecords }));
    throw error;
  }

  const neo4j = neo4jSession();
  try {
    const result = await neo4j.run(
      "MATCH (r:Record {graph: $vaultId, appTitle: $marker}) RETURN count(r) AS count",
      { vaultId, marker },
    );
    expect(Number(result.records[0].get("count"))).toBe(1);
  } finally {
    await neo4j.close();
  }

  const secondDevice = await browser.newContext();
  const secondPage = await secondDevice.newPage();
  await secondPage.goto(`${baseUrl}/settings`);
  await secondPage.getByLabel("Pairing code").fill(temporaryCode);
  await secondPage.getByRole("button", { name: "Join vault" }).click();
  await expect(secondPage.getByText("Connected", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(secondPage.getByLabel("Shown in the nav bar and browser tab")).toHaveValue(
    marker,
    { timeout: 20_000 },
  );

  await firstDevice.close();
  await secondDevice.close();
  console.log(JSON.stringify({
    ok: true,
    path: "browser-1 -> sync -> Redis -> materializer -> Neo4j snapshot -> one-time pair code -> browser-2",
    vaultId,
  }));
} finally {
  await browser.close();
  if (vaultId) {
    const redisClient = redis();
    const keys = await redisClient.keys(`vault:${vaultId}:*`);
    if (keys.length > 0) await redisClient.del(...keys);
    await redisClient.srem("vaults:index", vaultId);
    redisClient.disconnect();

    const neo4j = neo4jSession();
    try {
      await neo4j.run(
        "MATCH (n) WHERE (n:Record AND n.graph = $vaultId) OR " +
          "(n:VaultMeta AND n.id = $vaultId) DETACH DELETE n",
        { vaultId },
      );
    } finally {
      await neo4j.close();
    }
  }
  await closeNeo4j();
}
