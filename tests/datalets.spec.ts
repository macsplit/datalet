import { expect, test, type Page } from "@playwright/test";

const STORE_KEY = "meta-ui-builder:ng-local-store";
const INDEX_KEY = `${STORE_KEY}:index`;
const RECORD_PREFIX = `${STORE_KEY}:record:`;
const SESSION_KEY = "meta-ui-builder:local-session";
const REGISTRY_KEY = "meta-ui-builder:datalets";
const OUTBOX_PREFIX = "meta-ui-builder:sync-outbox:";
const LOCAL_GRAPH = "did:ng:test-private-store";

type Seed = {
  entries: Array<{ id: string; vault?: { vaultId: string; vaultToken: string; nodeId: string } }>;
  activeId: string;
  outbox?: Record<string, number>;
};

/** Seed a registry plus one record in the active datalet's graph. */
async function seedDatalets(page: Page, seed: Seed) {
  await page.addInitScript((input) => {
    if (localStorage.getItem("datalet-seeded")) return;
    localStorage.clear();
    localStorage.setItem("datalet-seeded", "1");
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "datalet-session", private_store_id: "test-private-store",
    }));
    localStorage.setItem("meta-ui-builder:datalets", JSON.stringify({
      activeId: input.activeId, entries: input.entries,
    }));
    const active = input.entries.find((e) => e.id === input.activeId);
    const graph = active?.vault ? `did:ng:${active.vault.vaultId}` : "did:ng:test-private-store";
    const key = `${graph}|did:ng:z:HomeTab`;
    localStorage.setItem(`meta-ui-builder:ng-local-store:record:${key}`, JSON.stringify({
      "@graph": graph, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Home", order: 0,
    }));
    localStorage.setItem("meta-ui-builder:ng-local-store:index", JSON.stringify([key]));
    for (const [vaultId, count] of Object.entries(input.outbox ?? {})) {
      localStorage.setItem(`meta-ui-builder:sync-outbox:${vaultId}`, JSON.stringify(
        Array.from({ length: count }, (_, i) => ({
          batchId: `b${i}`, hlc: "0", shape: "s", patches: [],
        })),
      ));
    }
  }, seed);
}

// Tokens are 24 random bytes as base64url, so 32 characters. A short stand-in
// makes the pairing-code encoder throw, which is a real behaviour, not a
// fixture detail worth working around.
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

test("one datalet shows no switcher", async ({ page }) => {
  // The panel has to earn its place: with nothing to choose between, it is noise.
  await seedDatalets(page, { activeId: "a", entries: [{ id: "a", vault: vaultA }] });
  await page.goto("/settings");
  await expect(page.getByText("Switch datalet")).toHaveCount(0);
});

test("two datalets are listed, with the open one marked", async ({ page }) => {
  await seedDatalets(page, {
    activeId: "a", entries: [{ id: "a", vault: vaultA }, { id: "b", vault: vaultB }],
  });
  await page.goto("/settings");
  await expect(page.getByText("Switch datalet")).toBeVisible();
  await expect(page.getByText("Open", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Open" })).toHaveCount(1);
});

test("an unpaired datalet refuses to be left, because nothing else holds it", async ({ page }) => {
  await seedDatalets(page, {
    activeId: "local", entries: [{ id: "local" }, { id: "b", vault: vaultB }],
  });
  await page.goto("/settings");
  await expect(page.getByText(/not paired, so there is no copy anywhere else/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Open" })).toBeDisabled();
});

test("queued edits block a switch rather than being discarded", async ({ page }) => {
  await seedDatalets(page, {
    activeId: "a",
    entries: [{ id: "a", vault: vaultA }, { id: "b", vault: vaultB }],
    outbox: { [vaultA.vaultId]: 3 },
  });
  await page.goto("/settings");
  await expect(page.getByText(/3 changes have not reached the sync server yet/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Open" })).toBeDisabled();
});

test("a failed restore leaves the current datalet intact", async ({ page }) => {
  // Restore-before-evict is the rule that keeps a switch from losing both
  // sides. Asserting on the records, not on the message.
  await page.route("**/sync/snapshot?*", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ reason: "down" }),
  }));
  await seedDatalets(page, {
    activeId: "a", entries: [{ id: "a", vault: vaultA }, { id: "b", vault: vaultB }],
  });
  await page.goto("/settings");
  await page.getByRole("button", { name: "Open" }).click();

  await expect(page.getByRole("alert")).toBeVisible();
  const state = await page.evaluate(({ registryKey, indexKey }) => ({
    activeId: JSON.parse(localStorage.getItem(registryKey) ?? "{}").activeId,
    index: localStorage.getItem(indexKey),
  }), { registryKey: REGISTRY_KEY, indexKey: INDEX_KEY });
  expect(state.activeId).toBe("a");
  expect(state.index).toContain(vaultA.vaultId);
});

test("a switch restores the target and evicts the one left behind", async ({ page }) => {
  await page.route("**/sync/snapshot?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      seq: 1,
      records: {
        [`did:ng:${vaultB.vaultId}|did:ng:z:HomeTab`]: {
          "@graph": `did:ng:${vaultB.vaultId}`, "@id": "did:ng:z:HomeTab",
          "@type": "did:ng:z:Tab", title: "Home", order: 0,
        },
      },
    }),
  }));
  await page.route("**/sync/stream-ticket?*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ ticket: "t" }),
  }));
  await page.route("**/sync/stream?*", (route) => route.abort());
  // Bootstrap writes queue in the outbox, and a queued outbox correctly refuses
  // a switch. Accepting them is what makes this the happy path rather than an
  // accidental re-test of the pending-changes rule.
  await page.route("**/sync/patches?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ accepted: true, acceptedCount: 1, submittedCount: 1 }),
  }));

  await seedDatalets(page, {
    activeId: "a", entries: [{ id: "a", vault: vaultA }, { id: "b", vault: vaultB }],
  });
  await page.goto("/settings");
  // Wait for bootstrap writes to drain before switching.
  await expect.poll(() => page.evaluate(({ prefix, vaultId }) =>
    JSON.parse(localStorage.getItem(prefix + vaultId) ?? "[]").length,
    { prefix: OUTBOX_PREFIX, vaultId: vaultA.vaultId })).toBe(0);
  await page.getByRole("button", { name: "Open" }).click();

  await expect.poll(async () => page.evaluate(({ registryKey }) =>
    JSON.parse(localStorage.getItem(registryKey) ?? "{}").activeId,
    { registryKey: REGISTRY_KEY })).toBe("b");

  const index = await page.evaluate(({ indexKey }) => localStorage.getItem(indexKey) ?? "",
    { indexKey: INDEX_KEY });
  expect(index).toContain(vaultB.vaultId);
  expect(index).not.toContain(vaultA.vaultId);
});
