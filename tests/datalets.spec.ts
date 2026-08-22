import { expect, test, type Page } from "@playwright/test";

const STORE_KEY = "meta-ui-builder:ng-local-store";
const INDEX_KEY = `${STORE_KEY}:index`;
const RECORD_PREFIX = `${STORE_KEY}:record:`;
const SESSION_KEY = "meta-ui-builder:local-session";
const REGISTRY_KEY = "meta-ui-builder:datalets";
const OUTBOX_PREFIX = "meta-ui-builder:sync-outbox:";
const LOCAL_GRAPH = "did:ng:test-private-store";

type Seed = {
  entries: Array<{
    id: string;
    title?: string;
    archivedAt?: number;
    vault?: { vaultId: string; vaultToken: string; nodeId: string };
  }>;
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
/** Accept sync traffic so bootstrap writes drain and a switch is not refused. */
async function stubSync(page: Page, opts: { snapshotRecords: Record<string, unknown> }) {
  await page.route("**/sync/snapshot?*", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ seq: 1, records: opts.snapshotRecords }),
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

const registry = (page: Page) => page.evaluate(({ key }) =>
  JSON.parse(localStorage.getItem(key) ?? "{}") as { activeId: string; entries: { id: string }[] },
  { key: REGISTRY_KEY });

/** Bootstrap writes queue in the outbox, and a queued outbox refuses a switch. */
const drainOutbox = (page: Page, vaultId: string) =>
  expect.poll(() => page.evaluate(({ prefix, vaultId }) =>
    JSON.parse(localStorage.getItem(prefix + vaultId) ?? "[]").length,
    { prefix: OUTBOX_PREFIX, vaultId })).toBe(0);

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

test("the panel offers to add one even when there is only one", async ({ page }) => {
  await seedDatalets(page, { activeId: "a", entries: [{ id: "a", vault: vaultA }] });
  await page.goto("/settings/datalets");
  await expect(page.getByRole("button", { name: "Start an empty one" })).toBeVisible();
});

test("datalets live on their own page, reached from Settings", async ({ page }) => {
  await seedDatalets(page, { activeId: "a", entries: [{ id: "a", vault: vaultA }] });
  await page.goto("/settings");
  // Settings should describe them, not carry the five panels itself: the page
  // had grown to nine, which is what prompted the split.
  await expect(page.getByRole("button", { name: "Start an empty one" })).toHaveCount(0);
  await expect(page.getByRole("progressbar", { name: "Browser storage used" })).toHaveCount(0);

  await page.getByRole("link", { name: "Manage datalets" }).click();
  await expect(page.getByRole("heading", { name: "Datalets and devices" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start an empty one" })).toBeVisible();

  await page.getByRole("link", { name: "Back to Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
});

test("an unpaired datalet cannot gain a second one, and says why", async ({ page }) => {
  // Forced rather than chosen: only the open datalet is resident, so the one
  // being left has to be recoverable from somewhere.
  await seedDatalets(page, { activeId: "local", entries: [{ id: "local" }] });
  await page.goto("/settings/datalets");
  await expect(page.getByText(/not paired, so there is no copy anywhere else/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Start an empty one" })).toBeDisabled();
});

test("starting an empty datalet adds it and leaves the first one listed", async ({ page }) => {
  await stubSync(page, { snapshotRecords: {} });
  await page.route("**/sync/vaults", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({
      vaultId: vaultB.vaultId, vaultToken: vaultB.vaultToken,
    }),
  }));
  await seedDatalets(page, { activeId: "a", entries: [{ id: "a", vault: vaultA }] });
  await page.goto("/settings/datalets");
  await drainOutbox(page, vaultA.vaultId);
  await page.getByRole("button", { name: "Start an empty one" }).click();

  await expect.poll(() => registry(page)).toMatchObject({ activeId: vaultB.vaultId });
  const state = await registry(page);
  // Joining or starting must add, not replace: the datalet left behind is still
  // there to come back to.
  expect(state.entries.map((e: { id: string }) => e.id)).toEqual(["a", vaultB.vaultId]);
});

test("a code adds a second datalet rather than replacing the first", async ({ page }) => {
  await stubSync(page, { snapshotRecords: {} });
  await seedDatalets(page, { activeId: "a", entries: [{ id: "a", vault: vaultA }] });
  await page.goto("/settings/datalets");
  await drainOutbox(page, vaultA.vaultId);

  const code = await page.evaluate(async ({ vaultId, token }) => {
    const mod = await import("/src/utils/pairingCode.ts");
    return mod.encodePairingCode(vaultId, token);
  }, { vaultId: vaultB.vaultId, token: vaultB.vaultToken });

  await page.getByLabel("Or open one from a code").fill(code);
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await expect.poll(() => registry(page)).toMatchObject({ activeId: vaultB.vaultId });
  expect((await registry(page)).entries).toHaveLength(2);
});

test("a datalet too large for this browser is refused before anything is created", async ({ page }) => {
  // The check has to fire before a vault exists, or it has not helped.
  const huge: Record<string, unknown> = {};
  for (let i = 0; i < 60; i += 1) {
    huge[`did:ng:${vaultB.vaultId}|did:ng:z:big${i}`] = {
      "@graph": `did:ng:${vaultB.vaultId}`, "@id": `did:ng:z:big${i}`,
      "@type": "did:ng:z:Big", value: "x".repeat(100_000),
    };
  }
  await stubSync(page, { snapshotRecords: huge });
  await seedDatalets(page, {
    activeId: "a", entries: [{ id: "a", vault: vaultA }, { id: "b", vault: vaultB }],
  });
  await page.goto("/settings/datalets");
  await drainOutbox(page, vaultA.vaultId);
  await page.getByRole("button", { name: "Open" }).click();

  await expect(page.getByRole("alert")).toContainText("Nothing has been created");
  expect(await registry(page)).toMatchObject({ activeId: "a" });
});

test("two datalets are listed, with the open one marked", async ({ page }) => {
  await seedDatalets(page, {
    activeId: "a", entries: [{ id: "a", vault: vaultA }, { id: "b", vault: vaultB }],
  });
  await page.goto("/settings/datalets");
  await expect(page.getByText("Switch datalet")).toBeVisible();
  await expect(page.getByText("Open", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Open" })).toHaveCount(1);
});

test("an unpaired datalet refuses to be left, because nothing else holds it", async ({ page }) => {
  await seedDatalets(page, {
    activeId: "local", entries: [{ id: "local" }, { id: "b", vault: vaultB }],
  });
  await page.goto("/settings/datalets");
  await expect(page.getByText(/not paired, so there is no copy anywhere else/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Open" })).toBeDisabled();
});

test("queued edits block a switch rather than being discarded", async ({ page }) => {
  await seedDatalets(page, {
    activeId: "a",
    entries: [{ id: "a", vault: vaultA }, { id: "b", vault: vaultB }],
    outbox: { [vaultA.vaultId]: 3 },
  });
  await page.goto("/settings/datalets");
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
  await page.goto("/settings/datalets");
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
  await page.goto("/settings/datalets");
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

test("a datalet that is not open is named, not reduced to a vault id", async ({ page }) => {
  // The title is recorded while a datalet is active; b's was recorded when it
  // was last open, which is the only way it can be named while evicted.
  await seedDatalets(page, {
    activeId: "a",
    entries: [
      { id: "a", vault: vaultA },
      { id: "b", title: "Reading list", vault: vaultB },
    ],
  });
  await page.goto("/settings/datalets");

  await expect(page.getByText("Reading list")).toBeVisible();
  // Both rows carry their vault id, which is what separates two same-named ones.
  await expect(page.getByText(`vault ${vaultB.vaultId.slice(0, 8)}`)).toBeVisible();
  await expect(page.getByText(`vault ${vaultA.vaultId.slice(0, 8)}`)).toBeVisible();
});

test("a datalet with no recorded title says so rather than showing a hash as a name", async ({ page }) => {
  await seedDatalets(page, {
    activeId: "a",
    entries: [{ id: "a", vault: vaultA }, { id: "b", vault: vaultB }],
  });
  await page.goto("/settings/datalets");
  await expect(page.getByText("Untitled datalet")).toBeVisible();
});

test("renaming the app records the name against the datalet", async ({ page }) => {
  await seedDatalets(page, { activeId: "a", entries: [{ id: "a", vault: vaultA }] });
  await page.goto("/settings");
  await page.getByLabel("Shown in the nav bar and browser tab").fill("Field notes");
  // Recorded from the root layout, so a rename then a switch - without ever
  // opening the datalets list - still leaves it nameable.
  await expect.poll(() => page.evaluate(() => {
    const registry = JSON.parse(localStorage.getItem("meta-ui-builder:datalets") ?? "{}");
    return registry.entries?.[0]?.title;
  })).toBe("Field notes");
});

test("a datalet can be put away and brought back without touching its vault", async ({ page }) => {
  await seedDatalets(page, {
    activeId: "a",
    entries: [{ id: "a", vault: vaultA }, { id: "b", title: "Old experiment", vault: vaultB }],
  });
  await page.goto("/settings/datalets");

  await page.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText("Archived (1)")).toBeVisible();

  // The credentials survive: archiving is not forgetting, and the datalet must
  // still be openable afterwards.
  expect(await page.evaluate(() => {
    const registry = JSON.parse(localStorage.getItem("meta-ui-builder:datalets") ?? "{}");
    const entry = registry.entries.find((e: { id: string }) => e.id === "b");
    return { hasVault: entry.vault?.vaultToken !== undefined, archived: entry.archivedAt !== undefined };
  })).toEqual({ hasVault: true, archived: true });

  await page.getByText("Archived (1)").click();
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Archived (")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Archive" })).toBeVisible();
});

test("the open datalet offers no way to archive itself", async ({ page }) => {
  await seedDatalets(page, {
    activeId: "a",
    entries: [{ id: "a", vault: vaultA }, { id: "b", vault: vaultB }],
  });
  await page.goto("/settings/datalets");
  // One Archive button, for the one that is not open. Archiving the open one
  // would be an eviction and a switch at once.
  await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(1);
});

test("archived datalets are out of the main list until expanded", async ({ page }) => {
  await seedDatalets(page, {
    activeId: "a",
    entries: [
      { id: "a", vault: vaultA },
      { id: "b", title: "Old sketches", vault: vaultB, archivedAt: 1_770_000_000_000 },
    ],
  });
  await page.goto("/settings/datalets");
  await expect(page.getByText("Old sketches")).not.toBeVisible();
  await page.getByText("Archived (1)").click();
  await expect(page.getByText("Old sketches")).toBeVisible();
});
