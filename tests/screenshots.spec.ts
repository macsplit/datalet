import { test, type Page } from "@playwright/test";

/**
 * The documentation screenshot library. `pnpm screenshots` regenerates every
 * image under `docs/images/`; nothing here asserts anything.
 *
 * The state is seeded rather than clicked into place, so the same bytes come
 * out on any machine and a diff means the interface changed. Anything
 * time-dependent is fixed for the same reason: `COPIED_AT` is a constant
 * because the datalet list renders it with `toLocaleDateString`, and the
 * config pins locale and timezone around it.
 */

const OUT = "docs/images";
const STORE = "meta-ui-builder:ng-local-store";
const PRIVATE_STORE_ID = "test-private-store";
const GRAPH = `did:ng:${PRIVATE_STORE_ID}`;
const SCHEMA = "did:ng:z:meta:schema:books";
const BLOCK = "block-books";
const COPIED_AT = Date.UTC(2026, 6, 14);

const vault = (c: string) => ({
  vaultId: `${c.repeat(8)}-4d1a-4c2b-9f3e-100000000000`,
  vaultToken: c.toUpperCase().repeat(32),
  nodeId: `node-${c}`,
});

/**
 * A small but real-looking reading list: a schema, a screen, and records.
 *
 * Parameterised by graph because a paired datalet reads its Settings - and so
 * its title - from the vault's graph, not the local one. Seeding only the
 * local graph left the datalet list calling the open datalet "Datalet".
 */
function readingList(graph: string = GRAPH) {
  const field = (id: string, name: string, order: number, dataType: string) => ({
    "@graph": graph, "@id": id, "@type": "did:ng:z:PropertyDef", schemaId: SCHEMA,
    name, order, dataType, cardinality: "did:ng:z:one", enumOptions: [],
  });
  const widget = (id: string, order: number, propertyName: string, fieldType: string) => ({
    "@graph": graph, "@id": id, "@type": "did:ng:z:Widget", parentBlockId: BLOCK,
    order, widgetType: "did:ng:z:field", propertyName, label: propertyName, fieldType,
  });
  const books = [
    { Title: "The Left Hand of Darkness", Author: "Ursula K. Le Guin", Rating: 5, Finished: "2026-02-11" },
    { Title: "Piranesi", Author: "Susanna Clarke", Rating: 5, Finished: "2026-03-02" },
    { Title: "The Dispossessed", Author: "Ursula K. Le Guin", Rating: 4, Finished: "2026-04-19" },
    { Title: "Station Eleven", Author: "Emily St. John Mandel", Rating: 4, Finished: "2026-05-30" },
    { Title: "The Overstory", Author: "Richard Powers", Rating: 3, Finished: "2026-06-21" },
  ];
  return [
    { "@graph": graph, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Reading", order: 0 },
    { "@graph": graph, "@id": "tab-notes", "@type": "did:ng:z:Tab", title: "Notes", order: 1 },
    { "@graph": graph, "@id": "did:ng:z:SettingsSingleton", "@type": "did:ng:z:Settings", appTitle: "Reading list" },
    { "@graph": graph, "@id": SCHEMA, "@type": "did:ng:z:SchemaDef", name: "Books", labelPropertyId: "property-title" },
    field("property-title", "Title", 0, "did:ng:z:text"),
    field("property-author", "Author", 1, "did:ng:z:text"),
    field("property-rating", "Rating", 2, "did:ng:z:number"),
    field("property-finished", "Finished", 3, "did:ng:z:date"),
    {
      "@graph": graph, "@id": BLOCK, "@type": "did:ng:z:Block", blockType: "did:ng:z:data",
      order: 0, schemaId: SCHEMA, parentTabId: "did:ng:z:HomeTab",
      title: "Books I have read", searchEnabled: true,
    },
    widget("widget-title", 0, "Title", "did:ng:z:text"),
    widget("widget-author", 1, "Author", "did:ng:z:text"),
    widget("widget-rating", 2, "Rating", "did:ng:z:number"),
    widget("widget-finished", 3, "Finished", "did:ng:z:date"),
    ...books.map((book, i) => ({
      "@graph": graph, "@id": `book-${i}`, "@type": `did:ng:z:user:${SCHEMA}`, ...book,
    })),
  ];
}

async function seed(page: Page, options: { datalets?: unknown; graph?: string } = {}) {
  await page.addInitScript((input) => {
    localStorage.clear();
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "docs", private_store_id: "test-private-store",
      protected_store_id: "test-protected-store", public_store_id: "test-public-store",
    }));
    const ids = input.records.map((r) => `${r["@graph"]}|${r["@id"]}`);
    localStorage.setItem(`${input.store}:index`, JSON.stringify(ids));
    input.records.forEach((r, i) => {
      localStorage.setItem(`${input.store}:record:${ids[i]}`, JSON.stringify(r));
    });
    if (input.datalets) localStorage.setItem("meta-ui-builder:datalets", JSON.stringify(input.datalets));
  }, {
    store: STORE,
    records: readingList(options.graph) as Array<Record<string, string>>,
    datalets: options.datalets ?? null,
  });

  // The sync panels render from these; stubbed so the library never depends on
  // a running server.
  await page.route("**/sync/snapshot?*", (r) => r.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ seq: 12, records: {} }) }));
  await page.route("**/sync/stream?*", (r) => r.abort());
  await page.route("**/sync/stream-ticket?*", (r) => r.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ ticket: "t" }) }));
  await page.route("**/sync/patches?*", (r) => r.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ accepted: true, seq: 12, acceptedCount: 1, submittedCount: 1 }) }));
  await page.route("**/sync/clone-codes*", (r) => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ codes: [{ code: "COPY-K3RM-9T7A-X", createdAt: COPIED_AT }] }) }));
}

