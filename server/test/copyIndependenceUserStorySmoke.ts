// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>.
// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * User story J4, end to end: an established moderate-size datalet publishes a
 * copy link, a fresh browser accepts it, and ordinary edits on either side
 * remain independent in both browsers and both materialized snapshots.
 */

import { chromium, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { closeNeo4j } from "../src/neo4j/client.js";
import { redis } from "../src/redis/client.js";
import { applyBatch, createVault, deleteVault } from "../src/vaultStore.js";
import { startMaterializer } from "../src/materializer.js";
import type { Patch } from "../src/patchApply.js";
import { encodePairingCode } from "../../src/utils/pairingCode.ts";

const baseUrl = process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${process.env.VITE_PORT ?? "5173"}`;
const syncUrl = process.env.SMOKE_SYNC_URL ?? "http://127.0.0.1:3000";
const RECORD_COUNT = Number(process.env.SMOKE_RECORD_COUNT ?? 64);
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 30_000);

let sourceVaultId = "";
let cloneVaultId = "";
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const materializer = process.env.SMOKE_EXTERNAL_MATERIALIZER === "1"
  ? undefined
  : await startMaterializer();

function progress(message: string) {
  console.log(`[user-story J4] ${message}`);
}

function recordPatches(graph: string, record: Record<string, unknown>): Patch[] {
  const id = String(record["@id"]);
  const root = `/${graph}|${id}`;
  return [
    { op: "add", path: root },
    { op: "add", path: `${root}/@id`, value: id },
    { op: "add", path: `${root}/@graph`, value: graph },
    ...Object.entries(record)
      .filter(([key]) => key !== "@id" && key !== "@graph")
      .map(([key, value]) => ({ op: "add" as const, path: `${root}/${key}`, value })),
  ];
}

function sourceRecords(graph: string): Array<Record<string, unknown>> {
  const schemaId = "did:ng:z:meta:schema:shared-library";
  const blockId = "did:ng:z:meta:block:shared-library";
  const metadata: Array<Record<string, unknown>> = [
    { "@id": "did:ng:z:HomeTab", "@graph": graph, "@type": "did:ng:z:Tab", title: "Library", order: 0 },
    { "@id": "did:ng:z:SettingsSingleton", "@graph": graph, "@type": "did:ng:z:Settings", appTitle: "Shared library" },
    { "@id": schemaId, "@graph": graph, "@type": "did:ng:z:SchemaDef", name: "Library items", labelPropertyId: "property-title" },
    { "@id": "property-title", "@graph": graph, "@type": "did:ng:z:PropertyDef", schemaId, name: "Title", order: 0, dataType: "did:ng:z:text", cardinality: "did:ng:z:one" },
    { "@id": "property-status", "@graph": graph, "@type": "did:ng:z:PropertyDef", schemaId, name: "Status", order: 1, dataType: "did:ng:z:text", cardinality: "did:ng:z:one" },
    { "@id": "property-notes", "@graph": graph, "@type": "did:ng:z:PropertyDef", schemaId, name: "Notes", order: 2, dataType: "did:ng:z:text", cardinality: "did:ng:z:optional" },
    { "@id": blockId, "@graph": graph, "@type": "did:ng:z:Block", blockType: "did:ng:z:data", order: 0, schemaId, parentTabId: "did:ng:z:HomeTab", searchEnabled: true, pageSize: 12 },
    { "@id": "widget-heading", "@graph": graph, "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 0, widgetType: "did:ng:z:title", label: "Shared library" },
    { "@id": "widget-add", "@graph": graph, "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 1, widgetType: "did:ng:z:addButton", label: "Add library item" },
    { "@id": "widget-title", "@graph": graph, "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 2, widgetType: "did:ng:z:field", propertyName: "Title", label: "Title", fieldType: "did:ng:z:text" },
    { "@id": "widget-status", "@graph": graph, "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 3, widgetType: "did:ng:z:field", propertyName: "Status", label: "Status", fieldType: "did:ng:z:text" },
    { "@id": "widget-notes", "@graph": graph, "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 4, widgetType: "did:ng:z:field", propertyName: "Notes", label: "Notes", fieldType: "did:ng:z:longText" },
    { "@id": "widget-actions", "@graph": graph, "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 5, widgetType: "did:ng:z:editDeleteActions" },
  ];
  return [
    ...metadata,
    ...Array.from({ length: RECORD_COUNT }, (_, index) => ({
      "@id": `library-${String(index + 1).padStart(3, "0")}`,
      "@graph": graph,
      "@type": `did:ng:z:user:${schemaId}`,
      Title: `Shared item ${String(index + 1).padStart(2, "0")}`,
      Status: index % 3 === 0 ? "Reading" : "Queued",
      Notes: index % 5 === 0 ? "Discuss at the next meetup." : "",
    })),
  ];
}

async function settledSnapshot(vaultId: string, vaultToken: string) {
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

function userRecord(records: Array<Record<string, unknown>> | undefined, title: string) {
  return records?.find((record) => record.Title === title);
}

async function editTitle(page: Page, from: string, to: string) {
  const search = page.getByLabel("Search Library items");
  await search.fill(from);
  await expect(page.locator(".record-card")).toHaveCount(1);
  const card = page.locator(".record-card").first();
  await expect(card).toContainText(from);
  await card.getByRole("button", { name: "Edit record" }).click();
  await card.getByLabel("Title").fill(to);
  await card.getByRole("button", { name: "Done editing" }).click();
  await search.fill("");
}

async function assertHealthy(page: Page, errors: string[]) {
  await expect(page.locator("#runtime-issue-banner")).toHaveCount(0);
  await expect(page.getByText(/failed local validation/)).toHaveCount(0);
  expect(errors).toEqual([]);
}

try {
  progress(`Creating and seeding an established ${RECORD_COUNT}-record source datalet`);
  const source = await createVault();
  sourceVaultId = source.vaultId;
  const sourceGraph = `did:ng:${source.vaultId}`;
  const records = sourceRecords(sourceGraph);
  const CHUNK = 20;
  for (let index = 0; index < records.length; index += CHUNK) {
    const result = await applyBatch(source.vaultId, {
      nodeId: "user-story-j4-seed",
      batchId: `user-story-j4-seed-${index}`,
      hlc: `${String(Date.now()).padStart(15, "0")}-${String(index).padStart(6, "0")}-user-story-j4-seed`,
      shape: "did:ng:z:UserStoryJ4Seed",
      patches: records.slice(index, index + CHUNK).flatMap((record) => recordPatches(sourceGraph, record)),
    });
    if (!result.accepted) throw new Error(`source seed at ${index} refused: ${result.reason}`);
    if (index === 0 || index + CHUNK >= records.length) {
      progress(`Accepted ${Math.min(index + CHUNK, records.length)}/${records.length} source records`);
    }
  }
  await expect.poll(async () => (await settledSnapshot(source.vaultId, source.vaultToken))?.filter(
    (record) => typeof record["@type"] === "string" && record["@type"].startsWith("did:ng:z:user:"),
  ).length, { timeout: TIMEOUT_MS }).toBe(RECORD_COUNT);

  browser = await chromium.launch({
    headless: true,
    executablePath: existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined,
  });
  const sourceContext = await browser.newContext({
    extraHTTPHeaders: { "X-Forwarded-For": `user-story-j4-source-${randomUUID()}` },
  });
  const receiverContext = await browser.newContext({
    extraHTTPHeaders: { "X-Forwarded-For": `user-story-j4-receiver-${randomUUID()}` },
  });
  const sourcePage = await sourceContext.newPage();
  const receiverPage = await receiverContext.newPage();
  const sourceErrors: string[] = [];
  const receiverErrors: string[] = [];
  sourcePage.on("pageerror", (error) => sourceErrors.push(error.message));
  receiverPage.on("pageerror", (error) => receiverErrors.push(error.message));

  progress("Opening the established source in its owner's browser");
  await sourcePage.goto(`${baseUrl}/settings/datalets`);
  await sourcePage.getByLabel("Or open one from a code").fill(
    encodePairingCode(source.vaultId, source.vaultToken),
  );
  await sourcePage.getByRole("button", { name: "Add", exact: true }).click();
  await expect(sourcePage.getByText("Connected", { exact: true })).toBeVisible({ timeout: TIMEOUT_MS });
  await sourcePage.goto(`${baseUrl}/`);
  await expect(sourcePage.getByText(`Showing 1–12 of ${RECORD_COUNT}`)).toBeVisible({ timeout: TIMEOUT_MS });
  await expect(sourcePage.getByText("Shared item 01", { exact: true })).toBeVisible();

  progress("Publishing a copy link through the source browser's UI");
  await sourcePage.goto(`${baseUrl}/settings/datalets`);
  sourcePage.once("dialog", (dialog) => void dialog.accept());
  await sourcePage.getByRole("button", { name: "Create a copy code" }).click();
  const codeInput = sourcePage.getByLabel(/^Copy code COPY-/);
  await expect(codeInput).toBeVisible({ timeout: TIMEOUT_MS });
  const code = await codeInput.inputValue();
  const tokenResponsePromise = sourcePage.waitForResponse((response) =>
    response.url().includes("/sync/invite-token") && response.request().method() === "POST");
  await sourcePage.getByRole("button", { name: `Copy a link for the code ${code}` }).click();
  const tokenResponse = await tokenResponsePromise;
  expect(tokenResponse.status()).toBe(200);
  const { inviteToken } = await tokenResponse.json() as { inviteToken: string };

  progress("A fresh browser is accepting the link and waiting for the complete copy");
  await receiverPage.goto(`${baseUrl}/join?token=${inviteToken}`);
  await expect(receiverPage.getByRole("heading", { name: "Take a copy of a datalet" })).toBeVisible({ timeout: TIMEOUT_MS });
  await receiverPage.getByRole("button", { name: "Take a copy" }).click();
  await expect(receiverPage.getByRole("heading", { name: "Switch datalet" })).toBeVisible({ timeout: TIMEOUT_MS });
  const cloneVault = await receiverPage.evaluate(() => {
    const registry = JSON.parse(localStorage.getItem("meta-ui-builder:datalets") ?? "{}") as {
      activeId?: string;
      entries?: Array<{ id: string; vault?: { vaultId: string; vaultToken: string } }>;
    };
    return registry.entries?.find((entry) => entry.id === registry.activeId)?.vault;
  });
  if (!cloneVault) throw new Error("receiver did not retain the clone credentials");
  cloneVaultId = cloneVault.vaultId;
  expect(cloneVaultId).not.toBe(source.vaultId);
  await receiverPage.goto(`${baseUrl}/`);
  await expect(receiverPage.getByText(`Showing 1–12 of ${RECORD_COUNT}`)).toBeVisible({ timeout: TIMEOUT_MS });

  progress("Editing the copy and proving the original is unchanged");
  await editTitle(receiverPage, "Shared item 01", "Copy-only revision");
  await expect.poll(async () => userRecord(
    await settledSnapshot(cloneVault.vaultId, cloneVault.vaultToken),
    "Copy-only revision",
  )?.Title, { timeout: TIMEOUT_MS }).toBe("Copy-only revision");
  expect(userRecord(await settledSnapshot(source.vaultId, source.vaultToken), "Shared item 01")).toBeTruthy();
  await sourcePage.goto(`${baseUrl}/`);
  await expect(sourcePage.getByText("Shared item 01", { exact: true })).toBeVisible({ timeout: TIMEOUT_MS });
  await expect(sourcePage.getByText("Copy-only revision", { exact: true })).toHaveCount(0);

  progress("Editing the source and proving the copy is unchanged");
  await editTitle(sourcePage, "Shared item 02", "Source-only revision");
  await expect.poll(async () => userRecord(
    await settledSnapshot(source.vaultId, source.vaultToken),
    "Source-only revision",
  )?.Title, { timeout: TIMEOUT_MS }).toBe("Source-only revision");
  expect(userRecord(await settledSnapshot(cloneVault.vaultId, cloneVault.vaultToken), "Shared item 02")).toBeTruthy();
  await receiverPage.reload();
  await expect(receiverPage.getByText("Copy-only revision", { exact: true })).toBeVisible({ timeout: TIMEOUT_MS });
  await expect(receiverPage.getByText("Shared item 02", { exact: true })).toBeVisible();
  await expect(receiverPage.getByText("Source-only revision", { exact: true })).toHaveCount(0);

  await assertHealthy(sourcePage, sourceErrors);
  await assertHealthy(receiverPage, receiverErrors);
  await sourceContext.close();
  await receiverContext.close();
  progress("Complete: source and copy changed independently in both UI and storage");
  console.log(JSON.stringify({
    ok: true,
    recordCount: RECORD_COUNT,
    sourceVaultId,
    cloneVaultId,
    path: "source publishes -> fresh browser copies -> copy edit isolated -> source edit isolated",
  }));
} finally {
  await browser?.close();
  await materializer?.stop();
  if (sourceVaultId) await deleteVault(sourceVaultId).catch(() => undefined);
  if (cloneVaultId) await deleteVault(cloneVaultId).catch(() => undefined);
  redis().disconnect();
  await closeNeo4j();
}
