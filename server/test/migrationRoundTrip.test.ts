import assert from "node:assert/strict";
import test from "node:test";
import { applyPatchesToStore, type Patch, type Store } from "../src/patchApply.js";

/**
 * The invariant that was missed: whatever the browser uploads must come back
 * as a snapshot the browser will accept.
 *
 * Carrying an unpaired datalet into a new vault uploaded its records as
 * patches keyed by bare `@id` with no `@graph`. The server stored exactly
 * that, so every later snapshot of that vault failed the client's
 * `validGraphSnapshot` - which requires each key to be `graph|id` and each
 * record's `@graph` to match - and switching to the datalet reported records
 * that failed local validation. Nothing on either side was individually wrong;
 * the two ends simply disagreed, which is what a round trip catches and a
 * unit test of either half does not.
 */

const GRAPH = "did:ng:11111111-2222-3333-4444-555555555555";

/** The client's rule, restated here so the server suite can assert against it. */
function validGraphSnapshot(graph: string, records: Store): boolean {
  return Object.entries(records).every(([key, record]) =>
    typeof record["@id"] === "string" &&
    record["@graph"] === graph &&
    key === `${graph}|${record["@id"]}`);
}

/** Mirrors src/utils/localNgEngine.ts's snapshotPatches. */
function snapshotPatches(key: string, record: Record<string, unknown>): Patch[] {
  const encode = (segment: string) => segment.replace(/~/g, "~0").replace(/\//g, "~1");
  const root = `/${encode(key)}`;
  const patches: Patch[] = [
    { op: "add", path: root, value: {} },
    { op: "add", path: `${root}/@graph`, value: record["@graph"] },
    { op: "add", path: `${root}/@id`, value: record["@id"] },
  ];
  for (const [property, value] of Object.entries(record)) {
    if (property === "@graph" || property === "@id") continue;
    const path = `${root}/${encode(property)}`;
    patches.push(Array.isArray(value)
      ? { op: "add", path, value, type: "set", valType: "set" }
      : { op: "add", path, value });
  }
  return patches;
}

test("records uploaded on migration come back as a snapshot the client accepts", () => {
  const records: Store = {
    [`${GRAPH}|did:ng:z:SettingsSingleton`]: {
      "@id": "did:ng:z:SettingsSingleton", "@graph": GRAPH, appTitle: "My work",
    },
    [`${GRAPH}|did:ng:z:HomeTab`]: {
      "@id": "did:ng:z:HomeTab", "@graph": GRAPH, title: "Reading", order: 0,
    },
    [`${GRAPH}|schema-1`]: {
      "@id": "schema-1", "@graph": GRAPH, name: "Books", enumOptions: ["a", "b"],
    },
  };

  const patches = Object.entries(records).flatMap(([key, record]) => snapshotPatches(key, record));
  const server: Store = {};
  applyPatchesToStore(server, patches);

  assert.ok(
    validGraphSnapshot(GRAPH, server),
    `a snapshot of these records would be rejected by the client: ${JSON.stringify(server)}`,
  );
  assert.deepEqual(Object.keys(server).sort(), Object.keys(records).sort());
  assert.equal((server[`${GRAPH}|did:ng:z:SettingsSingleton`] as { appTitle?: string }).appTitle, "My work");
  assert.deepEqual((server[`${GRAPH}|schema-1`] as { enumOptions?: string[] }).enumOptions, ["a", "b"]);
});

test("keying subjects by bare id is rejected, which is the bug this pins", () => {
  // The encoding the first migration used.
  const patches: Patch[] = [
    { op: "add", path: "/did:ng:z:HomeTab" },
    { op: "add", path: "/did:ng:z:HomeTab/title", value: "Reading" },
  ];
  const server: Store = {};
  applyPatchesToStore(server, patches);
  assert.equal(validGraphSnapshot(GRAPH, server), false);
});
