import { expect, test, type Page } from "@playwright/test";

/**
 * Creating a vault used to empty the app.
 *
 * Pairing repoints the active datalet at the vault's graph. The new vault is
 * empty, so everything built beforehand stayed behind in the old graph -
 * unreachable, and still occupying the storage budget. Reported from a real
 * deployment as total data loss on first use, which is exactly how it looked.
 */

const STORE = "meta-ui-builder:ng-local-store";
const PRIVATE_STORE_ID = "test-private-store";
const GRAPH = `did:ng:${PRIVATE_STORE_ID}`;
const VAULT_ID = "aaaaaaaa-0000-0000-0000-000000000000";

async function seedLocalWork(page: Page) {
  await page.addInitScript((input) => {
    // Pairing reloads, and this script runs again on the way back: without the
    // guard it would clear the very state the reload exists to load.
    if (localStorage.getItem("pairing-seeded")) return;
    localStorage.clear();
    localStorage.setItem("pairing-seeded", "1");
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "pairing", private_store_id: "test-private-store",
    }));
    const records = [
      { "@graph": input.graph, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Reading", order: 0 },
      { "@graph": input.graph, "@id": "did:ng:z:SettingsSingleton", "@type": "did:ng:z:Settings", appTitle: "My work" },
      { "@graph": input.graph, "@id": "schema-books", "@type": "did:ng:z:SchemaDef", name: "Books" },
      { "@graph": input.graph, "@id": "book-1", "@type": "did:ng:z:user:schema-books", Title: "Piranesi" },
    ];
    const ids = records.map((r) => `${r["@graph"]}|${r["@id"]}`);
    localStorage.setItem(`${input.store}:index`, JSON.stringify(ids));
    records.forEach((r, i) => localStorage.setItem(`${input.store}:record:${ids[i]}`, JSON.stringify(r)));
  }, { store: STORE, graph: GRAPH });
}

async function stubVaultCreation(page: Page, patches: Array<Record<string, unknown>>) {
  await page.route("**/sync/vaults", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ vaultId: VAULT_ID, vaultToken: "T".repeat(32) }),
  }));
  await page.route("**/sync/snapshot?*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ seq: 0, records: {} }),
  }));
  await page.route("**/sync/stream-ticket?*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ ticket: "t" }),
  }));
  await page.route("**/sync/stream?*", (route) => route.abort());
  await page.route("**/sync/patches?*", async (route) => {
    patches.push(JSON.parse(route.request().postData() ?? "{}"));
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ accepted: true, seq: 1, acceptedCount: 1, submittedCount: 1 }),
    });
  });
}

test("creating a vault keeps the records that were already there", async ({ page }) => {
  const sent: Array<Record<string, unknown>> = [];
  await seedLocalWork(page);
  await stubVaultCreation(page, sent);

  await page.goto("/settings/datalets");
  await expect(page.getByText("Not connected")).toBeVisible();
  await page.getByRole("button", { name: "Create sync vault" }).click();

  // The app reloads into the vault's graph; the work must still be there.
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.locator(".app-nav-brand")).toHaveText("My work");

  const vaultGraph = `did:ng:${VAULT_ID}`;
  const moved = await page.evaluate(({ store, graph }) => {
    const index = JSON.parse(localStorage.getItem(`${store}:index`) ?? "[]") as string[];
    return {
      inVault: index.filter((k) => k.startsWith(`${graph}|`)).length,
      leftBehind: index.filter((k) => k.startsWith("did:ng:test-private-store|")).length,
    };
  }, { store: STORE, graph: vaultGraph });

  expect(moved.inVault).toBe(4);
  // The old graph is gone, not merely unreachable: it used to sit there
  // consuming the storage budget with no way to read it.
  expect(moved.leftBehind).toBe(0);
});

test("the carried records are queued for the server, not only written locally", async ({ page }) => {
  const sent: Array<Record<string, unknown>> = [];
  await seedLocalWork(page);
  await stubVaultCreation(page, sent);

  await page.goto("/settings/datalets");
  await page.getByRole("button", { name: "Create sync vault" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();

  // Without this the first resync from an empty server snapshot would delete
  // them again: the server has never heard of a record made before pairing.
  await expect.poll(() => sent.length, { timeout: 10_000 }).toBeGreaterThan(0);
  const paths = sent.flatMap((batch) =>
    ((batch.patches ?? []) as Array<{ path: string }>).map((p) => p.path));
  expect(paths).toContain("/book-1/Title");
  expect(paths).toContain("/did:ng:z:SettingsSingleton/appTitle");
});

test("joining an existing vault does not upload local records over it", async ({ page }) => {
  const sent: Array<Record<string, unknown>> = [];
  await seedLocalWork(page);
  await stubVaultCreation(page, sent);
  await page.route("**/sync/snapshot?*", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      seq: 3,
      records: {
        [`did:ng:${VAULT_ID}|did:ng:z:SettingsSingleton`]: {
          "@id": "did:ng:z:SettingsSingleton", "@graph": `did:ng:${VAULT_ID}`,
          "@type": "did:ng:z:Settings", appTitle: "Theirs",
        },
      },
    }),
  }));

  await page.goto("/settings/datalets");
  const { encodePairingCode } = await import("../src/utils/pairingCode");
  await page.getByLabel("Pairing code", { exact: true })
    .fill(encodePairingCode(VAULT_ID, "T".repeat(32)));
  await page.getByRole("button", { name: "Join vault" }).click();

  // You asked for their datalet, so you get theirs - not a merge nobody wanted.
  await expect(page.locator(".app-nav-brand")).toHaveText("Theirs");

  // Ordinary post-join activity does write patches, so the claim is narrower
  // than "nothing was sent": none of *these* records may be pushed over theirs.
  await page.waitForTimeout(1_000);
  const paths = sent.flatMap((batch) =>
    ((batch.patches ?? []) as Array<{ path: string }>).map((p) => p.path));
  expect(paths.filter((p) => p.startsWith("/book-1"))).toEqual([]);
  expect(paths.filter((p) => p.startsWith("/schema-books"))).toEqual([]);
});
