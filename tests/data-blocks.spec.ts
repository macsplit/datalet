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