/** Settle: fonts loaded, subscriptions resolved, no scroll animation pending. */
async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

async function shot(page: Page, name: string, selector?: string) {
  await settle(page);
  const target = selector ? page.locator(selector).first() : page;
  await target.screenshot({ path: `${OUT}/${name}.png`, ...(selector ? {} : { fullPage: true }) });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  // Smooth scrolling would make anchor shots race the animation.
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("the app in use", async ({ page }) => {
  await seed(page);
  await page.goto("/");
  await shot(page, "app-reading-list");
});

test("settings hub", async ({ page }) => {
  await seed(page);
  await page.goto("/settings");
  await shot(page, "settings");
});

test("datalets and devices", async ({ page }) => {
  await seed(page, {
    graph: `did:ng:${vault("a").vaultId}`,
    datalets: {
      activeId: "a",
      entries: [
        { id: "a", vault: vault("a") },
        { id: "b", title: "Field notes", vault: vault("b") },
        { id: "c", title: "Recipes", vault: vault("c"), copiedAt: COPIED_AT },
        { id: "d", title: "Conference notes", vault: vault("d"), archivedAt: COPIED_AT },
        { id: "e", title: "Old sketches", vault: vault("e"), archivedAt: COPIED_AT },
      ],
    },
  });
  await page.goto("/settings/datalets");
  await shot(page, "datalets");
  await shot(page, "switch-datalet", "#switch-datalet");
  // Expanded, or the shot shows a closed row and explains nothing.
  await page.getByText("Archived (2)").click();
  await shot(page, "switch-datalet-archived", "#switch-datalet");
  await page.getByRole("button", { name: "Remove permanently…" }).first().click();
  await shot(page, "remove-permanently", ".datalet-remove");
  await shot(page, "storage", "#storage");
  await shot(page, "copy-codes", "#copy-codes");
  await shot(page, "sync-paired", "#sync");
});

test("sync before pairing", async ({ page }) => {
  await seed(page);
  await page.goto("/settings/datalets");
  await shot(page, "sync-unpaired", "#sync");
});

test("theme", async ({ page }) => {
  await seed(page);
  await page.goto("/settings/theme");
  await shot(page, "theme");
});

test("the schema editor", async ({ page }) => {
  await seed(page);
  await page.goto(`/settings/schemas/${encodeURIComponent(SCHEMA)}`);
  await shot(page, "schema-editor");
});

test("the screen builder", async ({ page }) => {
  await seed(page);
  await page.goto("/settings/tabs");
  await shot(page, "tabs-manager");
});
