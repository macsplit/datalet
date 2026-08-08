import { expect, test, type Page } from "@playwright/test";

const CONFIG_KEY = "meta-ui-builder:sync-vault";
const OUTBOX_KEY = "meta-ui-builder:sync-outbox:test-vault";
const SESSION_KEY = "meta-ui-builder:local-session";

async function seedPendingSync(page: Page, patchCount: number) {
  await page.addInitScript(({ configKey, outboxKey, sessionKey, patchCount }) => {
    localStorage.clear();
    localStorage.setItem(sessionKey, JSON.stringify({
      session_id: "sync-warning-session",
      private_store_id: "test-vault",
      protected_store_id: "test-protected-store",
      public_store_id: "test-public-store",
    }));
    localStorage.setItem(configKey, JSON.stringify({
      vaultId: "test-vault",
      vaultToken: "test-token",
      nodeId: "test-node",
    }));
    localStorage.setItem(outboxKey, JSON.stringify([{
      batchId: "pending-batch",
      hlc: "000000000001000-000000-test-node",
      shape: "test-shape",
      patches: Array.from({ length: patchCount }, (_, index) => ({
        op: "add",
        path: `/subject/field-${index}`,
        value: `value-${index}`,
      })),
    }]));
  }, { configKey: CONFIG_KEY, outboxKey: OUTBOX_KEY, sessionKey: SESSION_KEY, patchCount });
  await page.route("**/sync/stream-ticket?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ticket: "test-ticket" }),
  }));
  await page.route("**/sync/stream?*", (route) => route.abort());
}

test("an all-rejected sync batch raises the server reason", async ({ page }) => {
  await seedPendingSync(page, 1);
  await page.route("**/sync/patches?*", (route) => route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({
      accepted: false,
      acceptedCount: 0,
      submittedCount: 1,
      reason: "superseded by a newer edit to the same field",
    }),
  }));
  await page.goto("/");

  const warning = page.getByRole("alert");
  await expect(warning).toContainText("Remote sync discarded changes");
  await expect(warning).toContainText("1 of 1 local change was not applied");
  await expect(warning).toContainText("superseded by a newer edit to the same field");
});

test("a partially accepted sync batch reports its dropped count", async ({ page }) => {
  await seedPendingSync(page, 3);
  await page.route("**/sync/patches?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      accepted: true,
      acceptedCount: 2,
      submittedCount: 3,
      reason: "superseded by a newer edit to the same field",
    }),
  }));
  await page.goto("/");

  const warning = page.getByRole("alert");
  await expect(warning).toContainText("1 of 3 local changes were not applied");
  await expect(warning).toContainText("superseded by a newer edit to the same field");
});
