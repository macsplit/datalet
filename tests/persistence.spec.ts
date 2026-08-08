import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const STORE_KEY = "meta-ui-builder:ng-local-store";
const INDEX_KEY = `${STORE_KEY}:index`;
const RECORD_PREFIX = `${STORE_KEY}:record:`;
const SESSION_KEY = "meta-ui-builder:local-session";
const PRIVATE_STORE_ID = "test-private-store";
const GRAPH = `did:ng:${PRIVATE_STORE_ID}`;

async function seedSession(page: Page, setup?: () => void) {
  await page.addInitScript(
    ({ sessionKey, privateStoreId, setupSource }) => {
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
      if (setupSource) (0, eval)(`(${setupSource})()`);
    },
    { sessionKey: SESSION_KEY, privateStoreId: PRIVATE_STORE_ID, setupSource: setup?.toString() },
  );
}

async function persistedStore(page: Page) {
  return page.evaluate(
    ({ indexKey, recordPrefix }) => {
      const ids = JSON.parse(localStorage.getItem(indexKey) ?? "[]") as string[];
      return Object.fromEntries(ids.map((id) => [id, localStorage.getItem(recordPrefix + id)]));
    },
    { indexKey: INDEX_KEY, recordPrefix: RECORD_PREFIX },
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

test("migrates the legacy blob without losing record bytes", async ({ page }) => {
  const subject = "did:ng:z:meta:tab:migrated";
  const key = `${GRAPH}|${subject}`;
  const record = {
    "@graph": GRAPH,
    "@id": subject,
    "@type": "did:ng:z:Tab",
    title: "Migrated tab",
    order: 1,
  };
  await seedSession(page, () => {
    const graph = "did:ng:test-private-store";
    const subject = "did:ng:z:meta:tab:migrated";
    const id = `${graph}|${subject}`;
    const value = {
      "@graph": graph,
      "@id": subject,
      "@type": "did:ng:z:Tab",
      title: "Migrated tab",
      order: 1,
    };
    localStorage.setItem("meta-ui-builder:ng-local-store", JSON.stringify({ [id]: value }));
  });

  await page.goto("/");
  await expect(page.getByRole("link", { name: "Migrated tab" })).toBeVisible();
  await expect.poll(() => page.evaluate((storageKey) => localStorage.getItem(storageKey), STORE_KEY)).toBeNull();
  expect(await page.evaluate((indexKey) => JSON.parse(localStorage.getItem(indexKey) ?? "[]"), INDEX_KEY)).toContain(key);
  expect(await page.evaluate((recordKey) => localStorage.getItem(recordKey), RECORD_PREFIX + key)).toBe(
    JSON.stringify(record),
  );
});

test("rejects oversized data without modifying it", async ({ page }) => {
  await seedSession(page, () => {
    const indexKey = "meta-ui-builder:ng-local-store:index";
    const prefix = "meta-ui-builder:ng-local-store:record:";
    const id = "did:ng:test-private-store|did:ng:z:oversized";
    const raw = JSON.stringify({
      "@graph": "did:ng:test-private-store",
      "@id": "did:ng:z:oversized",
      "@type": "did:ng:z:Oversized",
      value: "x".repeat(4_010_000),
    });
    localStorage.setItem(indexKey, JSON.stringify([id]));
    localStorage.setItem(prefix + id, raw);
  });

  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Local data safety circuit opened");
  const before = await page.evaluate(
    ({ indexKey, prefix }) => ({
      index: localStorage.getItem(indexKey),
      record: localStorage.getItem(prefix + "did:ng:test-private-store|did:ng:z:oversized"),
    }),
    { indexKey: INDEX_KEY, prefix: RECORD_PREFIX },
  );
  await page.waitForTimeout(300);
  const after = await page.evaluate(
    ({ indexKey, prefix }) => ({
      index: localStorage.getItem(indexKey),
      record: localStorage.getItem(prefix + "did:ng:test-private-store|did:ng:z:oversized"),
    }),
    { indexKey: INDEX_KEY, prefix: RECORD_PREFIX },
  );
  expect(after).toEqual(before);
});

test("retries an interrupted migration without letting bootstrap overwrite the legacy blob", async ({ page }) => {
  await seedSession(page, () => {
    const graph = "did:ng:test-private-store";
    const subject = "did:ng:z:meta:tab:interrupted";
    const id = `${graph}|${subject}`;
    localStorage.setItem(
      "meta-ui-builder:ng-local-store",
      JSON.stringify({
        [id]: {
          "@graph": graph,
          "@id": subject,
          "@type": "did:ng:z:Tab",
          title: "Recovered migration",
          order: 1,
        },
      }),
    );
  });
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (
        key.includes(":ng-local-store:record:") &&
        sessionStorage.getItem("migration-failed-once") !== "yes"
      ) {
        sessionStorage.setItem("migration-failed-once", "yes");
        throw new DOMException("Synthetic quota interruption", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  });

  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Local storage migration was paused");
  expect(await page.evaluate((key) => localStorage.getItem(key), STORE_KEY)).not.toBeNull();
  expect(await page.evaluate((key) => localStorage.getItem(key), INDEX_KEY)).toBeNull();
  await page.waitForTimeout(300);
  expect(await page.evaluate((key) => localStorage.getItem(key), INDEX_KEY)).toBeNull();

  await page.reload();
  await expect(page.getByRole("link", { name: "Recovered migration" })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), STORE_KEY)).toBeNull();
});

