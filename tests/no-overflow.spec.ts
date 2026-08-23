// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { expect, test, type Page } from "@playwright/test";

/**
 * No element on a Settings page may be wider than its own container.
 *
 * `.layout-row` overflowing by a few pixels has independently recurred
 * across this codebase's history - each time as a thin overlay scrollbar
 * that fades in and out on hover, which reads as a rendering glitch rather
 * than as "content is too wide," so it kept being noticed late and fixed at
 * one call site at a time (see the comment above `.layout-row` in
 * global.css for the CSS-level fix). This test is the other half: it does
 * not care which class or which future markup causes an overflow, only
 * that it does not exist. A row that grows a fifth button, a new panel that
 * copies an old bad pattern, a name too long for its column - any of them
 * fails here before anyone has to notice a flashing scrollbar to find it.
 *
 * Seeded with the shapes most likely to overflow a fixed-basis flex row:
 * several datalets (mixed with and without vaults, one archived) and
 * several copy codes, so the widest real rows - CloneCodes' four-button row
 * among them - are actually exercised rather than an empty placeholder state.
 */

const REGISTRY_KEY = "meta-ui-builder:datalets";

async function seedBusySettings(page: Page) {
  await page.addInitScript(() => {
    if (localStorage.getItem("overflow-seeded")) return;
    localStorage.clear();
    localStorage.setItem("overflow-seeded", "1");
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "overflow-session", private_store_id: "test-private-store",
    }));
    const vaultA = {
      vaultId: "aaaaaaaa-0000-0000-0000-000000000000",
      vaultToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      nodeId: "na",
    };
    localStorage.setItem("meta-ui-builder:datalets", JSON.stringify({
      activeId: "a",
      entries: [
        { id: "a", vault: vaultA, title: "A conference notes and reading list datalet" },
        { id: "b", title: "This device (never synced)" },
        { id: "c", vault: {
          vaultId: "cccccccc-0000-0000-0000-000000000000",
          vaultToken: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
          nodeId: "nc",
        }, archivedAt: Date.now(), title: "An archived datalet with a long name" },
      ],
    }));
    const graph = `did:ng:${vaultA.vaultId}`;
    const key = `${graph}|did:ng:z:HomeTab`;
    localStorage.setItem(`meta-ui-builder:ng-local-store:record:${key}`, JSON.stringify({
      "@graph": graph, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Home", order: 0,
    }));
    localStorage.setItem("meta-ui-builder:ng-local-store:index", JSON.stringify([key]));
  });
  await page.route("**/sync/snapshot?*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ seq: 1, records: {} }),
  }));
  await page.route("**/sync/patches?*", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ accepted: true, acceptedCount: 1, submittedCount: 1 }),
  }));
  await page.route("**/sync/stream-ticket?*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ ticket: "t" }),
  }));
  await page.route("**/sync/stream?*", (route) => route.abort());
  // Two codes: the row this bug most recently reappeared on gets a body
  // (input + Copy + Copy as Link + Revoke), rather than the empty state.
  await page.route("**/sync/clone-codes*", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({
      codes: [
        { code: "COPY-A1B2C3D4-E5F6G7H8-9", createdAt: Date.now() },
        { code: "COPY-J1K2L3M4-N5P6Q7R8-9", createdAt: Date.now() - 1000 },
      ],
    }),
  }));
}

/** Every element wider than the document, none - not "mostly," none. */
async function assertNoHorizontalOverflow(page: Page, where: string) {
  const overflowing = await page.evaluate(() => {
    const tolerance = 1; // sub-pixel layout rounding, not a real overflow
    const found: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      if (el.scrollWidth > el.clientWidth + tolerance) {
        const label = el.id ? `#${el.id}` : el.className ? `.${String(el.className).split(" ")[0]}` : el.tagName;
        found.push(`${label} (scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth})`);
      }
    }
    return found;
  });
  expect(overflowing, `horizontal overflow on ${where}: ${overflowing.join(", ")}`).toEqual([]);
}

const SETTINGS_ROUTES = [
  "/settings",
  "/settings/theme",
  "/settings/schemas",
  "/settings/datalets",
  "/settings/tabs",
  "/settings/about",
];

// Widths that actually see traffic on this app: a typical laptop panel width,
// and the mobile breakpoint global.css itself defines - the two ends of the
// range a fixed 360px flex-basis is most likely to misjudge.
const VIEWPORTS = [
  { name: "laptop", width: 1000, height: 900 },
  { name: "mobile breakpoint", width: 600, height: 900 },
];

for (const viewport of VIEWPORTS) {
  test.describe(`no horizontal overflow at ${viewport.name} width (${viewport.width}px)`, () => {
    for (const route of SETTINGS_ROUTES) {
      test(route, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await seedBusySettings(page);
        await page.goto(route);
        await expect(page.locator(".panel, .page").first()).toBeVisible();
        await assertNoHorizontalOverflow(page, `${route} at ${viewport.width}px`);
      });
    }
  });
}

test("the datalet switcher's archived section, expanded, still doesn't overflow", async ({ page }) => {
  // The row that most recently overflowed had four buttons revealed only
  // after interaction (Copy as Link is easy to add without anyone re-testing
  // the archived, expanded, or otherwise-not-default states of a panel).
  await page.setViewportSize({ width: 1000, height: 900 });
  await seedBusySettings(page);
  await page.goto("/settings/datalets");
  const summary = page.locator("summary", { hasText: /Archived/ });
  if (await summary.count() > 0) await summary.first().click();
  await assertNoHorizontalOverflow(page, "/settings/datalets with archived section expanded");
});

test.skip("regression: layout-row without flex-wrap overflows a four-button row", async ({ page }) => {
  // Not run - a permanent record of what this suite is guarding against and
  // how to prove it still would. To actually exercise this failure again,
  // temporarily remove `flex-wrap: wrap` from `.layout-row` in global.css:
  // this test (and every route test above) starts failing immediately, and
  // that combination is precisely what shipped in CloneCodes.tsx before the
  // wrap fix.
  await page.setViewportSize({ width: 700, height: 900 });
  await seedBusySettings(page);
  await page.goto("/settings/datalets");
  await assertNoHorizontalOverflow(page, "regression probe");
});
