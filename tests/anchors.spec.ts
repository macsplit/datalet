import { expect, test } from "@playwright/test";

/**
 * A client-side router resolves a hash before React has rendered the target,
 * so fragment anchors need explicit help. These pin that the anchors exist and
 * that arriving at one actually moves the page.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "anchors", private_store_id: "test-private-store",
    }));
  });
});

test("every Settings panel has a stable anchor", async ({ page }) => {
  await page.goto("/settings");
  for (const id of ["datalets", "schemas", "tabs", "theme", "app-title"]) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
});

test("the datalets panels have stable anchors", async ({ page }) => {
  await page.goto("/settings/datalets");
  for (const id of ["switch-datalet", "storage", "backup", "sync"]) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
});

test("arriving at a fragment scrolls to it", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 500 });
  await page.goto("/settings/datalets#sync");
  // Settled, since the scroll is smooth and retried across frames.
  await expect.poll(async () => Math.round(await page.evaluate(() => window.scrollY)), {
    timeout: 5_000,
  }).toBeGreaterThan(100);
  await expect(page.locator("#sync")).toBeInViewport();
});

test("a page with no fragment stays at the top", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 500 });
  await page.goto("/settings/datalets");
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
