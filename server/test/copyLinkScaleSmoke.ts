// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * The actual reported scenario, end to end, at realistic scale, with real
 * timing - not a mocked snapshot response, and not a source vault small
 * enough to have never exercised the materializer's real catch-up time.
 * A real browser opens a real invite link in a fresh context ("a different
 * browser altogether"), against a real HTTP server, a real Redis, a real
 * Neo4j, and a real in-process materializer - the same class of process the
 * production deployment runs, just started here rather than assumed to
 * already be running.
 *
 * `SMOKE_RECORD_COUNT` (default 2000) sizes the source vault. Prints the
 * seed time and the click-to-visible time; fails if the copy never becomes
 * visible within `SMOKE_TIMEOUT_MS` (default 35s - above the client's own
 * ~27s retry budget in dataletSwitch.ts, so a genuine timeout here means the
 * client would also have given up and shown an incomplete Home).
 */

import { chromium, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { closeNeo4j } from "../src/neo4j/client.js";
import { redis } from "../src/redis/client.js";
import { applyBatch, createVault, deleteVault } from "../src/vaultStore.js";
import type { Patch } from "../src/patchApply.js";
import { startMaterializer } from "../src/materializer.js";

const baseUrl = process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${process.env.VITE_PORT ?? "5173"}`;
const syncUrl = process.env.SMOKE_SYNC_URL ?? "http://127.0.0.1:3000";
const RECORD_COUNT = Number(process.env.SMOKE_RECORD_COUNT ?? 2000);
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 35_000);
const marker = `Scale smoke ${Date.now()}`;

const materializer = await startMaterializer();
let sourceVaultId = "";
let cloneVaultId = "";
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  const source = await createVault();
  sourceVaultId = source.vaultId;
  const graph = `did:ng:${source.vaultId}`;

  console.log(`seeding ${RECORD_COUNT} records into source vault ${sourceVaultId}...`);
  const seedStart = Date.now();
  const CHUNK = 200;
  for (let index = 0; index < RECORD_COUNT; index += CHUNK) {
    const patches: Patch[] = [];
    for (let record = index; record < Math.min(index + CHUNK, RECORD_COUNT); record += 1) {
      const id = `did:ng:z:record-${record}`;
      patches.push(
        { op: "add", path: `/${graph}|${id}` },
        { op: "add", path: `/${graph}|${id}/@id`, value: id },
        { op: "add", path: `/${graph}|${id}/@graph`, value: graph },
        { op: "add", path: `/${graph}|${id}/@type`, value: "did:ng:z:Note" },
        { op: "add", path: `/${graph}|${id}/title`, value: `Record ${record}` },
      );
    }
    const result = await applyBatch(source.vaultId, {
      nodeId: "seed",
      batchId: `seed-${index}`,
      hlc: `${String(Date.now()).padStart(15, "0")}-${String(index).padStart(6, "0")}-seed`,
      shape: "did:ng:z:Seed",
      patches,
    });
    if (!result.accepted) throw new Error(`seed batch at ${index} refused: ${result.reason}`);
    if (index % 2_000 === 0) console.log(`  ...${index}/${RECORD_COUNT} records accepted`);
  }
  // The marker tab: "the tab I added in the source" from the original
  // report. Deliberately not also seeding a HomeTab record here - the
  // client bootstraps its own the moment it opens the datalet
  // (MetaStoreContext.tsx), and a competing one written directly would
  // collide with that write under last-write-wins, which is a real
  // conflict-resolution feature working correctly, not a bug this test
  // means to exercise.
  const markerAccepted = await applyBatch(source.vaultId, {
    nodeId: "seed",
    batchId: "seed-marker-tab",
    hlc: `${String(Date.now()).padStart(15, "0")}-999999-seed`,
    shape: "did:ng:z:Seed",
    patches: [
      { op: "add", path: `/${graph}|did:ng:z:meta:tab:marker` },
      { op: "add", path: `/${graph}|did:ng:z:meta:tab:marker/@id`, value: "did:ng:z:meta:tab:marker" },
      { op: "add", path: `/${graph}|did:ng:z:meta:tab:marker/@graph`, value: graph },
      { op: "add", path: `/${graph}|did:ng:z:meta:tab:marker/@type`, value: "did:ng:z:Tab" },
      { op: "add", path: `/${graph}|did:ng:z:meta:tab:marker/title`, value: marker },
      { op: "add", path: `/${graph}|did:ng:z:meta:tab:marker/order`, value: 1 },
    ],
  });
  if (!markerAccepted.accepted) throw new Error(`marker tab refused: ${markerAccepted.reason}`);
  const seedMs = Date.now() - seedStart;
  console.log(`seeded ${RECORD_COUNT + 1} records in ${seedMs}ms`);

  // Real HTTP calls, the exact endpoints the client hits - not a shortcut.
  const codeResponse = await fetch(`${syncUrl}/sync/clone-codes?vault=${source.vaultId}`, {
    method: "POST", headers: { Authorization: `Bearer ${source.vaultToken}` },
  });
  const { code } = await codeResponse.json() as { code: string };
  const tokenResponse = await fetch(`${syncUrl}/sync/invite-token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ codeType: "COPY", code }),
  });
  const { inviteToken } = await tokenResponse.json() as { inviteToken: string };

  browser = await chromium.launch({
    headless: true,
    executablePath: existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined,
  });
  // A fresh context, matching "a different browser altogether" - no prior
  // localStorage, no prior session.
  const receiver = await browser.newContext({
    extraHTTPHeaders: { "X-Forwarded-For": `smoke-scale-${randomUUID()}` },
  });
  const page = await receiver.newPage();

  const clickStart = Date.now();
  await page.goto(`${baseUrl}/join?token=${inviteToken}`);
  await expect(page.getByRole("heading", { name: "Take a copy of a datalet" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Take a copy" }).click();

  // The real end-to-end path: the client's own retry logic, the real
  // materializer, the real render - not a mocked snapshot standing in for
  // any of it. waitForURL resolves the instant the address bar changes
  // (history.replaceState, ahead of adopt()'s own reload) - a plain
  // evaluate() right after that races the reload and hits a torn-down JS
  // context, so this waits for content unique to the post-reload page
  // instead, which Playwright auto-retries safely across navigations.
  await page.waitForURL(/\/settings\/datalets/, { timeout: TIMEOUT_MS });
  await expect(page.getByRole("heading", { name: "Switch datalet" })).toBeVisible({ timeout: TIMEOUT_MS });
  cloneVaultId = await page.evaluate(() =>
    (JSON.parse(localStorage.getItem("meta-ui-builder:datalets") ?? "{}") as { activeId?: string }).activeId ?? "");
  await page.goto(`${baseUrl}/`);
  await expect(page.getByText(marker)).toBeVisible({ timeout: TIMEOUT_MS });
  const elapsedMs = Date.now() - clickStart;

  // The marker tab alone proves *a* copy landed, not a *complete* one -
  // materialization is incremental, and the marker could easily be among
  // the first records to appear while most of the rest are still missing
  // (measured directly: 127/2000 visible at 11s, all 2000 only at 17s).
  // This is what would have caught the bug this test found: the client's
  // retry loop used to stop the moment any record appeared.
  //
  // Expected count is the seeded records (RECORD_COUNT + the marker tab)
  // plus 2 the client writes into any graph it opens on its own, unprompted
  // (a Settings singleton and a default Home tab - see
  // graphHasOnlyKnownBootstrapRecords in dataletSwitch.ts) - not something
  // this test seeded, but a real, expected part of what "fully open" means.
  const localRecordCount = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("meta-ui-builder:ng-local-store:index") ?? "[]").length);
  const CLIENT_BOOTSTRAP_RECORDS = 2;
  expect(localRecordCount).toBe(RECORD_COUNT + 1 + CLIENT_BOOTSTRAP_RECORDS);

  await receiver.close();
  console.log(JSON.stringify({
    ok: true,
    recordCount: RECORD_COUNT,
    localRecordCount,
    seedMs,
    clickToVisibleMs: elapsedMs,
    sourceVaultId,
    cloneVaultId,
  }));
} finally {
  await browser?.close();
  await materializer.stop();
  if (sourceVaultId) await deleteVault(sourceVaultId).catch(() => undefined);
  if (cloneVaultId) await deleteVault(cloneVaultId).catch(() => undefined);
  redis().disconnect();
  await closeNeo4j();
}
