import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveTabRouteSegment,
  tabRouteSegment,
  tabTitleSlug,
} from "../../src/utils/tabRoutes.ts";

const tab = (id: string, title: string) => ({ "@id": id, title });

test("tab slugs normalize readable titles without becoming stored identity", () => {
  assert.equal(tabTitleSlug("  Crème brûlée & Notes!  "), "creme-brulee-notes");
  assert.equal(tabTitleSlug("研究 記録"), "研究-記録");
  assert.equal(tabTitleSlug("✨"), "");
});

test("the first ordered tab owns a slug while collisions fall back to ids", () => {
  const first = tab("did:ng:tab:first", "Project Notes");
  const second = tab("did:ng:tab:second", "Project--Notes");
  const symbols = tab("did:ng:tab:symbols", "✨");
  const tabs = [first, second, symbols];

  assert.equal(tabRouteSegment(first, tabs), "project-notes");
  assert.equal(tabRouteSegment(second, tabs), second["@id"]);
  assert.equal(tabRouteSegment(symbols, tabs), symbols["@id"]);
  assert.equal(resolveTabRouteSegment("project-notes", tabs), first);
  assert.equal(resolveTabRouteSegment(second["@id"], tabs), second);
  assert.equal(resolveTabRouteSegment("missing", tabs), undefined);
});

test("a raw id wins when another tab derives the same segment", () => {
  const rawOwner = tab("projects", "Other");
  const slugCandidate = tab("did:ng:tab:projects", "Projects");
  const tabs = [rawOwner, slugCandidate];

  assert.equal(tabRouteSegment(slugCandidate, tabs), slugCandidate["@id"]);
  assert.equal(resolveTabRouteSegment("projects", tabs), rawOwner);
});
