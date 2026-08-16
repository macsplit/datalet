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

test("vault creation works when crypto.randomUUID is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("meta-ui-builder:local-session")) localStorage.clear();
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
  });
  let submitted: { nodeId?: string; batchId?: string } | undefined;
  await page.route("**/sync/vaults", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ vaultId: "fallback-vault", vaultToken: "fallback-token" }),
  }));
  await page.route("**/sync/snapshot?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ seq: 0, records: {} }),
  }));
  await page.route("**/sync/stream-ticket?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ticket: "fallback-ticket" }),
  }));
  await page.route("**/sync/stream?*", (route) => route.abort());
  await page.route("**/sync/patches?*", async (route) => {
    submitted = route.request().postDataJSON() as typeof submitted;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ accepted: true, acceptedCount: 1, submittedCount: 1 }),
    });
  });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Create sync vault" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect.poll(() => submitted).toBeTruthy();

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  expect(submitted?.nodeId).toMatch(uuid);
  expect(submitted?.batchId).toMatch(uuid);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("joining primes remote settings before reloading into the vault", async ({ page }) => {
  const graph = "did:ng:existing-vault";
  const settingsId = "did:ng:z:SettingsSingleton";
  await page.route("**/sync/snapshot?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      seq: 7,
      records: {
        [`${graph}|${settingsId}`]: {
          "@id": settingsId,
          "@graph": graph,
          "@type": "did:ng:z:Settings",
          appTitle: "Existing vault title",
        },
      },
    }),
  }));
  await page.route("**/sync/stream-ticket?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ticket: "existing-ticket" }),
  }));
  await page.route("**/sync/stream?*", (route) => route.abort());

  await page.goto("/settings");
  await page.getByLabel("Vault ID").fill("existing-vault");
  await page.getByLabel("Pairing token").fill("existing-token");
  await page.getByRole("button", { name: "Join vault" }).click();

  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Shown in the nav bar and browser tab")).toHaveValue("Existing vault title");
});
