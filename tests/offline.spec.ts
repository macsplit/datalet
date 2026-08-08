import { expect, test } from "@playwright/test";

const STORE_KEY = "meta-ui-builder:ng-local-store";
const INDEX_KEY = `${STORE_KEY}:index`;
const RECORD_PREFIX = `${STORE_KEY}:record:`;
const SESSION_KEY = "meta-ui-builder:local-session";
const GRAPH = "did:ng:test-private-store";

test("the production shell cold-starts offline with local records", async ({ page, context }) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    browserErrors.push(`${request.url()}: ${request.failure()?.errorText ?? "request failed"}`);
  });
  const records = [
    { "@graph": GRAPH, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Home", order: 0 },
    { "@graph": GRAPH, "@id": "schema-books", "@type": "did:ng:z:SchemaDef", name: "Books" },
    { "@graph": GRAPH, "@id": "property-title", "@type": "did:ng:z:PropertyDef", schemaId: "schema-books", name: "Title", order: 0, dataType: "did:ng:z:text", cardinality: "did:ng:z:one", enumOptions: [] },
    { "@graph": GRAPH, "@id": "block-books", "@type": "did:ng:z:Block", blockType: "did:ng:z:data", order: 0, schemaId: "schema-books", parentTabId: "did:ng:z:HomeTab" },
    { "@graph": GRAPH, "@id": "widget-title", "@type": "did:ng:z:Widget", parentBlockId: "block-books", order: 0, widgetType: "did:ng:z:field", propertyName: "Title", label: "Title", fieldType: "did:ng:z:text" },
    { "@graph": GRAPH, "@id": "book-dune", "@type": "did:ng:z:user:schema-books", Title: "Dune" },
  ];
  await page.addInitScript(({ records, indexKey, prefix, sessionKey }) => {
    localStorage.clear();
    localStorage.setItem(sessionKey, JSON.stringify({
      session_id: "offline-test-session",
      private_store_id: "test-private-store",
      protected_store_id: "test-protected-store",
      public_store_id: "test-public-store",
    }));
    const ids = records.map((record) => `${record["@graph"]}|${record["@id"]}`);
    localStorage.setItem(indexKey, JSON.stringify(ids));
    records.forEach((record, index) => {
      localStorage.setItem(prefix + ids[index], JSON.stringify(record));
    });
  }, { records, indexKey: INDEX_KEY, prefix: RECORD_PREFIX, sessionKey: SESSION_KEY });

  await page.goto("/");
  await expect(page.getByText("Dune", { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
    });
  });
  const cachedPaths = await page.evaluate(async () => {
    const cache = await caches.open("local-graph-shell-v1");
    return (await cache.keys()).map((request) => new URL(request.url).pathname);
  });
  expect(cachedPaths).toContain("/");
  expect(cachedPaths.some((path) => path.startsWith("/assets/index-") && path.endsWith(".js"))).toBe(true);
  expect(cachedPaths.some((path) => path.startsWith("/assets/index-") && path.endsWith(".css"))).toBe(true);

  // `/sync/*` must always stay on the network path; a service worker replay of
  // an SSE stream or mutation would violate the sync protocol.
  await context.setOffline(true);
  const syncResult = await page.evaluate(() => fetch("/sync/health").then(
    () => "unexpected success",
    () => "network only",
  ));
  expect(syncResult).toBe("network only");
  browserErrors.length = 0;

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByText("Dune", { exact: true }),
    `Browser errors after offline reload: ${browserErrors.join(" | ")}`,
  ).toBeVisible();
});
