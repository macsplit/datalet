import { expect, test, type Page } from "@playwright/test";
import { RUNTIME_LIMITS } from "../src/utils/runtimeHealth";

const STORE_KEY = "meta-ui-builder:ng-local-store";
const INDEX_KEY = `${STORE_KEY}:index`;
const RECORD_PREFIX = `${STORE_KEY}:record:`;
const SESSION_KEY = "meta-ui-builder:local-session";
const GRAPH = "did:ng:test-private-store";

/** Seed a graph holding `filler` characters of record data, plus optional foreign keys. */
async function seedUsage(page: Page, filler: number, foreign: Record<string, number> = {}) {
  await page.addInitScript(({ filler, foreign, indexKey, prefix, sessionKey, graph }) => {
    if (localStorage.getItem("usage-seeded")) return;
    localStorage.clear();
    localStorage.setItem("usage-seeded", "1");
    localStorage.setItem(sessionKey, JSON.stringify({
      session_id: "usage-session", private_store_id: "test-private-store",
    }));
    const id = `${graph}|did:ng:z:filler`;
    localStorage.setItem(prefix + id, JSON.stringify({
      "@graph": graph, "@id": "did:ng:z:filler", "@type": "did:ng:z:Filler",
      value: "x".repeat(Math.max(0, filler)),
    }));
    localStorage.setItem(indexKey, JSON.stringify([id]));
    for (const [key, size] of Object.entries(foreign)) {
      localStorage.setItem(key, "y".repeat(size));
    }
  }, { filler, foreign, indexKey: INDEX_KEY, prefix: RECORD_PREFIX, sessionKey: SESSION_KEY, graph: GRAPH });
}

test("usage is reported before anything is near the limit", async ({ page }) => {
  await seedUsage(page, 200_000);
  await page.goto("/settings/datalets");
  await expect(page.getByText(/0\.2 MB of 4\.5 MB used/)).toBeVisible();
  // A bar, not only a sentence: the figure has to be seen rather than read.
  const bar = page.getByRole("progressbar", { name: "Browser storage used" });
  await expect(bar).toHaveAttribute("aria-valuenow", "4");
  await expect(bar).toHaveClass(/storage-bar-ok/);
});

test("the outbox counts against the same budget as records", async ({ page }) => {
  // The point of measuring the whole origin: a projection that counted only
  // records would authorise a write the browser then refuses. The outbox is
  // the plausible offender, because it grows while offline editing continues.
  await seedUsage(page, 200_000, { "meta-ui-builder:sync-outbox:v1": 1_000_000 });
  await page.goto("/settings/datalets");
  await expect(page.getByText(/1\.2 MB of 4\.5 MB used/)).toBeVisible();
});

test("a nearly full store warns before it stops saving", async ({ page }) => {
  await seedUsage(page, Math.round(RUNTIME_LIMITS.storedBytes * 0.93));
  await page.goto("/settings/datalets");
  await expect(page.getByText(/Storage is nearly full/)).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Browser storage used" }))
    .toHaveClass(/storage-bar-danger/);
});

test("a full store says saving has stopped and what to do", async ({ page }) => {
  // Over the cap on load: the engine rejects the stored data and pauses.
  await seedUsage(page, RUNTIME_LIMITS.storedBytes + 10_000);
  await page.goto("/settings/datalets");
  await expect(page.getByText(/Storage is full/)).toBeVisible();
  // Scoped to the panel: the app-wide banner says the same thing, which is the
  // point of it, so an unscoped match now finds two.
  await expect(page.locator("#storage").getByText(/Export a backup/)).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Browser storage used" }))
    .toHaveClass(/storage-bar-danger/);
});
