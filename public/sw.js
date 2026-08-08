const CACHE_NAME = "local-graph-shell-v1";
const SYNC_PATH = "/sync";

function isSyncRequest(url) {
  return url.pathname === SYNC_PATH || url.pathname.startsWith(`${SYNC_PATH}/`);
}

async function cacheShell() {
  const cache = await caches.open(CACHE_NAME);
  const shellUrl = new URL("./", self.registration.scope);
  const shell = await fetch(shellUrl, { cache: "no-store" });
  if (!shell.ok) throw new Error(`Shell request failed with ${shell.status}`);

  const html = await shell.clone().text();
  const assets = [...html.matchAll(/(?:href|src)=["']([^"']+)["']/g)]
    .map((match) => new URL(match[1], shellUrl))
    .filter((url) => url.origin === shellUrl.origin && !isSyncRequest(url));
  assets.push(
    new URL("manifest.webmanifest", shellUrl),
    new URL("favicon.svg", shellUrl),
    new URL("icon-192.png", shellUrl),
    new URL("icon-512.png", shellUrl),
  );

  await cache.put(shellUrl, shell);
  await Promise.all([...new Set(assets.map(String))].map(async (url) => {
    const response = await fetch(url, { cache: "no-store" });
    if (response.ok) await cache.put(url, response);
  }));
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || isSyncRequest(url)) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(new URL("./", self.registration.scope), response.clone());
        }
        return response;
      } catch {
        return (await caches.match(new URL("./", self.registration.scope), { ignoreVary: true }))
          ?? Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    // Static servers commonly emit `Vary: Origin`; the worker's install-time
    // fetch and a later module request can therefore differ only by that
    // header even though they address the identical immutable asset.
    const cached = await caches.match(request, { ignoreVary: true });
    const refresh = fetch(request).then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    });
    if (cached) {
      event.waitUntil(refresh.catch(() => undefined));
      return cached;
    }
    return refresh;
  })());
});
