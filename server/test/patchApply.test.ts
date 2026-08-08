import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPatchesToStore,
  decodePathSegment,
  patchTarget,
  validatePatchBatch,
  type Store,
} from "../src/patchApply.js";

test("validates patch batches and decodes JSON pointer paths", () => {
  assert.deepEqual(validatePatchBatch([{ op: "add", path: "/subject/title", value: "ok" }]), {
    valid: true,
    patches: [{ op: "add", path: "/subject/title", value: "ok" }],
  });
  assert.equal(validatePatchBatch({}).valid, false);
  assert.equal(validatePatchBatch([{ op: "replace", path: "/subject" }]).valid, false);
  assert.equal(validatePatchBatch(Array.from({ length: 5_001 }, () => ({ op: "add", path: "/x" }))).valid, false);
  assert.equal(decodePathSegment("a~1b~0c"), "a/b~c");
  assert.deepEqual(patchTarget({ op: "add", path: "/a~1b/title" }), {
    subjectId: "a/b",
    propKey: "title",
  });
});

test("applies scalar, set, and record-removal patches deterministically", () => {
  const store: Store = {};
  applyPatchesToStore(store, [
    { op: "add", path: "/subject" },
    { op: "add", path: "/subject/@id", value: "record-id" },
    { op: "add", path: "/subject/@graph", value: "graph-id" },
    { op: "add", path: "/subject/title", value: "first" },
    { op: "add", path: "/subject/tags", value: ["one", "two"], type: "set" },
    { op: "add", path: "/subject/tags", value: "two", type: "set" },
    { op: "remove", path: "/subject/tags", value: "one", type: "set" },
    { op: "add", path: "/subject/title", value: "second" },
  ]);
  assert.deepEqual(store.subject, {
    "@id": "record-id",
    "@graph": "graph-id",
    title: "second",
    tags: ["two"],
  });
  applyPatchesToStore(store, [{ op: "remove", path: "/subject" }]);
  assert.deepEqual(store, {});
});
