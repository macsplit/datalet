import { expect, test } from "@playwright/test";

const GRAPH = "did:ng:test-vault";
const OUTBOX_KEY = "meta-ui-builder:sync-outbox:test-vault";

test("acknowledging an in-flight batch preserves a newer queued edit", async ({ page }) => {
  const records = [
    { "@graph": GRAPH, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Home", order: 0 },
    { "@graph": GRAPH, "@id": "did:ng:z:SettingsSingleton", "@type": "did:ng:z:Settings", appTitle: "Datalet" },
    { "@graph": GRAPH, "@id": "schema-books", "@type": "did:ng:z:SchemaDef", name: "Books" },
    { "@graph": GRAPH, "@id": "property-title", "@type": "did:ng:z:PropertyDef", schemaId: "schema-books", name: "Title", order: 0, dataType: "did:ng:z:text", cardinality: "did:ng:z:one" },
    { "@graph": GRAPH, "@id": "block-books", "@type": "did:ng:z:Block", blockType: "did:ng:z:data", order: 0, schemaId: "schema-books", parentTabId: "did:ng:z:HomeTab" },
    { "@graph": GRAPH, "@id": "widget-title", "@type": "did:ng:z:Widget", parentBlockId: "block-books", order: 0, widgetType: "did:ng:z:field", propertyName: "Title", label: "Title", fieldType: "did:ng:z:text" },
    { "@graph": GRAPH, "@id": "widget-actions", "@type": "did:ng:z:Widget", parentBlockId: "block-books", order: 1, widgetType: "did:ng:z:editDeleteActions" },
    { "@graph": GRAPH, "@id": "book-0", "@type": "did:ng:z:user:schema-books", Title: "Original title" },
  ];
  await page.addInitScript(({ graph, records, outboxKey }) => {
    localStorage.clear();
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "outbox-race-session",
      private_store_id: "test-vault",
      protected_store_id: "test-protected-store",
      public_store_id: "test-public-store",
    }));
    const keys = records.map((record) => `${graph}|${record["@id"]}`);
    localStorage.setItem("meta-ui-builder:ng-local-store:index", JSON.stringify(keys));
    records.forEach((record, index) => {
      localStorage.setItem(`meta-ui-builder:ng-local-store:record:${keys[index]}`, JSON.stringify(record));
    });
    localStorage.setItem("meta-ui-builder:sync-vault", JSON.stringify({
      vaultId: "test-vault",
      vaultToken: "test-token",
      nodeId: "test-node",
    }));
    localStorage.setItem(outboxKey, JSON.stringify([{
      batchId: "already-in-flight",
      hlc: "000000000001000-000000-test-node",
      shape: "did:ng:z:Settings",
      patches: [{ op: "replace", path: "/placeholder", value: "first" }],
    }]));
  }, { graph: GRAPH, records, outboxKey: OUTBOX_KEY });

  await page.route("**/sync/stream-ticket?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ticket: "test-ticket" }),
  }));
  await page.route("**/sync/stream?*", (route) => route.abort());

  let releaseFirst!: () => void;
  const firstResponseGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const submittedBodies: unknown[] = [];
  await page.route("**/sync/patches?*", async (route) => {
    const body = route.request().postDataJSON();
    submittedBodies.push(body);
    if (submittedBodies.length === 1) {
      markFirstStarted();
      await firstResponseGate;
    }
    const patchCount = Array.isArray(body.patches) ? body.patches.length : 0;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ accepted: true, acceptedCount: patchCount, submittedCount: patchCount }),
    });
  });

  await page.goto("/");
  await firstStarted;
  await page.getByRole("button", { name: "Edit record" }).click();
  await page.getByLabel("Title").fill("Queued while first request waits");
  await expect.poll(() => page.evaluate((key) =>
    JSON.parse(localStorage.getItem(key) ?? "[]").length, OUTBOX_KEY)).toBeGreaterThan(1);

  releaseFirst();
  await expect.poll(() => submittedBodies.some((body) =>
    JSON.stringify(body).includes("Queued while first request waits"))).toBe(true);
  await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), OUTBOX_KEY)).toBe("[]");
});
