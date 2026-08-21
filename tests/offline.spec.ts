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

test("the built app runs without violating its own Content Security Policy", async ({ page }) => {
  // The main suite runs against `vite dev`, which ships no CSP - the policy is
  // injected at build time only, because plugin-react's refresh preamble is an
  // inline module script. So this suite, which serves the built app, is the
  // only place the shipped policy is exercised at all.
  await page.addInitScript(() => {
    const violations: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = violations;
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.violatedDirective} blocked ${event.blockedURI}`);
    });
  });

  const readViolations = () =>
    page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);

  await page.goto("/");
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  expect(await readViolations()).toEqual([]);

  // Settings renders the QR pairing view, whose image is a data: URI - the
  // reason img-src carries `data:` rather than bare 'self'.
  await page.goto("/settings");
  await expect(page.getByText("Remote sync")).toBeVisible();
  expect(await readViolations()).toEqual([]);
});

test("the policy blocks a font from another origin", async ({ page }) => {
  // font-src 'self' is the directive this policy exists for: a theme value
  // stored in the graph must never be able to cause an outbound request.
  // Asserting the browser enforces it keeps that a guarantee rather than a
  // convention (theme-in-graph-plan.md, T1).
  await page.goto("/");
  const outcome = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(event.violatedDirective);
    });
    const style = document.createElement("style");
    style.textContent =
      "@font-face { font-family: Hostile; src: url('https://example.invalid/f.woff2'); }";
    document.head.append(style);
    const probe = document.createElement("span");
    probe.style.fontFamily = "Hostile";
    probe.textContent = "probe";
    document.body.append(probe);
    await document.fonts.ready.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
    return violations;
  });
  expect(outcome).toContain("font-src");
});

test("the built app is installable, with a stable identity", async ({ page }) => {
  await page.goto("/");

  // Chromium is the authority on whether this parses, so ask it rather than
  // inferring from the file. An empty `errors` is what makes the install
  // prompt possible at all.
  const cdp = await page.context().newCDPSession(page);
  const manifest = await cdp.send("Page.getAppManifest" as Parameters<typeof cdp.send>[0]) as {
    errors?: Array<{ message: string }>;
    data?: string;
  };
  expect(manifest.errors ?? []).toEqual([]);
  expect(manifest.data).toBeTruthy();

  const parsed = JSON.parse(manifest.data ?? "{}") as Record<string, unknown> & {
    icons?: Array<{ sizes?: string }>;
  };

  // `id` is what keeps an installed app the same app if start_url ever moves.
  // Changing it after release orphans every existing install with no migration
  // path, so it is pinned here rather than left to drift.
  expect(parsed.id).toBe("/");
  expect(parsed.start_url).toBe("/");
  expect(parsed.scope).toBe("/");
  expect(parsed.display).toBe("standalone");
  expect(parsed.name).toBeTruthy();

  const sizes = (parsed.icons ?? []).map((icon) => icon.sizes);
  expect(sizes).toContain("192x192");
  expect(sizes).toContain("512x512");
});
