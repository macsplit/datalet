// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>.
// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * User story J3, end to end: create a shared tracker, pair a second device,
 * edit from both, take one device offline, reconnect, and prove both browsers
 * plus the materialized server snapshot converge.
 *
 * Requires the Vite client and sync HTTP server to be running. This process
 * starts its own real materializer, matching copyLinkScaleSmoke.ts, so a
 * separate dev:materializer process is neither required nor desirable.
 */

import { chromium, expect, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { closeNeo4j } from "../src/neo4j/client.js";
import { redis } from "../src/redis/client.js";
import { deleteVault, streamKey } from "../src/vaultStore.js";
import { startMaterializer } from "../src/materializer.js";
import { decodePairingCode } from "../../src/utils/pairingCode.ts";

const baseUrl = process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${process.env.VITE_PORT ?? "5173"}`;
const syncUrl = process.env.SMOKE_SYNC_URL ?? "http://127.0.0.1:3000";
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 30_000);

let vaultId = "";
let vaultToken = "";
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const materializer = process.env.SMOKE_EXTERNAL_MATERIALIZER === "1"
  ? undefined
  : await startMaterializer();

function progress(message: string) {
  console.log(`[user-story J3] ${message}`);
}

async function outboxCount(page: Page): Promise<number> {
  return page.evaluate((id) => {
    const raw = localStorage.getItem(`meta-ui-builder:sync-outbox:${id}`);
    return raw ? (JSON.parse(raw) as unknown[]).length : 0;
  }, vaultId);
}

async function localRecords(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() => {
    const index = JSON.parse(
      localStorage.getItem("meta-ui-builder:ng-local-store:index") ?? "[]",
    ) as string[];
    return index.flatMap((key) => {
      const raw = localStorage.getItem(`meta-ui-builder:ng-local-store:record:${key}`);
      return raw ? [JSON.parse(raw) as Record<string, unknown>] : [];
    });
  });
}

async function waitForOutboxToDrain(page: Page) {
  await expect.poll(() => outboxCount(page), { timeout: TIMEOUT_MS }).toBe(0);
}

async function snapshotRecords(): Promise<Array<Record<string, unknown>> | undefined> {
  if (!vaultId || !vaultToken) return undefined;
  const response = await fetch(`${syncUrl}/sync/snapshot?vault=${encodeURIComponent(vaultId)}`, {
    headers: { Authorization: `Bearer ${vaultToken}` },
  });
  if (!response.ok) return undefined;
  const body = await response.json() as {
    records?: Record<string, Record<string, unknown>>;
    materializerLag?: number | null;
    materializerPending?: number | null;
  };
  if (body.materializerLag !== 0 || body.materializerPending !== 0) return undefined;
  return Object.values(body.records ?? {});
}

async function snapshotRecord(title?: string): Promise<Record<string, unknown> | undefined> {
  return (await snapshotRecords())?.find((record) =>
    typeof record["@type"] === "string" &&
    record["@type"].startsWith("did:ng:z:user:") &&
    (title === undefined || record.Title === title));
}

async function assertHealthy(page: Page) {
  await expect(page.locator("#runtime-issue-banner")).toHaveCount(0, { timeout: TIMEOUT_MS });
  await expect(page.getByText(/failed local validation/)).toHaveCount(0);
}

async function makeDevice(): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  if (!browser) throw new Error("browser has not started");
  const context = await browser.newContext({
    extraHTTPHeaders: { "X-Forwarded-For": `user-story-j3-${randomUUID()}` },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors };
}

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined,
  });
  const first = await makeDevice();
  const second = await makeDevice();
  let secondStreamResponses = 0;
  second.page.on("response", (response) => {
    if (response.url().includes("/sync/stream?") && response.status() === 200) {
      secondStreamResponses += 1;
    }
  });

  progress("Device one is creating a sync vault and one-use pairing code");
  await first.page.goto(`${baseUrl}/settings/datalets`);
  await first.page.getByRole("button", { name: "Create sync vault" }).click();
  await expect(first.page.getByText("Connected", { exact: true })).toBeVisible({ timeout: TIMEOUT_MS });
  await first.page.getByRole("button", { name: "Show" }).click();
  const durableCode = await first.page.getByRole("textbox", { name: "Pairing code", exact: true }).inputValue();
  ({ vaultId, vaultToken } = decodePairingCode(durableCode));
  await first.page.getByRole("button", { name: "Create temporary code" }).click();
  const temporaryCode = await first.page.getByRole("textbox", { name: "Temporary pair code", exact: true }).inputValue();
  expect(temporaryCode).toMatch(/^PAIR-/);

  progress("Device one is building and populating a small shared notes tracker");
  await first.page.goto(`${baseUrl}/settings/schemas`);
  await first.page.getByRole("button", { name: "+ New schema" }).click();
  await first.page.getByLabel("Schema name").fill("Shared notes");
  await first.page.getByLabel("Schema name").press("Enter");
  await expect.poll(async () => (await snapshotRecords())?.some(
    (record) => record["@type"] === "did:ng:z:SchemaDef" && record.name === "Shared notes",
  ), { timeout: TIMEOUT_MS }).toBe(true);
  for (const [index, name] of ["Title", "Notes"].entries()) {
    await first.page.getByRole("button", { name: "+ Add property" }).click();
    const input = first.page.getByLabel("Name", { exact: true }).nth(index);
    await input.fill(name);
    await input.press("Enter");
    await expect.poll(async () => (await localRecords(first.page))
      .filter((record) => record["@type"] === "did:ng:z:PropertyDef")
      .map((record) => record.name)).toContain(name);
    await expect.poll(async () => (await snapshotRecords())?.some(
      (record) => record["@type"] === "did:ng:z:PropertyDef" && record.name === name,
    ), { timeout: TIMEOUT_MS }).toBe(true);
  }
  await first.page.getByLabel("Cardinality").nth(1).selectOption({ label: "Optional" });
  await first.page.getByLabel("Show records as").selectOption({ label: "Title" });
  await waitForOutboxToDrain(first.page);

  await first.page.goto(`${baseUrl}/settings/tabs/did:ng:z:HomeTab/blocks`);
  await first.page.getByLabel("Data block schema").selectOption({ label: "Shared notes" });
  await first.page.getByRole("button", { name: "+ Add data block" }).click();
  const dataBlock = first.page.locator("article.builder-card").filter({ hasText: "Data block" }).first();
  await dataBlock.locator(".builder-widget-card").last().getByLabel("Field display").selectOption({ label: "Long text" });
  await expect.poll(async () => (await localRecords(first.page)).some(
    (record) => record["@type"] === "did:ng:z:Widget" &&
      record.propertyName === "Notes" && record.fieldType === "did:ng:z:longText",
  ), { timeout: TIMEOUT_MS }).toBe(true);
  await expect.poll(async () => (await snapshotRecords())?.some(
    (record) => record["@type"] === "did:ng:z:Widget" &&
      record.propertyName === "Notes" && record.fieldType === "did:ng:z:longText",
  ), { timeout: TIMEOUT_MS }).toBe(true);
  await waitForOutboxToDrain(first.page);

  await first.page.goto(`${baseUrl}/`);
  await first.page.getByRole("button", { name: "+ Add Shared notes" }).click();
  const firstCard = first.page.locator(".record-card").first();
  await firstCard.getByRole("button", { name: "Edit record" }).click();
  await firstCard.getByLabel("Title").fill("Launch plan");
  await firstCard.getByLabel("Notes").fill("Initial outline from device one");
  await expect.poll(async () => (await localRecords(first.page)).find(
    (record) => record.Title === "Launch plan",
  )?.Notes).toBe("Initial outline from device one");
  await expect.poll(async () => (await snapshotRecord("Launch plan"))?.Notes, {
    timeout: TIMEOUT_MS,
  }).toBe("Initial outline from device one");
  await first.page.getByRole("button", { name: "Done editing" }).click();
  await waitForOutboxToDrain(first.page);

  progress("Waiting for the initial tracker to reach the materialized snapshot");
  try {
    await expect.poll(async () => (await snapshotRecord("Launch plan"))?.Notes, {
      timeout: TIMEOUT_MS,
    }).toBe("Initial outline from device one");
  } catch (error) {
    const response = await fetch(`${syncUrl}/sync/snapshot?vault=${encodeURIComponent(vaultId)}`, {
      headers: { Authorization: `Bearer ${vaultToken}` },
    });
    const redisClient = redis();
    console.error(JSON.stringify({
      snapshotStatus: response.status,
      snapshot: await response.json().catch(() => undefined),
      redisRecords: await redisClient.hgetall(`vault:${vaultId}:store`),
      outboxCount: await outboxCount(first.page),
    }));
    throw error;
  }

  progress("Device two is redeeming the real one-use code and opening the tracker");
  await second.page.goto(`${baseUrl}/settings/datalets`);
  await second.page.getByRole("textbox", { name: "Pairing code", exact: true }).fill(temporaryCode);
  await second.page.getByRole("button", { name: "Join vault" }).click();
  await expect(second.page.getByText("Connected", { exact: true })).toBeVisible({ timeout: TIMEOUT_MS });
  await second.page.goto(`${baseUrl}/`);
  await expect(second.page.getByText("Launch plan", { exact: true })).toBeVisible({ timeout: TIMEOUT_MS });
  await expect(second.page.getByText("Initial outline from device one", { exact: true })).toBeVisible();
  await expect.poll(() => secondStreamResponses, { timeout: TIMEOUT_MS }).toBeGreaterThan(0);
  const [firstNodeId, secondNodeId] = await Promise.all([first.page, second.page].map((page) =>
    page.evaluate(() => {
      const registry = JSON.parse(localStorage.getItem("meta-ui-builder:datalets") ?? "{}") as {
        activeId?: string;
        entries?: Array<{ id: string; vault?: { nodeId?: string } }>;
      };
      return registry.entries?.find((entry) => entry.id === registry.activeId)?.vault?.nodeId;
    })));
  expect(firstNodeId).toBeTruthy();
  expect(secondNodeId).toBeTruthy();
  expect(secondNodeId).not.toBe(firstNodeId);

  progress("Device one is making an online edit that device two receives live");
  await firstCard.getByRole("button", { name: "Edit record" }).click();
  await firstCard.getByLabel("Title").fill("Launch plan v2");
  await expect.poll(async () => (await localRecords(first.page)).some(
    (record) => record.Title === "Launch plan v2",
  )).toBe(true);
  await first.page.getByRole("button", { name: "Done editing" }).click();
  await expect.poll(async () => (await snapshotRecord("Launch plan v2"))?.Title, {
    timeout: TIMEOUT_MS,
  }).toBe("Launch plan v2");
  try {
    await expect(second.page.getByText("Launch plan v2", { exact: true })).toBeVisible({ timeout: TIMEOUT_MS });
  } catch (error) {
    console.error(JSON.stringify({
      secondStreamResponses,
      firstNodeId,
      secondNodeId,
      secondCursor: await second.page.evaluate((id) =>
        localStorage.getItem(`meta-ui-builder:sync-cursor:${id}`), vaultId),
      secondRecords: await localRecords(second.page),
      secondConnections: await second.page.evaluate(() => [
        ...((window as typeof window & {
          ormSignalConnections?: Map<string, unknown>;
        }).ormSignalConnections?.keys() ?? []),
      ]),
      latestServerEntries: await redis().xrevrange(streamKey(vaultId), "+", "-", "COUNT", 3),
      secondIssues: await second.page.locator("#runtime-issue-banner").allTextContents(),
      secondErrors: second.errors,
    }));
    throw error;
  }

  progress("Device two is going offline and editing a different field");
  await second.context.setOffline(true);
  const secondCard = second.page.locator(".record-card").first();
  await secondCard.getByRole("button", { name: "Edit record" }).click();
  await secondCard.getByLabel("Notes").fill("Offline notes from device two");
  await second.page.getByRole("button", { name: "Done editing" }).click();
  await expect.poll(() => outboxCount(second.page), { timeout: 5_000 }).toBeGreaterThan(0);

  progress("Device one is continuing online while device two remains disconnected");
  await firstCard.getByRole("button", { name: "Edit record" }).click();
  await firstCard.getByLabel("Title").fill("Launch plan final");
  await first.page.getByRole("button", { name: "Done editing" }).click();
  await expect.poll(async () => (await snapshotRecord("Launch plan final"))?.Title, {
    timeout: TIMEOUT_MS,
  }).toBe("Launch plan final");

  progress("Device two is reconnecting; its queued field edit must merge, not replace");
  await second.context.setOffline(false);
  await expect.poll(() => outboxCount(second.page), { timeout: TIMEOUT_MS }).toBe(0);
  await expect.poll(async () => {
    const record = await snapshotRecord("Launch plan final");
    return record && { Title: record.Title, Notes: record.Notes };
  }, { timeout: TIMEOUT_MS }).toEqual({
    Title: "Launch plan final",
    Notes: "Offline notes from device two",
  });

  progress("Both devices are converging on the same values without a reload");
  for (const page of [first.page, second.page]) {
    await expect(page.getByText("Launch plan final", { exact: true })).toBeVisible({ timeout: TIMEOUT_MS });
    await expect(page.getByText("Offline notes from device two", { exact: true })).toBeVisible({ timeout: TIMEOUT_MS });
    await assertHealthy(page);
  }
  expect(first.errors).toEqual([]);
  expect(second.errors).toEqual([]);

  await first.context.close();
  await second.context.close();
  progress("Complete: both devices and the materialized snapshot agree");
  console.log(JSON.stringify({
    ok: true,
    path: "device-1 -> vault -> one-use pair -> device-2 offline edit -> reconnect -> field-level convergence",
    vaultId,
  }));
} finally {
  await browser?.close();
  await materializer?.stop();
  if (vaultId) await deleteVault(vaultId).catch(() => undefined);
  redis().disconnect();
  await closeNeo4j();
}
