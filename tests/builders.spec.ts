import { expect, test, type Page } from "@playwright/test";

const STORE_KEY = "meta-ui-builder:ng-local-store";
const INDEX_KEY = `${STORE_KEY}:index`;
const RECORD_PREFIX = `${STORE_KEY}:record:`;
const SESSION_KEY = "meta-ui-builder:local-session";
const GRAPH = "did:ng:test-private-store";
const HOME_ID = "did:ng:z:HomeTab";

async function seedSession(page: Page) {
  await page.addInitScript(
    ({ sessionKey }) => {
      if (localStorage.getItem(sessionKey)) return;
      localStorage.clear();
      localStorage.setItem(
        sessionKey,
        JSON.stringify({
          session_id: "test-session",
          private_store_id: "test-private-store",
          protected_store_id: "test-protected-store",
          public_store_id: "test-public-store",
        }),
      );
    },
    { sessionKey: SESSION_KEY },
  );
}

async function seedRecords(page: Page, records: Array<Record<string, unknown>>) {
  await page.addInitScript(
    ({ indexKey, prefix, values }) => {
      if (localStorage.getItem(indexKey)) return;
      const ids = values.map((record) => `${record["@graph"]}|${record["@id"]}`);
      localStorage.setItem(indexKey, JSON.stringify(ids));
      values.forEach((record, index) => {
        localStorage.setItem(prefix + ids[index], JSON.stringify(record));
      });
    },
    { indexKey: INDEX_KEY, prefix: RECORD_PREFIX, values: records },
  );
}

async function persistedRecords(page: Page) {
  return page.evaluate(
    ({ indexKey, prefix }) => {
      const ids = JSON.parse(localStorage.getItem(indexKey) ?? "[]") as string[];
      return ids.flatMap((id) => {
        const raw = localStorage.getItem(prefix + id);
        return raw ? [JSON.parse(raw) as Record<string, unknown>] : [];
      });
    },
    { indexKey: INDEX_KEY, prefix: RECORD_PREFIX },
  );
}

const singletonRecords = [
  { "@graph": GRAPH, "@id": HOME_ID, "@type": "did:ng:z:Tab", title: "Home", order: 0 },
  { "@graph": GRAPH, "@id": "did:ng:z:SettingsSingleton", "@type": "did:ng:z:Settings", appTitle: "Test datalet" },
];

test("creates and edits a schema while preserving property order across reload", async ({ page }) => {
  await seedSession(page);
  await seedRecords(page, singletonRecords);
  await page.goto("/settings/schemas");

  await page.getByRole("button", { name: "+ New schema" }).click();
  await expect(page.getByRole("heading", { name: "New schema" })).toBeVisible();
  await page.getByLabel("Schema name").fill("Projects");
  await page.getByLabel("Schema name").press("Enter");

  await page.getByRole("button", { name: "+ Add property" }).click();
  await page.getByRole("button", { name: "+ Add property" }).click();
  const names = page.getByLabel("Name", { exact: true });
  await names.nth(0).fill("Title");
  await names.nth(0).press("Enter");
  await names.nth(1).fill("Budget");
  await names.nth(1).press("Enter");
  await page.getByLabel("Data type").nth(1).selectOption({ label: "Number" });
  await page.getByRole("button", { name: "Move Budget up" }).click();
  await page.getByLabel("Show records as").selectOption({ label: "Title" });

  await expect(names.nth(0)).toHaveValue("Budget");
  await expect(names.nth(1)).toHaveValue("Title");
  await page.reload();
  await expect(page.getByLabel("Schema name")).toHaveValue("Projects");
  await expect(page.getByLabel("Name", { exact: true }).nth(0)).toHaveValue("Budget");
  await expect(page.getByLabel("Data type").nth(0)).toHaveValue("did:ng:z:number");
  await expect(page.getByLabel("Show records as").locator("option:checked")).toHaveText("Title");
  await page.getByLabel("Data type").nth(1).selectOption({ label: "Number" });
  await expect(page.getByLabel("Show records as").locator("option:checked")).toContainText("Automatic");
  await page.reload();
  await expect(page.getByLabel("Show records as").locator("option:checked")).toContainText("Automatic");

  await page.getByRole("link", { name: "← Back to schemas" }).click();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect(page.getByText("2 properties", { exact: true })).toBeVisible();
});

