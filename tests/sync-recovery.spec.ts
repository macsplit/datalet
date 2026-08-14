import { expect, test } from "@playwright/test";

const STORE_KEY = "meta-ui-builder:ng-local-store";
const INDEX_KEY = `${STORE_KEY}:index`;
const RECORD_PREFIX = `${STORE_KEY}:record:`;
const SESSION_KEY = "meta-ui-builder:local-session";
const CONFIG_KEY = "meta-ui-builder:sync-vault";
const OUTBOX_KEY = "meta-ui-builder:sync-outbox:test-vault";
const GRAPH = "did:ng:test-vault";

function fixture(title: string) {
  const schemaId = "schema-books";
  const blockId = "block-books";
  return [
    { "@graph": GRAPH, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Home", order: 0 },
    { "@graph": GRAPH, "@id": schemaId, "@type": "did:ng:z:SchemaDef", name: "Books" },
    { "@graph": GRAPH, "@id": "property-title", "@type": "did:ng:z:PropertyDef", schemaId, name: "Title", order: 0, dataType: "did:ng:z:text", cardinality: "did:ng:z:one", enumOptions: [] },
    { "@graph": GRAPH, "@id": blockId, "@type": "did:ng:z:Block", blockType: "did:ng:z:data", order: 0, schemaId, parentTabId: "did:ng:z:HomeTab" },
    { "@graph": GRAPH, "@id": "widget-title", "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 0, widgetType: "did:ng:z:field", propertyName: "Title", label: "Title", fieldType: "did:ng:z:text" },
    { "@graph": GRAPH, "@id": "widget-actions", "@type": "did:ng:z:Widget", parentBlockId: blockId, order: 1, widgetType: "did:ng:z:editDeleteActions" },
    { "@graph": GRAPH, "@id": "book-0", "@type": `did:ng:z:user:${schemaId}`, Title: title },
  ];
}

test("stale-cursor recovery converges in place and preserves the outbox", async ({ page }) => {
  const initial = fixture("Local old title");
  const snapshotRecords = Object.fromEntries(
    fixture("Server title").map((record) => [`${record["@graph"]}|${record["@id"]}`, record]),
  );
  snapshotRecords[`${GRAPH}|book-1`] = {
    "@graph": GRAPH,
    "@id": "book-1",
    "@type": "did:ng:z:user:schema-books",
    Title: "Server-added book",
  };
  await page.addInitScript(({ initial, indexKey, prefix, sessionKey, configKey, outboxKey }) => {
    localStorage.clear();
    localStorage.setItem(sessionKey, JSON.stringify({
      session_id: "snapshot-test-session",
      private_store_id: "test-vault",
      protected_store_id: "test-protected-store",
      public_store_id: "test-public-store",
    }));
    const ids = initial.map((record) => `${record["@graph"]}|${record["@id"]}`);
    localStorage.setItem(indexKey, JSON.stringify(ids));
    initial.forEach((record, index) => localStorage.setItem(prefix + ids[index], JSON.stringify(record)));
    localStorage.setItem(configKey, JSON.stringify({
      vaultId: "test-vault",
      vaultToken: "test-token",
      nodeId: "test-node",
    }));
    localStorage.setItem(outboxKey, JSON.stringify([{
      batchId: "pending-before-resync",
      hlc: "000000000001000-000000-test-node",
      shape: "test-shape",
      patches: [{ op: "add", path: "/did:ng:test-vault|book-0/Title", value: "pending" }],
    }]));
  }, { initial, indexKey: INDEX_KEY, prefix: RECORD_PREFIX, sessionKey: SESSION_KEY, configKey: CONFIG_KEY, outboxKey: OUTBOX_KEY });

  let releaseFirstStream!: () => void;
  const firstStreamGate = new Promise<void>((resolve) => { releaseFirstStream = resolve; });
  let streamCalls = 0;
  let snapshotServed = false;
  let outboxFlushed = false;
  await page.route("**/sync/stream-ticket?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ticket: "test-ticket" }),
  }));
  await page.route("**/sync/stream?*", async (route) => {
    streamCalls += 1;
    if (streamCalls === 1) {
      await firstStreamGate;
      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: "event: resync\ndata: {\"reason\":\"gap exceeds retained log\"}\n\n",
      });
      return;
    }
    await new Promise(() => undefined);
  });
  await page.route("**/sync/snapshot?*", (route) => {
    snapshotServed = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ seq: 42, records: snapshotRecords }),
    });
  });
  await page.route("**/sync/patches?*", (route) => {
    if (!snapshotServed) return route.abort();
    outboxFlushed = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ accepted: true, acceptedCount: 1, submittedCount: 1 }),
    });
  });

  let mainNavigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) mainNavigations += 1;
  });
  await page.goto("/");
  const navigationsAfterLoad = mainNavigations;
  await expect(page.getByText("Local old title", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit record" }).click();
  await expect(page.getByLabel("Title")).toHaveValue("Local old title");

  releaseFirstStream();
  await expect(page.getByLabel("Title")).toHaveValue("Server title");
  await expect(page.getByText("Server-added book", { exact: true })).toBeVisible();
  expect(mainNavigations).toBe(navigationsAfterLoad);
  await expect.poll(() => outboxFlushed).toBe(true);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), OUTBOX_KEY))
    .toBe("[]");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("meta-ui-builder:sync-cursor:test-vault")))
    .toBe("42");
});
