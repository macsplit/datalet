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

  await page.goto("/settings/datalets");
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

  await page.goto("/settings/datalets");
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

  await page.goto("/settings/datalets");
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
    JSON.parse(localStorage.getItem(key) ?? "{}").entries as
      { id: string; copiedAt?: number }[], { key: REGISTRY_KEY });
  expect(entries.map((entry) => entry.id)).toEqual(["a", vaultB.vaultId]);

  // A copy arrives carrying the source's title, so without this the list would
  // show two identically named entries with nothing to tell them apart.
  const copy = entries.find((entry) => entry.id === vaultB.vaultId);
  expect(typeof copy?.copiedAt).toBe("number");
  const joined = entries.find((entry) => entry.id === "a");
  expect(joined?.copiedAt).toBeUndefined();
});

test("a datalet opened from an LG1 code is not marked as a copy", async ({ page }) => {
  // Joining and copying look alike and are opposites; only one makes a copy.
  await seedPaired(page);
  await page.route("**/sync/clone-codes*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ codes: [] }),
  }));
  await page.goto("/settings/datalets");
  await expect.poll(() => page.evaluate(() =>
    JSON.parse(localStorage.getItem(
      "meta-ui-builder:sync-outbox:aaaaaaaa-0000-0000-0000-000000000000") ?? "[]").length)).toBe(0);

  const code = await page.evaluate(async ({ vaultId, token }) => {
    const mod = await import("/src/utils/pairingCode.ts");
    return mod.encodePairingCode(vaultId, token);
  }, { vaultId: vaultB.vaultId, token: vaultB.vaultToken });

  await page.getByLabel("Or open one from a code").fill(code);
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await expect.poll(() => page.evaluate(({ key }) =>
    JSON.parse(localStorage.getItem(key) ?? "{}").activeId, { key: REGISTRY_KEY }))
    .toBe(vaultB.vaultId);
  const entries = await page.evaluate(({ key }) =>
    JSON.parse(localStorage.getItem(key) ?? "{}").entries as
      { id: string; copiedAt?: number }[], { key: REGISTRY_KEY });
  expect(entries.find((entry) => entry.id === vaultB.vaultId)?.copiedAt).toBeUndefined();
});

test("Copy as Link mints a single-use token and copies the resulting URL", async ({ page }) => {
  await seedPaired(page);
  await page.route("**/sync/clone-codes*", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ codes: [{ code: "COPY-K3RM-9T7A-X", createdAt: Date.now() }] }),
  }));
  let mintedFor: { codeType?: string; code?: string } = {};
  await page.route("**/sync/invite-token", async (route) => {
    mintedFor = JSON.parse(route.request().postData() ?? "{}") as { codeType?: string; code?: string };
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ inviteToken: "11111111-1111-4111-8111-111111111111", expiresAt: Date.now() + 1000 }),
    });
  });

  await page.goto("/settings/datalets");
  await expect(page.getByLabel("Copy code COPY-K3RM-9T7A-X")).toBeVisible();

  await page.getByRole("button", { name: "Copy a link for the code COPY-K3RM-9T7A-X" }).click();
  await expect(page.getByRole("button", { name: "Copy a link for the code COPY-K3RM-9T7A-X" }))
    .toHaveText("Copied");

  // The code itself, never the raw link, is what gets sent to mint the token.
  expect(mintedFor).toEqual({ codeType: "COPY", code: "COPY-K3RM-9T7A-X" });

  // "Copy" (the raw code) is unaffected by having pressed the link button - the
  // two states are tracked independently, or one action would misreport the other.
  await expect(page.getByRole("button", { name: "Copy the code COPY-K3RM-9T7A-X" }))
    .toHaveText("Copy");
});

test("pasting a full invite link into the code field joins, same as pasting the code", async ({ page }) => {
  await seedPaired(page);
  await page.route("**/sync/clone-codes*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ codes: [] }),
  }));
  await page.route("**/sync/invite-redeem", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { codeType?: string; inviteToken?: string };
    if (body.codeType !== "COPY" || body.inviteToken !== "22222222-2222-4222-8222-222222222222") {
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ reason: "not found" }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: "COPY-K3RM-9T7A-X" }) });
  });
  let cloneRequested = false;
  await page.route("**/sync/clone", (route) => {
    cloneRequested = true;
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ vaultId: vaultB.vaultId, vaultToken: vaultB.vaultToken }),
    });
  });

  await page.goto("/settings/datalets");
  // What "Copy as Link" actually produces, pasted where someone reaches for it
  // by habit rather than at /join specifically.
  await page.getByLabel("Or open one from a code").fill(
    "https://datalet.app/join?token=22222222-2222-4222-8222-222222222222");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await expect.poll(() => page.evaluate(({ key }) =>
    JSON.parse(localStorage.getItem(key) ?? "{}").activeId, { key: REGISTRY_KEY }))
    .toBe(vaultB.vaultId);
  expect(cloneRequested).toBe(true);
});
