import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Importing a backup is this app's deserialization boundary: a file from
 * anywhere, parsed and written straight into the store. It is the obvious
 * place for prototype pollution, quota exhaustion and cross-datalet writes, so
 * each is attempted here rather than assumed impossible.
 *
 * A rejected import must also be a *whole* rejection. A partial apply would
 * leave a datalet holding half of someone else's file.
 */

const GRAPH = "did:ng:test-private-store";

async function seed(page: Page) {
  await page.addInitScript(() => {
    if (localStorage.getItem("sec-seeded")) return;
    localStorage.clear();
    localStorage.setItem("sec-seeded", "1");
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "sec", private_store_id: "test-private-store" }));
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

async function importFile(page: Page, contents: unknown): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "datalet-sec-"));
  const path = join(directory, "backup.json");
  await writeFile(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByLabel("Choose backup file").setInputFiles(path);
}

/**
 * A backup with a real, correctly-computed hash - the import path checks
 * that first, so a malicious payload has to arrive inside an otherwise
 * genuine backup to reach the checks each test below actually exercises.
 * Matches `hashBackupPayload` in `localNgEngine.ts` exactly: SHA-256 over
 * `JSON.stringify` of these same fields, in this same order, minus `hash`.
 */
function backup(records: Array<{ key: string; record: unknown }>) {
  const unhashed = {
    format: "localgraph-backup", version: 1, exportedAt: new Date().toISOString(),
    sourceHost: "test-host", graph: GRAPH, records,
  };
  const hash = `sha256:${createHash("sha256").update(JSON.stringify(unhashed)).digest("hex")}`;
  return { ...unhashed, hash };
}

test("a backup cannot poison Object.prototype", async ({ page }) => {
  await seed(page);
  await page.goto("/settings/datalets");
  await importFile(page, backup([
    { key: `${GRAPH}|__proto__`, record: { "@id": "__proto__", "@graph": GRAPH, polluted: "yes" } },
    { key: `${GRAPH}|constructor`, record: { "@id": "constructor", "@graph": GRAPH, polluted: "yes" } },
  ]));
  await page.waitForTimeout(700);
  // The prototype must be untouched whether or not the import was accepted.
  expect(await page.evaluate(() => ({} as Record<string, unknown>).polluted)).toBeUndefined();
  expect(await page.evaluate(() => (Object.prototype as Record<string, unknown>).polluted)).toBeUndefined();
});

test("a backup cannot write into a datalet it does not belong to", async ({ page }) => {
  await seed(page);
  await page.goto("/settings/datalets");
  // A record claiming a different graph than the backup declares.
  await importFile(page, backup([
    { key: `${GRAPH}|intruder`, record: { "@id": "intruder", "@graph": "did:ng:someone-else", x: 1 } },
  ]));
  await expect(page.locator("#backup").getByRole("alert")).toBeVisible();
  const graphs = await page.evaluate(() => {
    const index = JSON.parse(
      localStorage.getItem("meta-ui-builder:ng-local-store:index") ?? "[]") as string[];
    return [...new Set(index.map((key) => key.split("|")[0]))];
  });
  expect(graphs).toEqual([GRAPH]);
});

test("a rejected backup leaves the existing records untouched", async ({ page }) => {
  await seed(page);
  await page.goto("/settings/datalets");
  await importFile(page, backup([
    { key: `${GRAPH}|fine`, record: { "@id": "fine", "@graph": GRAPH, Title: "Fine" } },
    { key: `${GRAPH}|broken`, record: "not an object" },
  ]));
  await expect(page.locator("#backup").getByRole("alert")).toBeVisible();
  // Whole-file rejection: neither the good record nor the bad one landed.
  const ids = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("meta-ui-builder:ng-local-store:index") ?? "[]") as string[]);
  expect(ids).toContain(`${GRAPH}|keep-me`);
  expect(ids.some((id) => id.endsWith("|fine"))).toBe(false);
});

test("a backup claiming an absurd number of records is refused, not attempted", async ({ page }) => {
  await seed(page);
  await page.goto("/settings/datalets");
  const many = Array.from({ length: 10_001 }, (_, i) => ({
    key: `${GRAPH}|r${i}`, record: { "@id": `r${i}`, "@graph": GRAPH, v: 1 },
  }));
  await importFile(page, backup(many));
  await expect(page.locator("#backup").getByRole("alert")).toContainText(/safety limit/i);
});

test("malformed JSON is reported rather than crashing the page", async ({ page }) => {
  await seed(page);
  await page.goto("/settings/datalets");
  await importFile(page, "{ this is not json");
  await expect(page.locator("#backup").getByRole("alert")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Datalets and devices" })).toBeVisible();
});

test("script in a record value is shown as text, never executed", async ({ page }) => {
  // alert() is captured in the page rather than through a dialog listener: the
  // import helper already handles one dialog, and a dialog can only be handled
  // once.
  await page.addInitScript(() => {
    (window as unknown as { __alerts: string[] }).__alerts = [];
    window.alert = (message?: unknown) => {
      (window as unknown as { __alerts: string[] }).__alerts.push(String(message));
    };
  });
  await seed(page);
  await page.goto("/settings/datalets");
  await importFile(page, backup([
    { key: `${GRAPH}|did:ng:z:HomeTab`, record: {
      "@id": "did:ng:z:HomeTab", "@graph": GRAPH, "@type": "did:ng:z:Tab",
      title: "<img src=x onerror=\"alert('xss')\">", order: 0,
    } },
  ]));
  await page.waitForTimeout(1_000);
  await page.goto("/");
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { __alerts: string[] }).__alerts)).toEqual([]);
  expect(await page.locator("img[onerror]").count()).toBe(0);
});
