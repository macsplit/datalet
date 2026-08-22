import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, test } from "node:test";

const progress = (line: string) => process.stdout.write(`security: ${line}\n`);
import { createSyncServer } from "../src/httpServer.js";
import { redis } from "../src/redis/client.js";
import { deleteVault, snapshot } from "../src/vaultStore.js";
import { sanitizeLabel, BOUNDED_RECORD_TYPE_LABELS } from "../src/neo4j/labels.js";

/**
 * The weaknesses worth checking on a server anyone can reach: whether one
 * tenant's credential opens another's vault, whether a guessed or malformed
 * vault id can touch anything, whether caller text can reach a Cypher query,
 * and whether awkward encodings survive or slip past the accounting.
 *
 * Redis is not injectable in the SQL sense - ioredis sends length-prefixed
 * arguments, so a value cannot become a command - but vault ids are
 * interpolated into key names and deletion scans `vault:<id>:*`, so a glob in
 * an accepted id would be a real key-namespace attack. That is what the second
 * test is actually about.
 */

after(() => redis().disconnect());

async function withServer<T>(run: (base: string) => Promise<T>): Promise<T> {
  const server = createSyncServer("/tmp/localgraph-no-static-files");
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

async function reachable(t: { skip: (reason: string) => void }): Promise<boolean> {
  try {
    await redis().ping();
    return true;
  } catch (error) {
    if (process.env.REQUIRE_SYNC_INTEGRATION === "1") throw error;
    t.skip(`Redis unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const newVault = async (base: string) =>
  await (await fetch(`${base}/sync/vaults`, { method: "POST" })).json() as
    { vaultId: string; vaultToken: string };

function patchBody(graph: string, id: string, fields: Record<string, string>, counter: number) {
  const subject = `${graph}|${id}`;
  const path = `/${subject.replace(/~/g, "~0").replace(/\//g, "~1")}`;
  return {
    subject,
    body: {
      nodeId: "n",
      batchId: randomUUID(),
      hlc: `001700000000000-${String(counter).padStart(6, "0")}-n`,
      shape: "did:ng:z:Security",
      patches: [
        { op: "add", path, value: {} },
        { op: "add", path: `${path}/@graph`, value: graph },
        { op: "add", path: `${path}/@id`, value: id },
        ...Object.entries(fields).map(([key, value]) => ({ op: "add", path: `${path}/${key}`, value })),
      ],
    },
  };
}

test("a vault's data is unreachable without its own token", async (t) => {
  progress("checking cross-tenant token isolation...");
  if (!(await reachable(t))) return;
  await withServer(async (base) => {
    const a = await newVault(base);
    const b = await newVault(base);
    try {
      const url = `${base}/sync/snapshot?vault=${a.vaultId}`;
      assert.equal((await fetch(url)).status, 401, "no token");
      assert.equal((await fetch(url, { headers: auth("wrong") })).status, 401, "wrong token");
      // Broken access control: another tenant's valid credential must not work.
      assert.equal((await fetch(url, { headers: auth(b.vaultToken) })).status, 401, "another vault's token");
      assert.equal((await fetch(url, { headers: auth(a.vaultToken) })).status, 200, "its own token");
      assert.equal(
        (await fetch(`${base}/sync/vaults?vault=${a.vaultId}`,
          { method: "DELETE", headers: auth(b.vaultToken) })).status,
        401,
        "deleting must not be a looser gate than reading",
      );
    } finally {
      await deleteVault(a.vaultId).catch(() => undefined);
      await deleteVault(b.vaultId).catch(() => undefined);
    }
  });
});

test("a guessed or malformed vault id reveals nothing and touches nothing", async (t) => {
  progress("checking 8 hostile vault ids for key-namespace escape...");
  if (!(await reachable(t))) return;
  await withServer(async (base) => {
    const real = await newVault(base);
    try {
      const hostile = ["*", "..", "a:b", `${real.vaultId}*`, "*:meta", "vault:*", " ", "\u0000"];
      for (const candidate of hostile) {
        progress(`  trying vault id ${JSON.stringify(candidate)}`);
        const encoded = encodeURIComponent(candidate);
        const read = await fetch(`${base}/sync/snapshot?vault=${encoded}`, { headers: auth(real.vaultToken) });
        assert.equal(read.status, 404, `read should 404 for ${JSON.stringify(candidate)}, got ${read.status}`);
        const removed = await fetch(`${base}/sync/vaults?vault=${encoded}`,
          { method: "DELETE", headers: auth(real.vaultToken) });
        assert.equal(removed.status, 404, `delete should 404 for ${JSON.stringify(candidate)}`);
      }
      // Still there: no glob matched the real vault's keys away.
      assert.equal(
        (await fetch(`${base}/sync/snapshot?vault=${real.vaultId}`, { headers: auth(real.vaultToken) })).status,
        200,
      );
    } finally {
      await deleteVault(real.vaultId).catch(() => undefined);
    }
  });
});

test("a hostile record type cannot become a Cypher label", () => {
  progress("checking 9 hostile record types against sanitizeLabel...");
  // Cypher cannot parameterize a label, so this is the one place caller text
  // could reach a query. Anything unrecognised must collapse to Type_User.
  const attacks = [
    "did:ng:z:Tab` REMOVE r:Record //",
    "Tab`) DETACH DELETE r //",
    "did:ng:z:Tab\nMATCH (n) DETACH DELETE n",
    "../../etc/passwd",
    "Type_User`",
    "'; DROP DATABASE neo4j; --",
    " Tab",
    "\u{1D4E3}\u{1D4EA}\u{1D4EB}",
    "Tab\u0000",
  ];
  for (const attack of attacks) {
    progress(`  trying ${JSON.stringify(attack)}`);
    const label = sanitizeLabel(attack);
    assert.match(label, /^Type_[A-Za-z0-9_]+$/, `${JSON.stringify(attack)} produced ${label}`);
    assert.ok(
      BOUNDED_RECORD_TYPE_LABELS.has(label),
      `${JSON.stringify(attack)} escaped the bounded label set as ${label}`,
    );
  }
  assert.equal(sanitizeLabel("did:ng:z:Tab"), "Type_Tab", "the real mapping must still work");
  assert.equal(sanitizeLabel(undefined), "Type_User");
});

test("awkward text survives a round trip through Redis and Neo4j unchanged", async (t) => {
  progress("round-tripping 9 awkward strings through Redis + Neo4j...");
  if (!(await reachable(t))) return;
  await withServer(async (base) => {
    const vault = await newVault(base);
    const graph = `did:ng:${vault.vaultId}`;
    try {
      // Encoding and collation hazards, written as escapes so the source stays
      // ASCII: combining marks, a right-to-left override, zero-width joiner
      // and BOM, astral-plane emoji, dotted/dotless Turkish i, and characters
      // that look like this system's own delimiters.
      const values: Record<string, string> = {
        cjk: "\u65e5\u672c\u8a9e",
        emoji: "\u{1F469}\u{1F3FD}\u200D\u{1F680}\u{1F1EC}\u{1F1E7}",
        combining: "e\u0301\u0301 vs \u00e9",
        rtl: "abc\u202Edef\u202C",
        zeroWidth: "a\u200Bb\u200Dc\uFEFF",
        delimiters: "pipe|colon:tilde~slash/quote\"brace}",
        backticks: "it's `backticked` and \\escaped\\",
        turkish: "\u0130stanbul \u0131I",
        newlines: "line1\nline2\r\nline3\ttab",
      };
      const { subject, body } = patchBody(graph, "odd-text", values, 1);
      const response = await fetch(`${base}/sync/patches?vault=${vault.vaultId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth(vault.vaultToken) },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, await response.text());

      const state = await snapshot(vault.vaultId);
      const stored = state.records[subject] as Record<string, string> | undefined;
      assert.ok(stored, `record missing; keys were ${Object.keys(state.records).join(", ")}`);
      for (const [key, value] of Object.entries(values)) {
        progress(`  checking ${key}: stored=${JSON.stringify(stored[key])} expected=${JSON.stringify(value)}`);
        assert.equal(stored[key], value, `${key} did not survive the round trip`);
      }
      assert.equal(stored["@graph"], graph, "the key form the client requires must survive too");
    } finally {
      await deleteVault(vault.vaultId).catch(() => undefined);
    }
  });
});

test("the quota counts bytes, so multi-byte text cannot smuggle past it", async (t) => {
  progress("writing 20,000 4-byte emoji and checking the byte accounting...");
  if (!(await reachable(t))) return;
  await withServer(async (base) => {
    const vault = await newVault(base);
    const graph = `did:ng:${vault.vaultId}`;
    try {
      // Every one of these is 4 UTF-8 bytes but 2 UTF-16 code units. A quota
      // measuring string length would admit roughly twice what it intended.
      const wide = "\u{1F642}".repeat(20_000);
      const { body } = patchBody(graph, "wide", { wide }, 2);
      await fetch(`${base}/sync/patches?vault=${vault.vaultId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth(vault.vaultToken) },
        body: JSON.stringify(body),
      });
      const stored = Number(await redis().get(`vault:${vault.vaultId}:bytes`) ?? "0");
      assert.ok(
        stored > wide.length,
        `accounted ${stored} bytes for ${wide.length} UTF-16 units; the quota must count bytes`,
      );
    } finally {
      await deleteVault(vault.vaultId).catch(() => undefined);
    }
  });
});
