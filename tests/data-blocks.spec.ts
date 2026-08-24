import { expect, test, type Page } from "@playwright/test";

const STORE_KEY = "meta-ui-builder:ng-local-store";
const INDEX_KEY = `${STORE_KEY}:index`;
const RECORD_PREFIX = `${STORE_KEY}:record:`;
const SESSION_KEY = "meta-ui-builder:local-session";
const PRIVATE_STORE_ID = "test-private-store";
const GRAPH = `did:ng:${PRIVATE_STORE_ID}`;
const SCHEMA_ID = "did:ng:z:meta:schema:books";
const BLOCK_ID = "block-books";

async function seedSession(page: Page) {
  await page.addInitScript(
    ({ sessionKey, privateStoreId }) => {
      if (localStorage.getItem(sessionKey)) return;
      localStorage.clear();
      localStorage.setItem(
        sessionKey,
        JSON.stringify({
          session_id: "test-session",
          private_store_id: privateStoreId,
          protected_store_id: "test-protected-store",
          public_store_id: "test-public-store",
        }),
      );
    },
    { sessionKey: SESSION_KEY, privateStoreId: PRIVATE_STORE_ID },
  );
}

async function seedNewFormat(page: Page, records: Array<Record<string, unknown>>) {
  await page.addInitScript(
    ({ indexKey, prefix, seededRecords }) => {
      if (localStorage.getItem(indexKey)) return;
      const ids = seededRecords.map((record) => `${record["@graph"]}|${record["@id"]}`);
      localStorage.setItem(indexKey, JSON.stringify(ids));
      seededRecords.forEach((record, index) => {
        localStorage.setItem(prefix + ids[index], JSON.stringify(record));
      });
    },
    { indexKey: INDEX_KEY, prefix: RECORD_PREFIX, seededRecords: records },
  );
}

/**
 * A Books data block plus `titles.length` records. `block` overrides let one
 * test seed search, paging, filtering, and sorting in whatever combination it
 * needs without re-listing the schema every time.
 */
