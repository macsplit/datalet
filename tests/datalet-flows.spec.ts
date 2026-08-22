import { expect, test, type Page } from "@playwright/test";

/**
 * Sequences of datalet operations, rather than one operation at a time.
 *
 * Every datalet bug found so far has lived in a *composition*: create a vault
 * then switch to it; pair then leave; leave then rejoin. Each step passed its
 * own test. This drives the operations against a fake sync server that behaves
 * like the real one - it stores what it is sent and returns it as a snapshot -
 * so a step that writes something the next step cannot read is caught here
 * rather than in production.
 */

const STORE = "meta-ui-builder:ng-local-store";
const LOCAL_GRAPH = "did:ng:test-private-store";

type Vault = { vaultId: string; vaultToken: string };

/**
 * A sync server that actually stores things. The point is fidelity on the one
 * axis that matters: a snapshot returns what patches put in, keyed the same
 * way, so client and server having different ideas of a key shows up.
 */
async function fakeSyncServer(page: Page) {
  const vaults = new Map<string, Record<string, Record<string, unknown>>>();
  let created = 0;

  await page.route("**/sync/vaults", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    created += 1;
    const vaultId = `${created}0000000-0000-4000-8000-00000000000${created}`;
    vaults.set(vaultId, {});
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ vaultId, vaultToken: `TOKEN${created}`.padEnd(32, "x") }),
    });
  });

  await page.route("**/sync/patches?*", async (route) => {
    const vaultId = new URL(route.request().url()).searchParams.get("vault") ?? "";
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      patches?: Array<{ op: string; path: string; value?: unknown }>;
    };
    const store = vaults.get(vaultId) ?? {};
    for (const patch of body.patches ?? []) {
      const parts = patch.path.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
      const [subject, property] = parts;
      if (patch.op === "remove" && property === undefined) { delete store[subject]; continue; }
      store[subject] ??= {};
      if (property !== undefined) store[subject][property] = patch.value;
    }
    vaults.set(vaultId, store);
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ accepted: true, seq: 1, acceptedCount: 1, submittedCount: 1 }),
    });
  });

  await page.route("**/sync/snapshot?*", async (route) => {
    const vaultId = new URL(route.request().url()).searchParams.get("vault") ?? "";
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ seq: 1, records: vaults.get(vaultId) ?? {} }),
    });
  });

  await page.route("**/sync/stream-ticket?*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ ticket: "t" }) }));
  await page.route("**/sync/stream?*", (route) => route.abort());
  await page.route("**/sync/clone-codes*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ codes: [] }) }));

  return { vaults };
}

async function seedLocalWork(page: Page, title: string) {
  await page.addInitScript((input) => {
    if (localStorage.getItem("flows-seeded")) return;
    localStorage.clear();
    localStorage.setItem("flows-seeded", "1");
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "flows", private_store_id: "test-private-store" }));
    const records = [
      { "@graph": input.graph, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Home", order: 0 },
      { "@graph": input.graph, "@id": "did:ng:z:SettingsSingleton", "@type": "did:ng:z:Settings", appTitle: input.title },
      { "@graph": input.graph, "@id": "rec-1", "@type": "did:ng:z:user:s", Title: "Piranesi" },
    ];
    const ids = records.map((r) => `${r["@graph"]}|${r["@id"]}`);
    localStorage.setItem(`${input.store}:index`, JSON.stringify(ids));
    records.forEach((r, i) => localStorage.setItem(`${input.store}:record:${ids[i]}`, JSON.stringify(r)));
  }, { store: STORE, graph: LOCAL_GRAPH, title });
}

const brand = (page: Page) => page.locator(".app-nav-brand");

async function noSafetyCircuit(page: Page) {
  // The banner that appeared in production. Any flow that trips it has left
  // the two ends disagreeing about what a record looks like.
  await expect(page.locator("#runtime-issue-banner")).toHaveCount(0);
  await expect(page.getByText(/failed local validation/)).toHaveCount(0);
}