test("skips one corrupted record while preserving valid records", async ({ page }) => {
  await seedSession(page, () => {
    const graph = "did:ng:test-private-store";
    const validId = `${graph}|did:ng:z:meta:tab:valid`;
    const corruptId = `${graph}|did:ng:z:meta:tab:corrupt`;
    localStorage.setItem("meta-ui-builder:ng-local-store:index", JSON.stringify([validId, corruptId]));
    localStorage.setItem(
      `meta-ui-builder:ng-local-store:record:${validId}`,
      JSON.stringify({
        "@graph": graph,
        "@id": "did:ng:z:meta:tab:valid",
        "@type": "did:ng:z:Tab",
        title: "Valid survivor",
        order: 1,
      }),
    );
    localStorage.setItem(`meta-ui-builder:ng-local-store:record:${corruptId}`, "{not-json");
  });

  await page.goto("/");
  await expect(page.getByRole("link", { name: "Valid survivor" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("One saved record could not be loaded");
  await expect
    .poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]"), INDEX_KEY))
    .not.toContain(`${GRAPH}|did:ng:z:meta:tab:corrupt`);
});

test("writes only the edited record and reconstructs mixed mutations after reload", async ({ page }) => {
  await seedSession(page);
  await page.addInitScript(() => {
    const writes: string[] = [];
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith("meta-ui-builder:ng-local-store")) writes.push(key);
      return original.call(this, key, value);
    };
    Object.defineProperty(window, "__persistenceWrites", { value: writes });
  });

  await page.goto("/settings/tabs");
  await page.getByRole("button", { name: "+ New tab" }).click();
  const input = page.getByLabel("Tab name").last();
  await expect(input).toHaveValue("New tab 1");
  await page.waitForTimeout(200);
  await page.evaluate(() => ((window as unknown as { __persistenceWrites: string[] }).__persistenceWrites.length = 0));
  await input.fill("Reload proof");
  await input.blur();
  await page.waitForTimeout(200);

  const editWrites = await page.evaluate(
    () => (window as unknown as { __persistenceWrites: string[] }).__persistenceWrites,
  );
  expect(editWrites).toHaveLength(1);
  expect(editWrites[0]).toContain(":record:");
  expect(editWrites[0]).not.toBe(INDEX_KEY);

  const beforeReload = await persistedStore(page);
  await page.reload();
  await expect(page.getByLabel("Tab name").last()).toHaveValue("Reload proof");
  await page.waitForTimeout(200);
  expect(await persistedStore(page)).toEqual(beforeReload);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete Reload proof" }).click();
  await page.waitForTimeout(200);
  await page.reload();
  await expect(page.locator('input[value="Reload proof"]')).toHaveCount(0);
});

test("keeps one deterministic Settings record across reloads and tabs", async ({ context, page }) => {
  await seedSession(page);
  await page.goto("/settings");
  await expect(page.getByLabel("Shown in the nav bar and browser tab")).toHaveValue("Local Knowledge Graph");
  const second = await context.newPage();
  await second.goto("/settings");
  await expect(second.getByLabel("Shown in the nav bar and browser tab")).toBeVisible();
  await page.reload();
  await page.waitForTimeout(200);

  const settings = await page.evaluate(
    ({ indexKey, prefix }) => {
      const ids = JSON.parse(localStorage.getItem(indexKey) ?? "[]") as string[];
      return ids
        .map((id) => JSON.parse(localStorage.getItem(prefix + id) ?? "null"))
        .filter((record) => record?.["@type"] === "did:ng:z:Settings");
    },
    { indexKey: INDEX_KEY, prefix: RECORD_PREFIX },
  );
  expect(settings).toHaveLength(1);
  expect(settings[0]["@id"]).toBe("did:ng:z:SettingsSingleton");
});

