import { expect, test, type Page } from "@playwright/test";

const REGISTRY_KEY = "meta-ui-builder:datalets";
const vaultA = {
  vaultId: "aaaaaaaa-0000-0000-0000-000000000000",
  vaultToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  nodeId: "na",
};
const vaultB = {
  vaultId: "bbbbbbbb-0000-0000-0000-000000000000",
  vaultToken: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  nodeId: "nb",
};

async function seedPaired(page: Page) {
  await page.addInitScript(({ vault }) => {
    if (localStorage.getItem("clone-seeded")) return;
    localStorage.clear();
    localStorage.setItem("clone-seeded", "1");
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "clone-session", private_store_id: "test-private-store",
    }));
    localStorage.setItem("meta-ui-builder:datalets", JSON.stringify({
      activeId: "a", entries: [{ id: "a", vault }],
    }));
  }, { vault: vaultA });
  await page.route("**/sync/snapshot?*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ seq: 1, records: {} }),
  }));
  await page.route("**/sync/patches?*", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ accepted: true, acceptedCount: 1, submittedCount: 1 }),
  }));
  await page.route("**/sync/stream-ticket?*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ ticket: "t" }),
  }));
  await page.route("**/sync/stream?*", (route) => route.abort());
}

test("publishing states what a copy code hands over, and can be declined", async ({ page }) => {
  // The wording is the feature here. A confirmation that quietly drops the
  // encryption sentence is the regression that would actually matter.
  let seen = "";
  await seedPaired(page);
  await page.route("**/sync/clone-codes*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ codes: [] }),
  }));
  page.on("dialog", async (dialog) => { seen = dialog.message(); await dialog.dismiss(); });

  await page.goto("/settings");
  await page.getByRole("button", { name: "Create a copy code" }).click();
  await expect.poll(() => seen).toContain("every record");
  expect(seen).toContain("end-to-end encrypted");
  expect(seen).toContain("copies already taken");
  await expect(page.getByText("No copy codes exist for this datalet.")).toBeVisible();
});

test("a published code is listed and can be revoked", async ({ page }) => {
  await seedPaired(page);
  let live: { code: string; createdAt: number }[] = [];
  await page.route("**/sync/clone-codes*", async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      const issued = { code: "COPY-K3RM-9T7A-X", createdAt: Date.now() };
      live = [issued];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(issued) });
    }
    if (method === "DELETE") {
      live = [];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ revoked: true }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ codes: live }) });
  });
  page.on("dialog", (dialog) => void dialog.accept());

  await page.goto("/settings");
  await page.getByRole("button", { name: "Create a copy code" }).click();
  await expect(page.getByLabel("Copy code COPY-K3RM-9T7A-X")).toHaveValue("COPY-K3RM-9T7A-X");

  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("No copy codes exist for this datalet.")).toBeVisible();
});

test("a COPY code makes a new datalet rather than opening the original", async ({ page }) => {
  await seedPaired(page);
  await page.route("**/sync/clone-codes*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ codes: [] }),
  }));
  let cloneRequested = false;
  await page.route("**/sync/clone", (route) => {
    cloneRequested = true;
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ vaultId: vaultB.vaultId, vaultToken: vaultB.vaultToken }),
    });
  });

  await page.goto("/settings");
  await expect.poll(() => page.evaluate(() =>
    JSON.parse(localStorage.getItem("meta-ui-builder:sync-outbox:" + "aaaaaaaa-0000-0000-0000-000000000000") ?? "[]").length,
  )).toBe(0);

  await page.getByLabel("Or open one from a code").fill("COPY-K3RM-9T7A-X");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await expect.poll(() => page.evaluate(({ key }) =>
    JSON.parse(localStorage.getItem(key) ?? "{}").activeId, { key: REGISTRY_KEY }))
    .toBe(vaultB.vaultId);
  expect(cloneRequested).toBe(true);

  // The original is still listed: a copy adds, it does not take over.
  const entries = await page.evaluate(({ key }) =>
    JSON.parse(localStorage.getItem(key) ?? "{}").entries as { id: string }[], { key: REGISTRY_KEY });
  expect(entries.map((entry) => entry.id)).toEqual(["a", vaultB.vaultId]);
});
