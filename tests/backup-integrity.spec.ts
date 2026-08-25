// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { expect, test, type Download, type Page } from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A backup's integrity hash exists so a hand-edited file is detectable on
 * import rather than silently accepted as a genuine export - see
 * `docs/roadmap.md`. These tests exercise the real export/import UI, not the
 * underlying functions directly, so a regression here is a regression a user
 * would actually hit.
 */

const GRAPH = "did:ng:test-private-store";

async function seed(page: Page) {
  await page.addInitScript(() => {
    if (localStorage.getItem("backup-int-seeded")) return;
    localStorage.clear();
    localStorage.setItem("backup-int-seeded", "1");
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "backup-int", private_store_id: "test-private-store",
    }));
    const graph = "did:ng:test-private-store";
    const records = [
      { "@graph": graph, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Home", order: 0 },
      { "@graph": graph, "@id": "keep-me", "@type": "did:ng:z:user:s", Title: "Original" },
    ];
    const ids = records.map((r) => `${r["@graph"]}|${r["@id"]}`);
    localStorage.setItem("meta-ui-builder:ng-local-store:index", JSON.stringify(ids));
    records.forEach((r, i) =>
      localStorage.setItem(`meta-ui-builder:ng-local-store:record:${ids[i]}`, JSON.stringify(r)));
  });
  await page.route("**/sync/**", (route) => route.abort());
}

async function readDownload(download: Download): Promise<unknown> {
  const path = await download.path();
  if (!path) throw new Error("Playwright did not retain the downloaded file");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function exportBackup(page: Page): Promise<unknown> {
  const download = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export backup" }).click(),
  ]).then(([d]) => d);
  return readDownload(download);
}

async function importFile(page: Page, contents: unknown): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "datalet-backup-int-"));
  const path = join(directory, "backup.json");
  await writeFile(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByLabel("Choose backup file").setInputFiles(path);
}

/** For a file expected to be accepted: waits for the reload importGraphBackup
 * triggers on success, rather than racing it with a fixed timeout. */
async function importFileAndReload(page: Page, contents: unknown): Promise<void> {
  const reloaded = page.waitForEvent("framenavigated", {
    predicate: (frame) => frame === page.mainFrame(),
  });
  await importFile(page, contents);
  await reloaded;
  await page.waitForLoadState("domcontentloaded");
}

type Backup = {
  format: string; version: number; exportedAt: string; sourceHost: string;
  hash: string; graph: string; records: Array<{ key: string; record: Record<string, unknown> }>;
};

test("an exported backup carries a verifiable hash, a UTC timestamp and its source host", async ({ page }) => {
  await seed(page);
  await page.goto("/settings/datalets");
  const backup = await exportBackup(page) as Backup;

  expect(backup.format).toBe("localgraph-backup");
  expect(backup.version).toBe(1);
  // toISOString() always UTC, always Z-suffixed - not a separately-tracked
  // "is this UTC" concern, just what that call already guarantees.
  expect(backup.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(backup.sourceHost).toBe(new URL(page.url()).host);
  expect(backup.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(backup.records.length).toBeGreaterThan(0);
});

test("a genuine, untouched export re-imports cleanly", async ({ page }) => {
  await seed(page);
  await page.goto("/settings/datalets");
  const backup = await exportBackup(page);

  await importFileAndReload(page, backup);
  const ids = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("meta-ui-builder:ng-local-store:index") ?? "[]") as string[]);
  expect(ids.some((id) => id.endsWith("|keep-me"))).toBe(true);
});

test("a hand-edited backup is rejected as tampered, and existing records are untouched", async ({ page }) => {
  await seed(page);
  await page.goto("/settings/datalets");
  const backup = await exportBackup(page) as Backup;

  // Edited after export, hash left as it was - exactly what hand-editing a
  // downloaded file looks like, not a fixture short-cut.
  const tampered = {
    ...backup,
    records: backup.records.map((entry) =>
      entry.key.endsWith("|keep-me") ? { ...entry, record: { ...entry.record, Title: "Tampered" } } : entry),
  };
  await importFile(page, tampered);

  await expect(page.locator("#backup").getByRole("alert")).toContainText(/integrity hash/i);
  // Rejected outright: the original record survives, unedited.
  const stored: { Title?: string } | null = await page.evaluate((graph) =>
    JSON.parse(localStorage.getItem(`meta-ui-builder:ng-local-store:record:${graph}|keep-me`) ?? "null"), GRAPH);
  expect(stored?.Title).toBe("Original");
});

test("a backup missing its hash is refused, not silently trusted", async ({ page }) => {
  await seed(page);
  await page.goto("/settings/datalets");
  const backup = await exportBackup(page) as Backup;
  const { hash: _hash, ...withoutHash } = backup;

  await importFile(page, withoutHash);
  await expect(page.locator("#backup").getByRole("alert")).toContainText(/missing its integrity hash/i);
});

test("a backup claiming an old, hash-less format is refused rather than trusted unverified", async ({ page }) => {
  // There is no format that predates the hash and is still supported - this
  // proves the app actually enforces that rather than merely not writing
  // that shape itself. If a hash-less version were ever accepted, a hand-
  // edited file could simply drop the fields it can't fake its way past.
  await seed(page);
  await page.goto("/settings/datalets");
  await importFile(page, {
    format: "localgraph-backup", version: 1, exportedAt: new Date().toISOString(),
    graph: GRAPH,
    records: [{ key: `${GRAPH}|from-v1`, record: { "@id": "from-v1", "@graph": GRAPH, Title: "From v1" } }],
  });

  await expect(page.locator("#backup").getByRole("alert")).toContainText(/missing its integrity hash/i);
  const ids = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("meta-ui-builder:ng-local-store:index") ?? "[]") as string[]);
  expect(ids.some((id) => id.endsWith("|from-v1"))).toBe(false);
});