test("settings edits survive reload and propagate across tabs", async ({ context, page }) => {
  await seedSession(page);
  await page.goto("/settings");
  const second = await context.newPage();
  await second.addInitScript(() => {
    const messages: unknown[] = [];
    const auditChannel = new BroadcastChannel("meta-ui-builder:ng-local-engine");
    auditChannel.addEventListener("message", (event) => messages.push(event.data));
    Object.defineProperty(window, "__crossTabMessages", { value: messages });
  });
  await second.goto("/settings");
  const title = page.getByLabel("Shown in the nav bar and browser tab");
  const secondTitle = second.getByLabel("Shown in the nav bar and browser tab");
  await title.fill("Shared local graph");
  await page.getByLabel("Currency used for amounts").selectOption("did:ng:z:GBP");
  await expect
    .poll(() =>
      second.evaluate(
        () => (window as unknown as { __crossTabMessages: unknown[] }).__crossTabMessages.length,
      ),
    )
    .toBeGreaterThan(0);
  await expect(secondTitle).toHaveValue("Shared local graph");
  await expect(second.getByLabel("Currency used for amounts")).toHaveValue("did:ng:z:GBP");
  await page.waitForTimeout(200);
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "null")?.appTitle,
        `${RECORD_PREFIX}${GRAPH}|did:ng:z:SettingsSingleton`,
      ),
    )
    .toBe("Shared local graph");
  expect(
    await page.evaluate(async (graph) => {
      const engine = await import("/src/utils/localNgEngine.ts");
      return engine
        .exportGraphBackup(graph)
        .records.find(({ record }) => record["@id"] === "did:ng:z:SettingsSingleton")?.record
        .appTitle;
    }, GRAPH),
  ).toBe("Shared local graph");
  await page.reload();
  await expect(page.getByLabel("Shown in the nav bar and browser tab")).toHaveValue("Shared local graph");
  await expect(page.getByLabel("Currency used for amounts")).toHaveValue("did:ng:z:GBP");
});

test("records localStorage overhead at realistic batch sizes", async ({ page }) => {
  await seedSession(page);
  await page.goto("/");
  const result = await page.evaluate(() => {
    const samples = [100, 1_000, 5_000];
    return samples.map((count) => {
      const value = JSON.stringify({ value: "x".repeat(120) });
      const startedSmall = performance.now();
      for (let i = 0; i < count; i += 1) localStorage.setItem(`benchmark:record:${i}`, value);
      const smallMs = performance.now() - startedSmall;
      const startedBlob = performance.now();
      localStorage.setItem("benchmark:blob", JSON.stringify(Array.from({ length: count }, () => value)));
      const blobMs = performance.now() - startedBlob;
      for (let i = 0; i < count; i += 1) localStorage.removeItem(`benchmark:record:${i}`);
      localStorage.removeItem("benchmark:blob");
      return { count, smallMs, blobMs };
    });
  });
  expect(result).toHaveLength(3);
  for (const sample of result) {
    expect(sample.smallMs).toBeGreaterThanOrEqual(0);
    expect(sample.blobMs).toBeGreaterThanOrEqual(0);
  }
  test.info().annotations.push({ type: "benchmark", description: JSON.stringify(result) });
});

test("exports the active graph and restores it after deletion", async ({ page }) => {
  await seedSession(page);
  await page.goto("/settings/tabs");
  await page.getByRole("button", { name: "+ New tab" }).click();
  const input = page.getByLabel("Tab name").last();
  await input.fill("Backup survivor");
  await input.blur();
  await page.waitForTimeout(200);

  await page.goto("/settings");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export backup" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const backup = JSON.parse(await readFile(path!, "utf8"));
  expect(backup.format).toBe("localgraph-backup");
  expect(backup.records.some((entry: { record: { title?: string } }) => entry.record.title === "Backup survivor")).toBe(true);

  await page.goto("/settings/tabs");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete Backup survivor" }).click();
  await page.waitForTimeout(200);
  await page.goto("/settings");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByLabel("Choose backup file").setInputFiles(path!);
  await expect(page.getByRole("link", { name: "Backup survivor" })).toBeVisible();
});