test("creates, renames, reorders, and deletes navigation tabs", async ({ page }) => {
  await seedSession(page);
  await seedRecords(page, singletonRecords);
  await page.goto("/settings/tabs");

  await page.getByRole("button", { name: "+ New tab" }).click();
  await page.getByRole("button", { name: "+ New tab" }).click();
  const names = page.getByLabel("Tab name");
  await names.nth(0).fill("Projects");
  await names.nth(0).press("Enter");
  await names.nth(1).fill("Archive");
  await names.nth(1).press("Enter");
  await page.getByRole("button", { name: "Move Archive up" }).click();

  await expect(names.nth(0)).toHaveValue("Archive");
  await expect(names.nth(1)).toHaveValue("Projects");
  await page.reload();
  await expect(page.getByLabel("Tab name").nth(0)).toHaveValue("Archive");
  // Home and Settings are icon links, so their names live on the label
  // rather than in the text; user tabs in between still read as text.
  const navLabels = await page
    .locator(".app-nav-links a")
    .evaluateAll((links) =>
      links.map((link) => link.getAttribute("aria-label") ?? link.textContent),
    );
  expect(navLabels).toEqual(["Home", "Archive", "Projects", "Settings"]);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete Archive" }).click();
  await expect(page.getByLabel("Tab name")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Archive" })).toHaveCount(0);
});

test("tab URLs use readable slugs while raw ids and collisions still resolve", async ({ page }) => {
  const firstId = "did:ng:z:meta:tab:project-notes-first";
  const secondId = "did:ng:z:meta:tab:project-notes-second";
  await seedSession(page);
  await seedRecords(page, [
    ...singletonRecords,
    { "@graph": GRAPH, "@id": firstId, "@type": "did:ng:z:Tab", title: "Project Notes", order: 1 },
    { "@graph": GRAPH, "@id": secondId, "@type": "did:ng:z:Tab", title: "Project--Notes", order: 2 },
  ]);

  await page.goto("/");
  await page.getByRole("link", { name: "Project Notes", exact: true }).click();
  await expect(page).toHaveURL(/\/tab\/project-notes$/);
  await expect(page.getByRole("main").getByText("Project Notes", { exact: true })).toBeVisible();

  await page.goto(`/tab/${encodeURIComponent(firstId)}`);
  await expect(page.getByRole("main").getByText("Project Notes", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Project Notes", exact: true })).toHaveClass(/active/);

  await page.getByRole("link", { name: "Project--Notes", exact: true }).click();
  expect(decodeURIComponent(new URL(page.url()).pathname)).toBe(`/tab/${secondId}`);
  await expect(page.getByRole("main").getByText("Project--Notes", { exact: true })).toBeVisible();

  await page.goto("/tab/does-not-exist");
  await expect(page.getByText("Tab not found.", { exact: true })).toBeVisible();
});

test("builds nested blocks and supports widget add, reorder, delete, and cascade cleanup", async ({ page }) => {
  const schemaId = "schema-projects";
  const tabId = "tab-projects";
  await seedSession(page);
  await seedRecords(page, [
    ...singletonRecords,
    { "@graph": GRAPH, "@id": tabId, "@type": "did:ng:z:Tab", title: "Projects", order: 1 },
    { "@graph": GRAPH, "@id": schemaId, "@type": "did:ng:z:SchemaDef", name: "Projects" },
    { "@graph": GRAPH, "@id": "property-name", "@type": "did:ng:z:PropertyDef", schemaId, name: "Name", order: 0, dataType: "did:ng:z:text", cardinality: "did:ng:z:one", enumOptions: [] },
  ]);
  await page.goto(`/settings/tabs/${tabId}/blocks`);

  await page.getByRole("button", { name: "+ Add layout block" }).click();
  const layout = page.locator("article.builder-card").filter({ hasText: "Layout block" }).first();
  await layout.getByLabel("Layout mode").selectOption({ label: "Grid" });
  await layout.getByRole("button", { name: "+ Add data block" }).click();

  const dataBlock = layout.locator("article.builder-card").filter({ hasText: "Data block" }).first();
  await expect(dataBlock.locator(".builder-widget-card")).toHaveCount(4);
  await dataBlock.getByLabel("New widget type").selectOption({ label: "Field" });
  await dataBlock.getByRole("button", { name: "+ Add widget" }).click();
  await expect(dataBlock.locator(".builder-widget-card")).toHaveCount(5);
  await dataBlock.getByLabel("Label").last().fill("Secondary name");
  await dataBlock.locator(".builder-widget-card").last().getByRole("button", { name: "Move widget up" }).click();
  await expect(dataBlock.locator(".builder-widget-card").nth(3).getByLabel("Label")).toHaveValue("Secondary name");
  await dataBlock.getByRole("button", { name: "Remove widget Secondary name" }).click();
  await expect(dataBlock.locator(".builder-widget-card")).toHaveCount(4);

  await page.getByRole("link", { name: "View tab →" }).click();
  await expect(page.getByRole("heading", { name: "Projects" }).last()).toBeVisible();
  await page.goBack();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete New layout" }).click();
  await expect(page.getByText("No blocks at this level.", { exact: true })).toBeVisible();

  await expect.poll(async () => {
    const records = await persistedRecords(page);
    return records.filter((record) =>
      record["@type"] === "did:ng:z:Block" || record["@type"] === "did:ng:z:Widget"
    ).length;
  }).toBe(0);
});

test("deleting a schema removes its data blocks and repairs surviving references", async ({ page }) => {
  const authorsId = "schema-authors";
  const booksId = "schema-books";
  await seedSession(page);
  await seedRecords(page, [
    ...singletonRecords,
    { "@graph": GRAPH, "@id": authorsId, "@type": "did:ng:z:SchemaDef", name: "Authors" },
    { "@graph": GRAPH, "@id": booksId, "@type": "did:ng:z:SchemaDef", name: "Books" },
    { "@graph": GRAPH, "@id": "property-author-name", "@type": "did:ng:z:PropertyDef", schemaId: authorsId, name: "Name", order: 0, dataType: "did:ng:z:text", cardinality: "did:ng:z:one", enumOptions: [] },
    { "@graph": GRAPH, "@id": "property-book-author", "@type": "did:ng:z:PropertyDef", schemaId: booksId, name: "Author", order: 0, dataType: "did:ng:z:reference", cardinality: "did:ng:z:one", enumOptions: [], referenceSchemaId: authorsId },
    { "@graph": GRAPH, "@id": "block-authors", "@type": "did:ng:z:Block", parentTabId: HOME_ID, blockType: "did:ng:z:data", schemaId: authorsId, order: 0 },
    { "@graph": GRAPH, "@id": "block-books", "@type": "did:ng:z:Block", parentTabId: HOME_ID, blockType: "did:ng:z:data", schemaId: booksId, order: 1 },
    { "@graph": GRAPH, "@id": "widget-author-name", "@type": "did:ng:z:Widget", parentBlockId: "block-authors", widgetType: "did:ng:z:field", propertyName: "Name", fieldType: "did:ng:z:text", order: 0 },
    { "@graph": GRAPH, "@id": "widget-book-author", "@type": "did:ng:z:Widget", parentBlockId: "block-books", widgetType: "did:ng:z:field", propertyName: "Author", fieldType: "did:ng:z:reference", order: 0 },
  ]);
  await page.goto("/settings/schemas");

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete Authors" }).click();
  await expect(page.getByRole("heading", { name: "Authors" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Books" })).toBeVisible();

  await expect.poll(async () => {
    const records = await persistedRecords(page);
    const bookReference = records.find((record) => record["@id"] === "property-book-author");
    const bookWidget = records.find((record) => record["@id"] === "widget-book-author");
    return {
      deletedSchema: records.some((record) => record["@id"] === authorsId),
      deletedProperty: records.some((record) => record["@id"] === "property-author-name"),
      deletedBlock: records.some((record) => record["@id"] === "block-authors"),
      deletedWidget: records.some((record) => record["@id"] === "widget-author-name"),
      referenceType: bookReference?.dataType,
      referenceTarget: bookReference?.referenceSchemaId,
      widgetType: bookWidget?.fieldType,
    };
  }).toEqual({
    deletedSchema: false,
    deletedProperty: false,
    deletedBlock: false,
    deletedWidget: false,
    referenceType: "did:ng:z:text",
    referenceTarget: undefined,
    widgetType: "did:ng:z:text",
  });
});

test("adding a block creates it directly, with no form to submit first", async ({ page }) => {
  const tabId = "tab-idiom";
  const schemaId = "did:ng:z:meta:schema:idiom";
  await seedSession(page);
  await seedRecords(page, [
    ...singletonRecords,
    { "@graph": GRAPH, "@id": tabId, "@type": "did:ng:z:Tab", title: "Idiom", order: 1 },
    { "@graph": GRAPH, "@id": schemaId, "@type": "did:ng:z:SchemaDef", name: "Things" },
    { "@graph": GRAPH, "@id": "property-thing", "@type": "did:ng:z:PropertyDef", schemaId, name: "Name", order: 0, dataType: "did:ng:z:text", cardinality: "did:ng:z:one", enumOptions: [] },
  ]);
  await page.goto(`/settings/tabs/${tabId}/blocks`);

  // The builder's idiom everywhere else: press Add, get a defaulted item, edit
  // it in place. There is no type to choose and no schema to choose before the
  // block exists, so nothing reads as a Save that consumes what you typed.
  await expect(page.getByLabel("New block type")).toHaveCount(0);
  await expect(page.getByLabel("Data block schema")).toHaveCount(0);

  await page.getByRole("button", { name: "+ Add data block" }).click();
  const dataBlock = page.locator("article.builder-card").filter({ hasText: "Data block" }).first();
  await expect(dataBlock).toBeVisible();
  // Defaulted to a real schema, and changeable on the block itself afterwards.
  await expect(dataBlock.getByLabel("Schema", { exact: true })).toHaveValue(schemaId);
});

test("a nested block list says which level it is", async ({ page }) => {
  const tabId = "tab-levels";
  await seedSession(page);
  await seedRecords(page, [
    ...singletonRecords,
    { "@graph": GRAPH, "@id": tabId, "@type": "did:ng:z:Tab", title: "Levels", order: 1 },
  ]);
  await page.goto(`/settings/tabs/${tabId}/blocks`);

  await expect(page.getByRole("heading", { name: "Blocks on this tab" })).toBeVisible();
  await page.getByRole("button", { name: "+ Add layout block" }).click();
  // Two identical "Blocks" headings read as a duplicate rather than as the
  // layout's contents, which is what made the two levels confusing.
  await expect(page.getByRole("heading", { name: "Nested blocks" })).toBeVisible();
});