function booksFixture(
  titles: Array<{ title: string; rating: number }>,
  block: Record<string, unknown> = {},
) {
  return [
    { "@graph": GRAPH, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Home", order: 0 },
    { "@graph": GRAPH, "@id": SCHEMA_ID, "@type": "did:ng:z:SchemaDef", name: "Books" },
    { "@graph": GRAPH, "@id": "property-title", "@type": "did:ng:z:PropertyDef", schemaId: SCHEMA_ID, name: "Title", order: 0, dataType: "did:ng:z:text", cardinality: "did:ng:z:one", enumOptions: [] },
    { "@graph": GRAPH, "@id": "property-rating", "@type": "did:ng:z:PropertyDef", schemaId: SCHEMA_ID, name: "Rating", order: 1, dataType: "did:ng:z:number", cardinality: "did:ng:z:one", enumOptions: [] },
    {
      "@graph": GRAPH,
      "@id": BLOCK_ID,
      "@type": "did:ng:z:Block",
      blockType: "did:ng:z:data",
      order: 0,
      schemaId: SCHEMA_ID,
      parentTabId: "did:ng:z:HomeTab",
      ...block,
    },
    { "@graph": GRAPH, "@id": "widget-title", "@type": "did:ng:z:Widget", parentBlockId: BLOCK_ID, order: 0, widgetType: "did:ng:z:field", propertyName: "Title", label: "Title", fieldType: "did:ng:z:text" },
    { "@graph": GRAPH, "@id": "widget-rating", "@type": "did:ng:z:Widget", parentBlockId: BLOCK_ID, order: 1, widgetType: "did:ng:z:field", propertyName: "Rating", label: "Rating", fieldType: "did:ng:z:number" },
    ...titles.map((entry, index) => ({
      "@graph": GRAPH,
      "@id": `book-${index}`,
      "@type": `did:ng:z:user:${SCHEMA_ID}`,
      Title: entry.title,
      Rating: entry.rating,
    })),
  ];
}

function referencedBooksFixture() {
  const authorSchemaId = "did:ng:z:meta:schema:authors";
  const bookSchemaId = "did:ng:z:meta:schema:referenced-books";
  const numericSchemaId = "did:ng:z:meta:schema:numeric-only";
  const blockId = "block-referenced-books";
  return [
    { "@graph": GRAPH, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Home", order: 0 },
    {
      "@graph": GRAPH,
      "@id": authorSchemaId,
      "@type": "did:ng:z:SchemaDef",
      name: "Authors",
      labelPropertyId: "property-author-nickname",
    },
    { "@graph": GRAPH, "@id": "property-author-name", "@type": "did:ng:z:PropertyDef", schemaId: authorSchemaId, name: "Name", order: 0, dataType: "did:ng:z:text", cardinality: "did:ng:z:one", enumOptions: [] },
    { "@graph": GRAPH, "@id": "property-author-nickname", "@type": "did:ng:z:PropertyDef", schemaId: authorSchemaId, name: "Nickname", order: 1, dataType: "did:ng:z:text", cardinality: "did:ng:z:one", enumOptions: [] },
    { "@graph": GRAPH, "@id": "author-a", "@type": `did:ng:z:user:${authorSchemaId}`, Name: "Alpha heuristic", Nickname: "Zulu" },
    { "@graph": GRAPH, "@id": "author-z", "@type": `did:ng:z:user:${authorSchemaId}`, Name: "Zulu heuristic", Nickname: "Alpha" },
    { "@graph": GRAPH, "@id": bookSchemaId, "@type": "did:ng:z:SchemaDef", name: "Referenced books" },
    { "@graph": GRAPH, "@id": "property-reference-title", "@type": "did:ng:z:PropertyDef", schemaId: bookSchemaId, name: "Title", order: 0, dataType: "did:ng:z:text", cardinality: "did:ng:z:one", enumOptions: [] },
    { "@graph": GRAPH, "@id": "property-reference-author", "@type": "did:ng:z:PropertyDef", schemaId: bookSchemaId, name: "Author", order: 1, dataType: "did:ng:z:reference", cardinality: "did:ng:z:one", enumOptions: [], referenceSchemaId: authorSchemaId },
    { "@graph": GRAPH, "@id": blockId, "@type": "did:ng:z:Block", blockType: "did:ng:z:data", order: 0, schemaId: bookSchemaId, parentTabId: "did:ng:z:HomeTab", searchEnabled: true, sortPropertyName: "Author" },
    { "@graph": GRAPH, "@id": "widget-reference-title", "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 0, widgetType: "did:ng:z:field", propertyName: "Title", label: "Title", fieldType: "did:ng:z:text" },
    { "@graph": GRAPH, "@id": "widget-reference-author", "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 1, widgetType: "did:ng:z:field", propertyName: "Author", label: "Author", fieldType: "did:ng:z:reference" },
    { "@graph": GRAPH, "@id": "book-first", "@type": `did:ng:z:user:${bookSchemaId}`, Title: "First", Author: "author-a" },
    { "@graph": GRAPH, "@id": "book-second", "@type": `did:ng:z:user:${bookSchemaId}`, Title: "Second", Author: "author-z" },
    { "@graph": GRAPH, "@id": numericSchemaId, "@type": "did:ng:z:SchemaDef", name: "Numeric only" },
    { "@graph": GRAPH, "@id": "property-numeric-value", "@type": "did:ng:z:PropertyDef", schemaId: numericSchemaId, name: "Value", order: 0, dataType: "did:ng:z:number", cardinality: "did:ng:z:one", enumOptions: [] },
    { "@graph": GRAPH, "@id": "numeric-record", "@type": `did:ng:z:user:${numericSchemaId}`, Value: 42 },
  ];
}

function eventsFixture(
  entries: Array<{ name: string; when: string }>,
  fieldType: "did:ng:z:date" | "did:ng:z:dateTime" = "did:ng:z:date",
) {
  const schemaId = "did:ng:z:meta:schema:events";
  const blockId = "block-events";
  return [
    { "@graph": GRAPH, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Home", order: 0 },
    { "@graph": GRAPH, "@id": schemaId, "@type": "did:ng:z:SchemaDef", name: "Events" },
    { "@graph": GRAPH, "@id": "property-event-name", "@type": "did:ng:z:PropertyDef", schemaId, name: "Name", order: 0, dataType: "did:ng:z:text", cardinality: "did:ng:z:one", enumOptions: [] },
    { "@graph": GRAPH, "@id": "property-event-when", "@type": "did:ng:z:PropertyDef", schemaId, name: "When", order: 1, dataType: "did:ng:z:date", cardinality: "did:ng:z:optional", enumOptions: [] },
    { "@graph": GRAPH, "@id": blockId, "@type": "did:ng:z:Block", blockType: "did:ng:z:data", order: 0, schemaId, parentTabId: "did:ng:z:HomeTab", sortPropertyName: "When" },
    { "@graph": GRAPH, "@id": "widget-event-name", "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 0, widgetType: "did:ng:z:field", propertyName: "Name", label: "Name", fieldType: "did:ng:z:text" },
    { "@graph": GRAPH, "@id": "widget-event-when", "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 1, widgetType: "did:ng:z:field", propertyName: "When", label: "When", fieldType },
    { "@graph": GRAPH, "@id": "widget-event-actions", "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 2, widgetType: "did:ng:z:editDeleteActions" },
    ...entries.map((entry, index) => ({
      "@graph": GRAPH,
      "@id": `event-${index}`,
      "@type": `did:ng:z:user:${schemaId}`,
      Name: entry.name,
      When: entry.when,
    })),
  ];
}

function contactFixture(website = "", email = "", notes = "") {
  const schemaId = "did:ng:z:meta:schema:contacts";
  const blockId = "block-contacts";
  return [
    { "@graph": GRAPH, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Home", order: 0 },
    { "@graph": GRAPH, "@id": schemaId, "@type": "did:ng:z:SchemaDef", name: "Contacts" },
    ...[
      ["Website", 0],
      ["Email", 1],
      ["Notes", 2],
    ].map(([name, order]) => ({
      "@graph": GRAPH,
      "@id": `property-contact-${String(name).toLowerCase()}`,
      "@type": "did:ng:z:PropertyDef",
      schemaId,
      name,
      order,
      dataType: "did:ng:z:text",
      cardinality: "did:ng:z:optional",
      enumOptions: [],
    })),
    { "@graph": GRAPH, "@id": blockId, "@type": "did:ng:z:Block", blockType: "did:ng:z:data", order: 0, schemaId, parentTabId: "did:ng:z:HomeTab" },
    { "@graph": GRAPH, "@id": "widget-contact-website", "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 0, widgetType: "did:ng:z:field", propertyName: "Website", label: "Website", fieldType: "did:ng:z:url" },
    { "@graph": GRAPH, "@id": "widget-contact-email", "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 1, widgetType: "did:ng:z:field", propertyName: "Email", label: "Email", fieldType: "did:ng:z:email" },
    { "@graph": GRAPH, "@id": "widget-contact-notes", "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 2, widgetType: "did:ng:z:field", propertyName: "Notes", label: "Notes", fieldType: "did:ng:z:longText" },
    { "@graph": GRAPH, "@id": "widget-contact-actions", "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 3, widgetType: "did:ng:z:editDeleteActions" },
    { "@graph": GRAPH, "@id": "contact-0", "@type": `did:ng:z:user:${schemaId}`, Website: website, Email: email, Notes: notes },
  ];
}

function noteFixture(body = "") {
  const schemaId = "did:ng:z:meta:schema:notes";
  const blockId = "block-notes";
  return [
    { "@graph": GRAPH, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Home", order: 0 },
    { "@graph": GRAPH, "@id": schemaId, "@type": "did:ng:z:SchemaDef", name: "Notes" },
    { "@graph": GRAPH, "@id": "property-note-body", "@type": "did:ng:z:PropertyDef", schemaId, name: "Body", order: 0, dataType: "did:ng:z:text", cardinality: "did:ng:z:optional", enumOptions: [] },
    { "@graph": GRAPH, "@id": blockId, "@type": "did:ng:z:Block", blockType: "did:ng:z:data", order: 0, schemaId, parentTabId: "did:ng:z:HomeTab" },
    { "@graph": GRAPH, "@id": "widget-note-body", "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 0, widgetType: "did:ng:z:field", propertyName: "Body", label: "Body", fieldType: "did:ng:z:markdown" },
    { "@graph": GRAPH, "@id": "widget-note-actions", "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 1, widgetType: "did:ng:z:editDeleteActions" },
    { "@graph": GRAPH, "@id": "note-0", "@type": `did:ng:z:user:${schemaId}`, Body: body },
  ];
}

function mixedFieldsFixture() {
  const schemaId = "did:ng:z:meta:schema:mixed";
  const blockId = "block-mixed";
  return [
    { "@graph": GRAPH, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Home", order: 0 },
    { "@graph": GRAPH, "@id": schemaId, "@type": "did:ng:z:SchemaDef", name: "Mixed" },
    { "@graph": GRAPH, "@id": "property-mixed-title", "@type": "did:ng:z:PropertyDef", schemaId, name: "Title", order: 0, dataType: "did:ng:z:text", cardinality: "did:ng:z:one", enumOptions: [] },
    { "@graph": GRAPH, "@id": "property-mixed-notes", "@type": "did:ng:z:PropertyDef", schemaId, name: "Notes", order: 1, dataType: "did:ng:z:text", cardinality: "did:ng:z:optional", enumOptions: [] },
    { "@graph": GRAPH, "@id": "property-mixed-body", "@type": "did:ng:z:PropertyDef", schemaId, name: "Body", order: 2, dataType: "did:ng:z:text", cardinality: "did:ng:z:optional", enumOptions: [] },
    { "@graph": GRAPH, "@id": blockId, "@type": "did:ng:z:Block", blockType: "did:ng:z:data", order: 0, schemaId, parentTabId: "did:ng:z:HomeTab" },
    { "@graph": GRAPH, "@id": "widget-mixed-title", "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 0, widgetType: "did:ng:z:field", propertyName: "Title", label: "Title", fieldType: "did:ng:z:text" },
    { "@graph": GRAPH, "@id": "widget-mixed-notes", "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 1, widgetType: "did:ng:z:field", propertyName: "Notes", label: "Notes", fieldType: "did:ng:z:longText" },
    { "@graph": GRAPH, "@id": "widget-mixed-body", "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 2, widgetType: "did:ng:z:field", propertyName: "Body", label: "Body", fieldType: "did:ng:z:markdown" },
    { "@graph": GRAPH, "@id": "mixed-0", "@type": `did:ng:z:user:${schemaId}`, Title: "Alpha", Notes: "some notes", Body: "some body" },
  ];
}

const SEARCH_LABEL = "Search Books";

test("search narrows a data block to matching records", async ({ page }) => {
  await seedSession(page);
  await seedNewFormat(
    page,
    booksFixture(
      [
        { title: "Dune", rating: 5 },
        { title: "Neuromancer", rating: 4 },
        { title: "Duneless", rating: 3 },
      ],
      { searchEnabled: true },
    ),
  );
  await page.goto("/");
  const cards = page.locator(".record-card");
  await expect(cards).toHaveCount(3);

  await page.getByLabel(SEARCH_LABEL).fill("dune");
  await expect(cards).toHaveCount(2);
  expect(await cards.nth(0).textContent()).toContain("Dune");
  expect(await cards.nth(1).textContent()).toContain("Duneless");

  // Search reads every bound field, not just the first one.
  await page.getByLabel(SEARCH_LABEL).fill("4");
  await expect(cards).toHaveCount(1);
  expect(await cards.nth(0).textContent()).toContain("Neuromancer");

  await page.getByLabel(SEARCH_LABEL).fill("nothing matches this");
  await expect(cards).toHaveCount(0);
  await expect(page.getByText("No records match.")).toBeVisible();

  await page.getByLabel(SEARCH_LABEL).fill("");
  await expect(cards).toHaveCount(3);
});

test("the search box stays hidden unless the block enables it", async ({ page }) => {
  await seedSession(page);
  await seedNewFormat(page, booksFixture([{ title: "Dune", rating: 5 }]));
  await page.goto("/");
  await expect(page.locator(".record-card")).toHaveCount(1);
  await expect(page.getByLabel(SEARCH_LABEL)).toHaveCount(0);
});

test("search composes with a configured filter and sort rather than replacing them", async ({ page }) => {
  await seedSession(page);
  await seedNewFormat(
    page,
    booksFixture(
      [
        { title: "Dune", rating: 2 },
        { title: "Dune Messiah", rating: 10 },
        { title: "Neuromancer", rating: 9 },
        { title: "Emma", rating: 1 },
      ],
      {
        searchEnabled: true,
        filterPropertyName: "Title",
        filterValue: "e",
        sortPropertyName: "Rating",
        sortDirection: "did:ng:z:descending",
      },
    ),
  );
  await page.goto("/");
  const cards = page.locator(".record-card");
  // Every title contains "e", so the configured filter keeps all four,
  // ordered by rating descending: 10, 9, 2, 1.
  await expect(cards).toHaveCount(4);
  expect(await cards.nth(0).textContent()).toContain("Dune Messiah");
  expect(await cards.nth(1).textContent()).toContain("Neuromancer");

  await page.getByLabel(SEARCH_LABEL).fill("dune");
  // Search intersects the filter, and the configured sort still applies.
  await expect(cards).toHaveCount(2);
  expect(await cards.nth(0).textContent()).toContain("Dune Messiah");
  expect(await cards.nth(1).textContent()).toContain("Dune");
});

test("pagination splits records at the configured page size", async ({ page }) => {
  await seedSession(page);
  const titles = Array.from({ length: 5 }, (_, index) => ({
    title: `Book ${index}`,
    rating: index,
  }));
  await seedNewFormat(
    page,
    booksFixture(titles, { pageSize: 2, sortPropertyName: "Rating" }),
  );
  await page.goto("/");
  const cards = page.locator(".record-card");

  await expect(cards).toHaveCount(2);
  await expect(page.getByText("Showing 1–2 of 5")).toBeVisible();
  await expect(page.getByText("Page 1 of 3")).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Showing 3–4 of 5")).toBeVisible();
  expect(await cards.nth(0).textContent()).toContain("Book 2");

  // The final page holds the remainder, not a full page.
  await page.getByRole("button", { name: "Next" }).click();
  await expect(cards).toHaveCount(1);
  await expect(page.getByText("Showing 5–5 of 5")).toBeVisible();
  await expect(page.getByText("Page 3 of 3")).toBeVisible();
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();

  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.getByText("Showing 3–4 of 5")).toBeVisible();
});

test("a page size that exactly divides the records leaves no trailing empty page", async ({ page }) => {
  await seedSession(page);
  const titles = Array.from({ length: 4 }, (_, index) => ({
    title: `Book ${index}`,
    rating: index,
  }));
  await seedNewFormat(page, booksFixture(titles, { pageSize: 2 }));
  await page.goto("/");
  await expect(page.getByText("Page 1 of 2")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Showing 3–4 of 4")).toBeVisible();
  await expect(page.getByRole("button", { name: "Next" })).toBeDisabled();
});

test("no pagination controls appear when the block shows every record", async ({ page }) => {
  await seedSession(page);
  await seedNewFormat(
    page,
    booksFixture([
      { title: "Dune", rating: 5 },
      { title: "Emma", rating: 1 },
    ]),
  );
  await page.goto("/");
  await expect(page.locator(".record-card")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Next" })).toHaveCount(0);
});

test("searching resets paging to the first page", async ({ page }) => {
  await seedSession(page);
  const titles = [
    { title: "Alpha", rating: 1 },
    { title: "Bravo", rating: 2 },
    { title: "Charlie", rating: 3 },
    { title: "Delta", rating: 4 },
    { title: "Alpaca", rating: 5 },
  ];
  await seedNewFormat(
    page,
    booksFixture(titles, { pageSize: 2, searchEnabled: true, sortPropertyName: "Rating" }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Page 3 of 3")).toBeVisible();

  // Without a reset this would hold page 3 of a now 1-page result and show
  // nothing at all.
  await page.getByLabel(SEARCH_LABEL).fill("alp");
  await expect(page.getByText("Page 1 of 1")).toBeVisible();
  const cards = page.locator(".record-card");
  await expect(cards).toHaveCount(2);
  expect(await cards.nth(0).textContent()).toContain("Alpha");
});

test("deleting the last record on the final page falls back to the previous page", async ({ page }) => {
  await seedSession(page);
  const titles = [
    { title: "Alpha", rating: 1 },
    { title: "Bravo", rating: 2 },
    { title: "Charlie", rating: 3 },
  ];
  const records = booksFixture(titles, { pageSize: 2, sortPropertyName: "Rating" });
  records.push({
    "@graph": GRAPH,
    "@id": "widget-actions",
    "@type": "did:ng:z:Widget",
    parentBlockId: BLOCK_ID,
    order: 2,
    widgetType: "did:ng:z:editDeleteActions",
  });
  await seedNewFormat(page, records);
  await page.goto("/");

  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Showing 3–3 of 3")).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete record" }).click();

  // The page index is clamped, so the reader sees the shortened list instead
  // of an empty page 2.
  await expect(page.getByText("Showing 1–2 of 2")).toBeVisible();
  await expect(page.locator(".record-card")).toHaveCount(2);
});

test("an active search reflects record changes without a reload", async ({ page }) => {
  await seedSession(page);
  const records = booksFixture(
    [
      { title: "Dune", rating: 5 },
      { title: "Dusk", rating: 4 },
      { title: "Emma", rating: 3 },
    ],
    { searchEnabled: true, sortPropertyName: "Rating" },
  );
  records.push({
    "@graph": GRAPH,
    "@id": "widget-actions",
    "@type": "did:ng:z:Widget",
    parentBlockId: BLOCK_ID,
    order: 2,
    widgetType: "did:ng:z:editDeleteActions",
  });
  await seedNewFormat(page, records);
  await page.goto("/");

  // "Emma" is excluded by the query; "Dusk" sorts first on rating ascending.
  await page.getByLabel(SEARCH_LABEL).fill("du");
  const cards = page.locator(".record-card");
  await expect(cards).toHaveCount(2);

  page.once("dialog", (dialog) => dialog.accept());
  await cards.nth(0).getByRole("button", { name: "Delete record" }).click();

  // The search result is memoized on the subscription, so it has to recompute
  // when the underlying records change and not only when the query does.
  await expect(cards).toHaveCount(1);
  expect(await cards.nth(0).textContent()).toContain("Dune");
  await expect(page.getByLabel(SEARCH_LABEL)).toHaveValue("du");
});

test("edited record fields stay current on screen and in storage", async ({ page }) => {
  await seedSession(page);
  const records = booksFixture([{ title: "Dune", rating: 5 }]);
  records.push({
    "@graph": GRAPH,
    "@id": "widget-actions",
    "@type": "did:ng:z:Widget",
    parentBlockId: BLOCK_ID,
    order: 2,
    widgetType: "did:ng:z:editDeleteActions",
  });
  await seedNewFormat(page, records);
  await page.goto("/");

  await page.getByRole("button", { name: "Edit record" }).click();
  const title = page.getByLabel("Title");
  await title.fill("Dune Messiah");

  // The deep-signal adapter replaces a record proxy after a write. The card
  // must receive the replacement instead of snapping back to its stale prop.
  await expect(title).toHaveValue("Dune Messiah");
  await page.waitForTimeout(200);
  await expect
    .poll(() => page.evaluate(
      ({ prefix, key }) => JSON.parse(localStorage.getItem(prefix + key) ?? "null")?.Title,
      { prefix: RECORD_PREFIX, key: `${GRAPH}|book-0` },
    ))
    .toBe("Dune Messiah");
});

test("undo reverts an edit on screen and in persisted bytes", async ({ page }) => {
  await seedSession(page);
  const records = booksFixture([{ title: "Dune", rating: 5 }]);
  records.push({
    "@graph": GRAPH,
    "@id": "widget-actions",
    "@type": "did:ng:z:Widget",
    parentBlockId: BLOCK_ID,
    order: 2,
    widgetType: "did:ng:z:editDeleteActions",
  });
  await seedNewFormat(page, records);
  await page.goto("/");

  const undo = page.getByRole("button", { name: "Undo" });
  await expect(undo).toBeDisabled();
  await page.getByRole("button", { name: "Edit record" }).click();
  await page.getByLabel("Title").fill("Dune Messiah");
  await expect(undo).toBeEnabled();
  await undo.click();

  await expect.poll(() => page.evaluate(
    ({ prefix, key }) => JSON.parse(localStorage.getItem(prefix + key) ?? "null")?.Title,
    { prefix: RECORD_PREFIX, key: `${GRAPH}|book-0` },
  )).toBe("Dune");
  await expect(page.getByLabel("Title")).toHaveValue("Dune");
  await expect(undo).toBeDisabled();
});

test("typing a value is one undo, and a pause starts the next one", async ({ page }) => {
  await seedSession(page);
  const records = booksFixture([{ title: "Dune", rating: 5 }]);
  records.push({
    "@graph": GRAPH,
    "@id": "widget-actions",
    "@type": "did:ng:z:Widget",
    parentBlockId: BLOCK_ID,
    order: 2,
    widgetType: "did:ng:z:editDeleteActions",
  });
  await seedNewFormat(page, records);
  await page.goto("/");

  const undo = page.getByRole("button", { name: "Undo" });
  const persistedTitle = () => page.evaluate(
    ({ prefix, key }) => JSON.parse(localStorage.getItem(prefix + key) ?? "null")?.Title,
    { prefix: RECORD_PREFIX, key: `${GRAPH}|book-0` },
  );
  await page.getByRole("button", { name: "Edit record" }).click();
  const title = page.getByLabel("Title");

  // Every keystroke writes to the record. Twelve of them plus the clear are
  // one editing gesture, so one undo has to take all of them back.
  await title.fill("");
  await title.pressSequentially("Dune Messiah");
  await expect.poll(persistedTitle).toBe("Dune Messiah");
  await undo.click();
  await expect.poll(persistedTitle).toBe("Dune");
  await expect(title).toHaveValue("Dune");
  await expect(undo).toBeDisabled();

  // A gap longer than the coalescing window means a separate action, so two
  // edits either side of one stay separately undoable.
  await title.fill("Children of Dune");
  await page.waitForTimeout(1_500);
  await title.fill("God Emperor of Dune");
  await expect.poll(persistedTitle).toBe("God Emperor of Dune");
  await undo.click();
  await expect.poll(persistedTitle).toBe("Children of Dune");
  await undo.click();
  await expect.poll(persistedTitle).toBe("Dune");
  await expect(undo).toBeDisabled();
});

test("a newly created record gets a clean, non-composite subject id", async ({ page }) => {
  // Same invariant as builders.spec.ts's PropertyDef test, for the other
  // site that used to rely on @ng-org/orm's own buggy "@id": "" auto-id
  // path: BlockRenderer.tsx's createRecord. See that test's comment for the
  // full story - a malformed id here is just as permanent and just as
  // fatal to every future copy/join of the vault holding it.
  await seedSession(page);
  const records = booksFixture([{ title: "Dune", rating: 5 }]);
  records.push({
    "@graph": GRAPH,
    "@id": "widget-add",
    "@type": "did:ng:z:Widget",
    parentBlockId: BLOCK_ID,
    order: 2,
    widgetType: "did:ng:z:addButton",
    label: "Add book",
  });
  await seedNewFormat(page, records);
  await page.goto("/");

  const before = await page.evaluate((key) =>
    JSON.parse(localStorage.getItem(key) ?? "[]") as string[], INDEX_KEY);

  await page.getByRole("button", { name: "+ Add book" }).click();
  await expect(page.locator(".record-card")).toHaveCount(2);

  // Persistence is debounced relative to the render, and the app's own
  // Settings/Home-tab bootstrap writes (SettingsProvider, MetaStoreContext)
  // land around the same time - filtering by the dynamic user-record type
  // (did:ng:z:user:<schema>) is what actually isolates the new book, not
  // just "anything not in `before`".
  const isNewBook = (record: { "@type"?: string } | null) =>
    typeof record?.["@type"] === "string" && record["@type"].startsWith("did:ng:z:user:");
  await expect.poll(async () => {
    const after = await page.evaluate((key) =>
      JSON.parse(localStorage.getItem(key) ?? "[]") as string[], INDEX_KEY);
    const newKeys = after.filter((key) => !before.includes(key));
    const records = await Promise.all(newKeys.map((key) =>
      page.evaluate(({ prefix, key }) => JSON.parse(localStorage.getItem(prefix + key) ?? "null"), { prefix: RECORD_PREFIX, key })));
    return records.some(isNewBook);
  }, { message: "expected a newly created book record to appear in the persisted index" }).toBe(true);

  const after = await page.evaluate((key) =>
    JSON.parse(localStorage.getItem(key) ?? "[]") as string[], INDEX_KEY);
  const newKeys = after.filter((key) => !before.includes(key));
  const newRecords: Array<{ "@type"?: string; "@id"?: string }> = await Promise.all(newKeys.map((key) =>
    page.evaluate(({ prefix, key }) => JSON.parse(localStorage.getItem(prefix + key) ?? "null"), { prefix: RECORD_PREFIX, key })));
  const record = newRecords.find(isNewBook)!;
  const id = record["@id"] as string;
  expect(id).not.toContain("|");
  expect(id.startsWith(`${GRAPH}:q:`)).toBe(true);
});

test("undo is session-local and Ctrl/Cmd+Z removes a newly created record", async ({ page }) => {
  await seedSession(page);
  const records = booksFixture([{ title: "Dune", rating: 5 }]);
  records.push({
    "@graph": GRAPH,
    "@id": "widget-add",
    "@type": "did:ng:z:Widget",
    parentBlockId: BLOCK_ID,
    order: 2,
    widgetType: "did:ng:z:addButton",
    label: "Add book",
  });
  records.push({
    "@graph": GRAPH,
    "@id": "widget-actions",
    "@type": "did:ng:z:Widget",
    parentBlockId: BLOCK_ID,
    order: 3,
    widgetType: "did:ng:z:editDeleteActions",
  });
  await seedNewFormat(page, records);
  await page.goto("/");

  await page.getByRole("button", { name: "+ Add book" }).click();
  await expect(page.locator(".record-card")).toHaveCount(2);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".record-card")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();

  await page.getByRole("button", { name: "Edit record" }).click();
  await page.getByLabel("Title").fill("Emma");
  await expect.poll(() => page.evaluate(
    ({ prefix, key }) => JSON.parse(localStorage.getItem(prefix + key) ?? "null")?.Title,
    { prefix: RECORD_PREFIX, key: `${GRAPH}|book-0` },
  )).toBe("Emma");
  // Make and persist one new edit, then reload: the value survives but the
  // in-memory undo stack deliberately does not.
  await page.reload();
  await expect(page.getByText("Emma", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
});

test("date fields persist byte-identically and empty dates stay empty", async ({ page }) => {
  await seedSession(page);
  await seedNewFormat(page, eventsFixture([
    { name: "Launch", when: "2026-08-01" },
    { name: "Unscheduled", when: "" },
  ]));
  await page.goto("/");

  const launch = page.locator(".record-card").filter({ hasText: "Launch" });
  await launch.getByRole("button", { name: "Edit record" }).click();
  await page.getByLabel("When").fill("2026-08-08");
  await expect(page.getByLabel("When")).toHaveValue("2026-08-08");
  await expect.poll(() => page.evaluate(
    ({ prefix, key }) => JSON.parse(localStorage.getItem(prefix + key) ?? "null")?.When,
    { prefix: RECORD_PREFIX, key: `${GRAPH}|event-0` },
  )).toBe("2026-08-08");

  await page.reload();
  const reloadedLaunch = page.locator(".record-card").filter({ hasText: "Launch" });
  await reloadedLaunch.getByRole("button", { name: "Edit record" }).click();
  await expect(page.getByLabel("When")).toHaveValue("2026-08-08");
  await page.getByRole("button", { name: "Done editing" }).click();
  const unscheduled = page.locator(".record-card").filter({ hasText: "Unscheduled" });
  await unscheduled.getByRole("button", { name: "Edit record" }).click();
  await expect(page.getByLabel("When")).toHaveValue("");
});

test("date sorting is chronological for normalized stored values", async ({ page }) => {
  await seedSession(page);
  await seedNewFormat(page, eventsFixture([
    { name: "Latest", when: "2026-12-31" },
    { name: "Earliest", when: "2025-01-10" },
    { name: "Middle", when: "2026-02-03" },
  ]));
  await page.goto("/");

  const cards = page.locator(".record-card");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText("Earliest");
  await expect(cards.nth(1)).toContainText("Middle");
  await expect(cards.nth(2)).toContainText("Latest");
});

test("date-time fields store UTC while preserving the local editor value", async ({ page }) => {
  await seedSession(page);
  await seedNewFormat(
    page,
    eventsFixture([{ name: "Call", when: "" }], "did:ng:z:dateTime"),
  );
  await page.goto("/");

  await page.getByRole("button", { name: "Edit record" }).click();
  const input = page.getByLabel("When");
  await input.fill("2026-08-08T14:30");
  await expect(input).toHaveValue("2026-08-08T14:30");
  const expectedUtc = await page.evaluate(() => new Date("2026-08-08T14:30").toISOString());
  await expect.poll(() => page.evaluate(
    ({ prefix, key }) => JSON.parse(localStorage.getItem(prefix + key) ?? "null")?.When,
    { prefix: RECORD_PREFIX, key: `${GRAPH}|event-0` },
  )).toBe(expectedUtc);

  await page.reload();
  await page.getByRole("button", { name: "Edit record" }).click();
  await expect(page.getByLabel("When")).toHaveValue("2026-08-08T14:30");
});

test("URL, email, and long-text controls persist and render appropriately", async ({ page }) => {
  await seedSession(page);
  await seedNewFormat(page, contactFixture());
  await page.goto("/");

  await page.getByRole("button", { name: "Edit record" }).click();
  await expect(page.getByLabel("Website")).toHaveAttribute("type", "url");
  await expect(page.getByLabel("Email")).toHaveAttribute("type", "email");
  await expect(page.getByLabel("Notes")).toHaveJSProperty("tagName", "TEXTAREA");
  await page.getByLabel("Website").fill("https://example.com/profile");
  await page.getByLabel("Email").fill("reader@example.com");
  await page.getByLabel("Notes").fill("First line\nSecond line");

  await expect.poll(() => page.evaluate(
    ({ prefix, key }) => JSON.parse(localStorage.getItem(prefix + key) ?? "null"),
    { prefix: RECORD_PREFIX, key: `${GRAPH}|contact-0` },
  )).toMatchObject({
    Website: "https://example.com/profile",
    Email: "reader@example.com",
    Notes: "First line\nSecond line",
  });

  await page.reload();
  await expect(page.getByRole("link", { name: "https://example.com/profile" }))
    .toHaveAttribute("href", "https://example.com/profile");
  await expect(page.getByRole("link", { name: "reader@example.com" }))
    .toHaveAttribute("href", "mailto:reader@example.com");
  const notes = page.locator(".preserve-whitespace");
  await expect(notes).toHaveText("First line\nSecond line");
  await expect(notes).toHaveCSS("white-space", "pre-wrap");
});

test("a markdown field edits as monospace text and displays as a formatted block", async ({ page }) => {
  await seedSession(page);
  await seedNewFormat(page, noteFixture());
  await page.goto("/");

  await page.getByRole("button", { name: "Edit record" }).click();
  const body = page.getByLabel("Body");
  await expect(body).toHaveJSProperty("tagName", "TEXTAREA");
  await expect(body).toHaveCSS("font-family", /mono/i);

  await body.fill(
    "# Title\n\nSome **bold**, some *italic*, and `inline code`.\n\n"
      + "- one\n- two\n\n> a quote\n\n```\nconst x = 1;\n```\n\n"
      + "A [safe link](https://example.com/page).",
  );
  await page.getByRole("button", { name: "Done editing" }).click();

  const rendered = page.locator(".markdown-body");
  await expect(rendered.locator("h1")).toHaveText("Title");
  await expect(rendered.locator("strong")).toHaveText("bold");
  await expect(rendered.locator("em")).toHaveText("italic");
  await expect(rendered.locator("code").first()).toHaveText("inline code");
  await expect(rendered.locator("li")).toHaveCount(2);
  await expect(rendered.locator("blockquote")).toContainText("a quote");
  await expect(rendered.locator("pre code")).toHaveText("const x = 1;");
  const link = rendered.getByRole("link", { name: "safe link" });
  await expect(link).toHaveAttribute("href", "https://example.com/page");
  await expect(link).toHaveAttribute("target", "_blank");

  // Persists as plain markdown source, not pre-rendered HTML.
  await expect.poll(() => page.evaluate(
    ({ prefix, key }) => JSON.parse(localStorage.getItem(prefix + key) ?? "null")?.Body,
    { prefix: RECORD_PREFIX, key: `${GRAPH}|note-0` },
  )).toContain("# Title");
});

test("a markdown field never interprets raw HTML in its source, only escapes it", async ({ page }) => {
  await seedSession(page);
  await seedNewFormat(
    page,
    noteFixture(
      "Before <script>window.__pwned = true;</script> after, "
        + '<img src=x onerror="window.__pwned = true">, plain <b>not bold</b>.',
    ),
  );
  await page.goto("/");

  // Never executed: nothing in this test could have set this had the markup
  // actually run rather than been printed as text.
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned))
    .toBeUndefined();
  await expect(page.locator(".markdown-body script")).toHaveCount(0);
  await expect(page.locator(".markdown-body img")).toHaveCount(0);
  await expect(page.locator(".markdown-body b")).toHaveCount(0);
  await expect(page.getByText("<script>window.__pwned = true;</script>")).toBeVisible();
  await expect(page.getByText("<b>not bold</b>")).toBeVisible();
});

test("a markdown link degrades to visible text instead of an active link when it isn't safe", async ({ page }) => {
  await seedSession(page);
  await seedNewFormat(
    page,
    noteFixture(
      "[bad](javascript:alert(1)) and [relative](./notes.md) and [anchor](#section).",
    ),
  );
  await page.goto("/");

  const rendered = page.locator(".markdown-body");
  await expect(rendered.locator("a")).toHaveCount(0);
  await expect(rendered).toContainText("[bad](javascript:alert(1))");
  await expect(rendered).toContainText("[relative](./notes.md)");
  await expect(rendered).toContainText("[anchor](#section)");
});

test("markdown image syntax renders as a plain link, never an auto-loading <img>", async ({ page }) => {
  await seedSession(page);
  await seedNewFormat(
    page,
    noteFixture("![tracking pixel](https://example.com/pixel.png)"),
  );
  await page.goto("/");

  const rendered = page.locator(".markdown-body");
  await expect(rendered.locator("img")).toHaveCount(0);
  const link = rendered.getByRole("link", { name: "tracking pixel" });
  await expect(link).toHaveAttribute("href", "https://example.com/pixel.png");
});

test("a markdown field's editor cannot type past its length cap", async ({ page }) => {
  await seedSession(page);
  await seedNewFormat(page, noteFixture());
  await page.goto("/");

  await page.getByRole("button", { name: "Edit record" }).click();
  const body = page.getByLabel("Body");
  await expect(body).toHaveJSProperty("maxLength", 50_000);

  // Programmatic fill is fast and gets close to the cap; the cap itself is
  // then exercised with real keystrokes, which is what the browser's native
  // maxlength enforcement actually gates - a raw property assignment would
  // not prove anything about the attribute doing its job.
  await body.fill("x".repeat(49_995));
  await body.pressSequentially("1234567890");
  const finalValue = await body.inputValue();
  expect(finalValue).toHaveLength(50_000);
  expect(finalValue.endsWith("12345")).toBe(true);
});

test("a markdown field prints as rendered markup, not its raw source", async ({ page }) => {
  await seedSession(page);
  await page.addInitScript(() => {
    window.print = () => undefined;
  });
  await seedNewFormat(page, noteFixture("# Title\n\nSome **bold** text."));
  await page.goto("/");

  await page.getByRole("button", { name: "Print Notes" }).click();
  const sheet = page.locator(".print-sheet");
  const cell = sheet.locator("td .markdown-body");
  await expect(cell.locator("h1")).toHaveText("Title");
  await expect(cell.locator("strong")).toHaveText("bold");
  // Not the raw markdown source sitting in the cell as plain text.
  await expect(sheet.locator("td")).not.toContainText("# Title");
  await expect(sheet.locator("td")).not.toContainText("**bold**");
});

test("long-text and markdown fields span the full row width, unlike a short field beside them", async ({ page }) => {
  await seedSession(page);
  await seedNewFormat(page, mixedFieldsFixture());
  await page.goto("/");

  const grid = page.locator(".info-grid").first();
  const gridBox = await grid.boundingBox();
  const titleBox = await grid.locator(".field-group", { hasText: "Title" }).boundingBox();
  const notesBox = await grid.locator(".field-group-full-width", { hasText: "Notes" }).boundingBox();
  const bodyBox = await grid.locator(".field-group-full-width", { hasText: "Body" }).boundingBox();

  // A short field still shares the row with a sibling; long text and markdown
  // each claim (almost) the whole grid width regardless of what's beside them.
  expect(titleBox!.width).toBeLessThan(gridBox!.width * 0.9);
  expect(notesBox!.width).toBeGreaterThan(gridBox!.width * 0.9);
  expect(bodyBox!.width).toBeGreaterThan(gridBox!.width * 0.9);
});

test("unsafe URL schemes render as text rather than active links", async ({ page }) => {
  await seedSession(page);
  await seedNewFormat(
    page,
    contactFixture("javascript:alert(document.domain)", "reader@example.com", "Safe notes"),
  );
  await page.goto("/");

  await expect(page.getByText("javascript:alert(document.domain)", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "javascript:alert(document.domain)" })).toHaveCount(0);
});

test("the builder writes search and page size onto the block", async ({ page }) => {
  await seedSession(page);
  await seedNewFormat(
    page,
    booksFixture([
      { title: "Alpha", rating: 1 },
      { title: "Bravo", rating: 2 },
      { title: "Charlie", rating: 3 },
    ]),
  );
  await page.goto("/settings/tabs/did:ng:z:HomeTab/blocks");

  await page.getByLabel("Show a search box").check();
  await page.getByLabel("Records per page").fill("2");
  await page.waitForTimeout(200);

  await page.goto("/");
  await expect(page.getByLabel(SEARCH_LABEL)).toBeVisible();
  await expect(page.locator(".record-card")).toHaveCount(2);
  await expect(page.getByText("Page 1 of 2")).toBeVisible();

  // Clearing the page size returns the block to showing everything.
  await page.goto("/settings/tabs/did:ng:z:HomeTab/blocks");
  await page.getByLabel("Records per page").fill("");
  await page.waitForTimeout(200);
  await page.goto("/");
  await expect(page.locator(".record-card")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Next" })).toHaveCount(0);
});

test("exports the matching records as JSON, not just the visible page", async ({ page }) => {
  await seedSession(page);
  await seedNewFormat(page, booksFixture(
    [
      { title: "Dune", rating: 5 },
      { title: "Dusk", rating: 3 },
      { title: "Emma", rating: 4 },
    ],
    { searchEnabled: true, pageSize: 1 },
  ));
  await page.goto("/");

  await page.getByLabel(SEARCH_LABEL).fill("du");
  await expect(page.locator(".record-card")).toHaveCount(1);

  const download = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export Books as JSON" }).click(),
  ]).then(([event]) => event);
  expect(download.suggestedFilename()).toMatch(/^books-\d{4}-\d{2}-\d{2}\.json$/);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  // Both search matches, across both pages -- paging is a screen constraint,
  // not a selection -- and every stored field, not only the displayed ones.
  expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual([
    { "@label": "Dune", "@id": "book-0", Title: "Dune", Rating: 5 },
    { "@label": "Dusk", "@id": "book-1", Title: "Dusk", Rating: 3 },
  ]);
});

test("reference labels drive live display, sorting, and reader search", async ({ page }) => {
  await seedSession(page);
  await seedNewFormat(page, referencedBooksFixture());
  await page.goto("/");

  const cards = page.locator(".record-card");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("Second");
  await expect(cards.nth(0)).toContainText("Alpha");
  await expect(cards.nth(1)).toContainText("First");
  await expect(cards.nth(1)).toContainText("Zulu");

  await page.getByLabel("Search Referenced books").fill("alpha");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Second");
  await expect(cards.first()).not.toContainText("First");

  const fallbacks = await page.evaluate(async ({ graph }) => {
    const engine = await import("/src/utils/localNgEngine.ts");
    return [
      engine.lookupRecordLabel(graph, "did:ng:z:missing"),
      engine.lookupRecordLabel(graph, "numeric-record"),
    ];
  }, { graph: GRAPH });
  expect(fallbacks).toEqual(["did:ng:z:missing", "numeric-record"]);
});

test("reference exports and printouts include readable labels", async ({ page }) => {
  await seedSession(page);
  await page.addInitScript(() => {
    window.print = () => undefined;
  });
  await seedNewFormat(page, referencedBooksFixture());
  await page.goto("/");

  const download = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export Referenced books as JSON" }).click(),
  ]).then(([event]) => event);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual([
    {
      "@label": "Second",
      "@id": "book-second",
      Title: "Second",
      Author: { "@label": "Alpha", "@id": "author-z" },
    },
    {
      "@label": "First",
      "@id": "book-first",
      Title: "First",
      Author: { "@label": "Zulu", "@id": "author-a" },
    },
  ]);

  await page.getByRole("button", { name: "Print Referenced books" }).click();
  const sheet = page.locator(".print-sheet");
  await expect(sheet.locator("thead th")).toHaveText(["Title", "Author"]);
  await expect(sheet.locator("tbody tr").nth(0).locator("td")).toHaveText(["Second", "Alpha"]);
  await expect(sheet.locator("tbody tr").nth(1).locator("td")).toHaveText(["First", "Zulu"]);
});

test("printing shows only the block's data, without any of the app around it", async ({ page }) => {
  await seedSession(page);
  // Stub print so the sheet stays mounted: the real call blocks on the
  // dialog and then fires afterprint, which unmounts it.
  await page.addInitScript(() => {
    window.print = () => undefined;
  });
  await seedNewFormat(page, booksFixture(
    [
      { title: "Dune", rating: 5 },
      { title: "Emma", rating: 4 },
    ],
    { title: "Reading list", searchEnabled: true },
  ));
  await page.goto("/");

  await page.getByLabel(SEARCH_LABEL).fill("dune");
  await page.getByRole("button", { name: "Print Books" }).click();

  const sheet = page.locator(".print-sheet");
  await expect(sheet.locator("h1")).toHaveText("Reading list");
  await expect(sheet.locator(".print-meta")).toHaveText("1 record matching “dune”");
  await expect(sheet.locator("thead th")).toHaveText(["Title", "Rating"]);
  await expect(sheet.locator("tbody tr")).toHaveCount(1);
  await expect(sheet.locator("tbody td")).toHaveText(["Dune", "5"]);

  await page.emulateMedia({ media: "print" });
  await expect(sheet).toBeVisible();
  // The application itself, and with it every control, is off the page.
  await expect(page.locator(".app-shell")).toBeHidden();
  await expect(page.getByRole("button", { name: "Print Books" })).toBeHidden();
  await expect(sheet).toHaveCSS("color", "rgb(0, 0, 0)");
});