test("data blocks apply configured filtering and numeric sorting", async ({ page }) => {
  await seedSession(page);
  const schemaId = "did:ng:z:meta:schema:books";
  const records = [
    { "@graph": GRAPH, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Home", order: 0 },
    { "@graph": GRAPH, "@id": schemaId, "@type": "did:ng:z:SchemaDef", name: "Books" },
    { "@graph": GRAPH, "@id": "property-title", "@type": "did:ng:z:PropertyDef", schemaId, name: "Title", order: 0, dataType: "did:ng:z:text", cardinality: "did:ng:z:one", enumOptions: [] },
    { "@graph": GRAPH, "@id": "property-rating", "@type": "did:ng:z:PropertyDef", schemaId, name: "Rating", order: 1, dataType: "did:ng:z:number", cardinality: "did:ng:z:one", enumOptions: [] },
    { "@graph": GRAPH, "@id": "block-books", "@type": "did:ng:z:Block", blockType: "did:ng:z:data", order: 0, schemaId, parentTabId: "did:ng:z:HomeTab", filterPropertyName: "Title", filterValue: "a", sortPropertyName: "Rating", sortDirection: "did:ng:z:descending" },
    { "@graph": GRAPH, "@id": "widget-title", "@type": "did:ng:z:Widget", parentBlockId: "block-books", order: 0, widgetType: "did:ng:z:field", propertyName: "Title", label: "Title", fieldType: "did:ng:z:text" },
    { "@graph": GRAPH, "@id": "widget-rating", "@type": "did:ng:z:Widget", parentBlockId: "block-books", order: 1, widgetType: "did:ng:z:field", propertyName: "Rating", label: "Rating", fieldType: "did:ng:z:number" },
    { "@graph": GRAPH, "@id": "book-alpha", "@type": `did:ng:z:user:${schemaId}`, Title: "Alpha", Rating: 2 },
    { "@graph": GRAPH, "@id": "book-beta", "@type": `did:ng:z:user:${schemaId}`, Title: "Beta", Rating: 10 },
    { "@graph": GRAPH, "@id": "book-echo", "@type": `did:ng:z:user:${schemaId}`, Title: "Echo", Rating: 5 },
  ];
  await seedNewFormat(page, records);
  await page.goto("/");
  const cards = page.locator(".record-card");
  await expect(cards).toHaveCount(2);
  expect(await cards.nth(0).textContent()).toContain("Beta");
  expect(await cards.nth(1).textContent()).toContain("Alpha");
  await expect(page.getByText("Echo", { exact: true })).toHaveCount(0);
});

test("reference fields resolve labels and persist a changed target", async ({ page }) => {
  await seedSession(page);
  const peopleSchema = "did:ng:z:meta:schema:people";
  const tasksSchema = "did:ng:z:meta:schema:tasks";
  const records = [
    { "@graph": GRAPH, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Home", order: 0 },
    { "@graph": GRAPH, "@id": peopleSchema, "@type": "did:ng:z:SchemaDef", name: "People" },
    { "@graph": GRAPH, "@id": tasksSchema, "@type": "did:ng:z:SchemaDef", name: "Tasks" },
    { "@graph": GRAPH, "@id": "property-name", "@type": "did:ng:z:PropertyDef", schemaId: peopleSchema, name: "Name", order: 0, dataType: "did:ng:z:text", cardinality: "did:ng:z:one", enumOptions: [] },
    { "@graph": GRAPH, "@id": "property-owner", "@type": "did:ng:z:PropertyDef", schemaId: tasksSchema, name: "Owner", order: 0, dataType: "did:ng:z:reference", cardinality: "did:ng:z:one", enumOptions: [], referenceSchemaId: peopleSchema },
    { "@graph": GRAPH, "@id": "block-tasks", "@type": "did:ng:z:Block", blockType: "did:ng:z:data", order: 0, schemaId: tasksSchema, parentTabId: "did:ng:z:HomeTab" },
    { "@graph": GRAPH, "@id": "widget-owner", "@type": "did:ng:z:Widget", parentBlockId: "block-tasks", order: 0, widgetType: "did:ng:z:field", propertyName: "Owner", label: "Owner", fieldType: "did:ng:z:reference" },
    { "@graph": GRAPH, "@id": "widget-actions", "@type": "did:ng:z:Widget", parentBlockId: "block-tasks", order: 1, widgetType: "did:ng:z:editDeleteActions" },
    { "@graph": GRAPH, "@id": "person-alice", "@type": `did:ng:z:user:${peopleSchema}`, Name: "Alice" },
    { "@graph": GRAPH, "@id": "person-bob", "@type": `did:ng:z:user:${peopleSchema}`, Name: "Bob" },
    { "@graph": GRAPH, "@id": "task-one", "@type": `did:ng:z:user:${tasksSchema}`, Owner: "person-alice" },
  ];
  await seedNewFormat(page, records);
  await page.goto("/");
  await expect(page.getByText("Alice", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit record" }).click();
  await page.getByLabel("Owner").selectOption("person-bob");
  await page.getByRole("button", { name: "Done editing" }).click();
  await expect(page.getByText("Bob", { exact: true })).toBeVisible();
  await page.waitForTimeout(200);
  await page.reload();
  await expect(page.getByText("Bob", { exact: true })).toBeVisible();
});
