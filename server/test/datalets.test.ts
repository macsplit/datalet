import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The registry is browser code, so give it the one API it uses. Node has no
 * localStorage, and the alternative - a Playwright round trip - would test the
 * app rather than the migration rules themselves.
 */
function withStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
  };
  return data;
}

const LEGACY = "meta-ui-builder:sync-vault";
const REGISTRY = "meta-ui-builder:datalets";
const vault = { vaultId: "v1", vaultToken: "t1", nodeId: "n1" };

async function loadModule() {
  // Fresh module per test: the registry reads localStorage at call time, but
  // importing after the stub is installed keeps that explicit.
  return import(`../../src/utils/datalets.ts?${Math.random()}`);
}

test("a browser paired before the registry existed comes back paired", async () => {
  withStorage({ [LEGACY]: JSON.stringify(vault) });
  const { activeDatalet, dataletGraph } = await loadModule();
  const active = activeDatalet();
  assert(active, "expected the legacy pairing to migrate");
  assert.deepEqual(active.vault, vault);
  assert.equal(dataletGraph(active, "did:ng:local"), "did:ng:v1");
});

test("migration produces one datalet, not the vault plus the abandoned local graph", async () => {
  // Surfacing the previous local graph would change behaviour silently and
  // create an unpaired entry beside a paired one, which the design forbids.
  withStorage({ [LEGACY]: JSON.stringify(vault) });
  const { readDatalets } = await loadModule();
  assert.equal(readDatalets()?.entries.length, 1);
});

test("an unpaired datalet resolves to this device's local graph", async () => {
  const store = withStorage();
  const { ensureLocalDatalet, activeDatalet, dataletGraph } = await loadModule();
  ensureLocalDatalet();
  assert.equal(dataletGraph(activeDatalet()!, "did:ng:local"), "did:ng:local");
  assert.ok(store.has(REGISTRY));
});

test("ensureLocalDatalet is idempotent", async () => {
  withStorage();
  const { ensureLocalDatalet } = await loadModule();
  const first = ensureLocalDatalet();
  assert.equal(ensureLocalDatalet().id, first.id);
});

test("pairing and unpairing keep the datalet's identity", async () => {
  // The id outlives the graph, which is the whole reason it is not the graph.
  withStorage();
  const { ensureLocalDatalet, pairActiveDatalet, unpairActiveDatalet, activeDatalet } =
    await loadModule();
  const id = ensureLocalDatalet().id;

  pairActiveDatalet(vault);
  assert.equal(activeDatalet()?.id, id);
  assert.deepEqual(activeDatalet()?.vault, vault);

  unpairActiveDatalet();
  assert.equal(activeDatalet()?.id, id);
  assert.equal(activeDatalet()?.vault, undefined);
});

test("a corrupt registry is ignored rather than trusted", async () => {
  withStorage({ [REGISTRY]: '{"activeId":5,"entries":"nope"}' });
  const { readDatalets } = await loadModule();
  assert.equal(readDatalets(), undefined);
});