test("create a vault, then switch away and back", async ({ page }) => {
  await seedLocalWork(page, "My work");
  await fakeSyncServer(page);
  await page.goto("/settings/datalets");

  await page.getByRole("button", { name: "Create sync vault" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(brand(page)).toHaveText("My work");
  await noSafetyCircuit(page);

  // A second datalet, then back to the first: the round trip that failed.
  await page.getByRole("button", { name: "Start an empty one" }).click();
  await expect(page.getByRole("button", { name: "Open" }).first()).toBeVisible();

  await page.getByRole("button", { name: "Open" }).first().click();
  await expect(brand(page)).toHaveText("My work", { timeout: 15_000 });
  await noSafetyCircuit(page);
});

test("create a vault, leave it, then rejoin from the archived entry", async ({ page }) => {
  await seedLocalWork(page, "My work");
  await fakeSyncServer(page);
  await page.goto("/settings/datalets");

  await page.getByRole("button", { name: "Create sync vault" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Leave vault" }).click();
  // Records came home, and the vault was kept.
  await expect(brand(page)).toHaveText("My work");
  await expect(page.getByText(/Archived \(1\)/)).toBeVisible();
  await noSafetyCircuit(page);

  // And now the consequence of the one-resident rule, which is easy to walk
  // into: having left, this datalet is unpaired, so it cannot be left again -
  // there is nowhere for its records to come back from. The archived vault is
  // therefore not reachable until this one is synced again. Pinned because it
  // is behaviour someone will hit, not because it is obviously right.
  await page.getByText(/Archived \(1\)/).click();
  await expect(page.getByRole("button", { name: "Open" }).first()).toBeDisabled();
  await expect(page.getByText(/only in this browser, so there is no copy anywhere else/)).toBeVisible();
  await noSafetyCircuit(page);
});

test("three datalets, switching between each in turn", async ({ page }) => {
  await seedLocalWork(page, "First");
  await fakeSyncServer(page);
  await page.goto("/settings/datalets");

  await page.getByRole("button", { name: "Create sync vault" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();

  for (let i = 0; i < 2; i += 1) {
    await page.getByRole("button", { name: "Start an empty one" }).click();
    await expect(page.getByRole("button", { name: "Open" }).first()).toBeVisible({ timeout: 15_000 });
    await noSafetyCircuit(page);
  }

  // Whatever the list holds, opening each in turn must not trip validation.
  const rows = await page.getByRole("button", { name: "Open" }).count();
  expect(rows).toBeGreaterThanOrEqual(1);
  for (let i = 0; i < rows; i += 1) {
    const open = page.getByRole("button", { name: "Open" }).first();
    if (!(await open.isEnabled())) break;
    await open.click();
    await expect(page.getByRole("heading", { name: "Switch datalet" })).toBeVisible({ timeout: 15_000 });
    await noSafetyCircuit(page);
  }
});

test("adding a datalet before ever pairing does not strand the local records", async ({ page }) => {
  // Found by the fuzzer on its first step. The registry was only written when
  // a vault was configured, so a browser that had never paired had no entry:
  // canLeaveActiveDatalet found nothing to protect and allowed the add, and
  // the local datalet's records were left in a graph nothing pointed at.
  await seedLocalWork(page, "Never paired");
  await fakeSyncServer(page);
  await page.goto("/settings/datalets");

  const add = page.getByRole("button", { name: "Start an empty one" });
  await expect(add).toBeDisabled();
  await expect(page.getByText(/only in this browser, so there is no copy anywhere else/)).toBeVisible();

  const graphs = await page.evaluate(() => {
    const index = JSON.parse(
      localStorage.getItem("meta-ui-builder:ng-local-store:index") ?? "[]") as string[];
    return [...new Set(index.map((key) => key.split("|")[0]))];
  });
  expect(graphs).toEqual(["did:ng:test-private-store"]);
});
