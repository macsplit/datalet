import { expect, test, type Page } from "@playwright/test";
import { RUNTIME_LIMITS } from "../src/utils/runtimeHealth";

/**
 * The bar in Settings was the only place a percentage appeared, and it is not
 * a page anyone visits while entering records. These pin that the warning
 * reaches someone where the filling actually happens.
 */
async function seedUsage(page: Page, fraction: number) {
  const filler = Math.round(RUNTIME_LIMITS.storedBytes * fraction) - 400;
  await page.addInitScript(({ filler }) => {
    if (localStorage.getItem("usage-seeded")) return;
    localStorage.clear();
    localStorage.setItem("usage-seeded", "1");
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "usage", private_store_id: "test-private-store" }));
    const graph = "did:ng:test-private-store";
    const id = `${graph}|did:ng:z:filler`;
    localStorage.setItem(`meta-ui-builder:ng-local-store:record:${id}`, JSON.stringify({
      "@graph": graph, "@id": "did:ng:z:filler", "@type": "did:ng:z:Filler",
      value: "x".repeat(Math.max(0, filler)) }));
    localStorage.setItem("meta-ui-builder:ng-local-store:index", JSON.stringify([id]));
  }, { filler });
}

test("a store with room says nothing", async ({ page }) => {
  await seedUsage(page, 0.5);
  await page.goto("/");
  await expect(page.locator("#storage-banner")).toHaveCount(0);
});

test("past three quarters it warns on the page you are working on", async ({ page }) => {
  await seedUsage(page, 0.78);
  await page.goto("/");
  await expect(page.locator("#storage-banner")).toContainText("78% full");
});

test("the three-quarters notice can be dismissed, and stays dismissed", async ({ page }) => {
  await seedUsage(page, 0.78);
  await page.goto("/");
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator("#storage-banner")).toHaveCount(0);
  // Same session, different page: a dismissal that did not survive navigation
  // would be no dismissal at all.
  await page.goto("/settings");
  await expect(page.locator("#storage-banner")).toHaveCount(0);
});

test("a nearly full store cannot be dismissed", async ({ page }) => {
  await seedUsage(page, 0.93);
  await page.goto("/");
  const banner = page.locator("#storage-banner");
  await expect(banner).toContainText("Saving stops when it fills");
  // There is no version of this message someone benefits from hiding while it
  // is still true.
  await expect(page.getByRole("button", { name: "Dismiss" })).toHaveCount(0);
});

test("an earlier dismissal does not suppress the urgent band", async ({ page }) => {
  await seedUsage(page, 0.93);
  await page.addInitScript(() =>
    sessionStorage.setItem("meta-ui-builder:storage-notice-dismissed", "1"));
  await page.goto("/");
  await expect(page.locator("#storage-banner")).toContainText("Saving stops when it fills");
});
