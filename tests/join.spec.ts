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

const REGISTRY_KEY = "meta-ui-builder:datalets";
const vaultB = {
  vaultId: "bbbbbbbb-0000-0000-0000-000000000000",
  vaultToken: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
};

/** A browser that has already synced once, so it's free to add another datalet. */
async function seedPaired(page: Page) {
  await page.addInitScript(() => {
    if (localStorage.getItem("join-seeded")) return;
    localStorage.clear();
    localStorage.setItem("join-seeded", "1");
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "join-session", private_store_id: "test-private-store",
    }));
    localStorage.setItem("meta-ui-builder:datalets", JSON.stringify({
      activeId: "a",
      entries: [{ id: "a", vault: {
        vaultId: "aaaaaaaa-0000-0000-0000-000000000000",
        vaultToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        nodeId: "na",
      } }],
    }));
  });
  await page.route("**/sync/snapshot?*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ seq: 0, records: {} }),
  }));
  await page.route("**/sync/patches?*", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ accepted: true, acceptedCount: 1, submittedCount: 1 }),
  }));
  await page.route("**/sync/stream-ticket?*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ ticket: "t" }),
  }));
  await page.route("**/sync/stream?*", (route) => route.abort());
}

/**
 * Something queues into the active vault's outbox on startup (e.g. a
 * settings sync), and canLeaveActiveDatalet correctly refuses to add or join
 * anything else while it is pending - switching now would discard it. Every
 * test against a paired fixture waits for it to drain first, matching what
 * clone-codes.spec.ts already established for this same fixture shape.
 */
async function waitForOutboxToDrain(page: Page, vaultId: string) {
  await expect.poll(() => page.evaluate((key) =>
    JSON.parse(localStorage.getItem(key) ?? "[]").length,
    `meta-ui-builder:sync-outbox:${vaultId}`,
  )).toBe(0);
}

test("a COPY invite link redeems, confirms, and joins without a second manual paste", async ({ page }) => {
  await seedPaired(page);
  await page.route("**/sync/invite-redeem", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { codeType?: string };
    if (body.codeType !== "COPY") {
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ reason: "not found" }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: "COPY-K3RM-9T7A-X" }) });
  });
  await page.route("**/sync/clone", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ vaultId: vaultB.vaultId, vaultToken: vaultB.vaultToken }),
  }));

  await page.goto("/join?token=11111111-1111-4111-8111-111111111111");
  await expect(page.getByRole("heading", { name: "Take a copy of a datalet" })).toBeVisible();
  await waitForOutboxToDrain(page, "aaaaaaaa-0000-0000-0000-000000000000");
  await page.getByRole("button", { name: "Take a copy" }).click();

  // Joined - not stuck showing a copy-to-clipboard step that needs a second
  // paste somewhere else.
  await expect.poll(() => page.evaluate(({ key }) =>
    JSON.parse(localStorage.getItem(key) ?? "{}").activeId, { key: REGISTRY_KEY }))
    .toBe(vaultB.vaultId);

  // And it must not have reloaded back onto /join, where the now-consumed
  // token would fail redemption a second time and show a false error.
  await expect(page).not.toHaveURL(/\/join/);
});

test("a copy's Home still populates when Neo4j hasn't caught up to the fresh clone yet", async ({ page }) => {
  // Reproduces a reported bug: a copy taken across browsers landed on an
  // empty Home. /sync/snapshot reads Neo4j, which the materializer feeds
  // asynchronously from the same accepted writes that bump `seq` in Redis
  // immediately - a brand new clone can report seq > 0 before its records
  // are visible there yet. The first two snapshot calls below simulate that
  // gap (accepted, but not yet materialized); only the third has the record.
  await seedPaired(page);
  await page.route("**/sync/invite-redeem", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { codeType?: string };
    if (body.codeType !== "COPY") {
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ reason: "not found" }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: "COPY-K3RM-9T7A-X" }) });
  });
  await page.route("**/sync/clone", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ vaultId: vaultB.vaultId, vaultToken: vaultB.vaultToken }),
  }));

  let snapshotCalls = 0;
  await page.route(`**/sync/snapshot?vault=${vaultB.vaultId}*`, (route) => {
    snapshotCalls += 1;
    const records = snapshotCalls >= 3
      ? {
          [`did:ng:${vaultB.vaultId}|subject-1`]: {
            "@id": "subject-1",
            "@graph": `did:ng:${vaultB.vaultId}`,
            "@type": "did:ng:z:Tab",
            title: "Copied tab",
          },
        }
      : {};
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ seq: 3, records }) });
  });

  await page.goto("/join?token=11111111-1111-4111-8111-111111111111");
  await expect(page.getByRole("heading", { name: "Take a copy of a datalet" })).toBeVisible();
  await waitForOutboxToDrain(page, "aaaaaaaa-0000-0000-0000-000000000000");
  await page.getByRole("button", { name: "Take a copy" }).click();

  await expect.poll(() => page.evaluate(({ key }) =>
    JSON.parse(localStorage.getItem(key) ?? "{}").activeId, { key: REGISTRY_KEY }))
    .toBe(vaultB.vaultId);
  // Proves the retry actually ran, not that it happened to succeed by luck.
  expect(snapshotCalls).toBeGreaterThanOrEqual(3);

  await page.goto("/");
  await expect(page.getByText("Copied tab")).toBeVisible();
});

test("the retry budget survives a realistic materializer catch-up delay, not just a couple of quick tries", async ({ page }) => {
  // Measured directly against a freshly deployed production instance: a
  // source vault and its clone, created seconds apart, took ~6s for the
  // clone's records to appear - close to a full VAULT_DISCOVERY_INTERVAL_MS
  // (3s) plus replay time. The original budget (5 tries, ~5s total) was
  // short of that by a real margin. This mock only succeeds on the 6th
  // call, which the original budget could not reach in time but the
  // current one comfortably does.
  await seedPaired(page);
  await page.route("**/sync/invite-redeem", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ code: "COPY-K3RM-9T7A-X" }),
  }));
  await page.route("**/sync/clone", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ vaultId: vaultB.vaultId, vaultToken: vaultB.vaultToken }),
  }));

  // Only satisfied on the 8th call - unreachable with a 5-entry backoff
  // array (1 initial fetch + 5 retries = 6 calls, maximum), reachable with
  // the current one (1 + 8 = 9 calls, maximum). Not asserting the call
  // count directly: what actually matters, and what a too-short budget
  // silently gets wrong, is whether the record makes it onto Home at all -
  // adoption "succeeds" either way, just with nothing in it if the budget
  // gave up first.
  let snapshotCalls = 0;
  await page.route(`**/sync/snapshot?vault=${vaultB.vaultId}*`, (route) => {
    snapshotCalls += 1;
    const records = snapshotCalls >= 8
      ? {
          [`did:ng:${vaultB.vaultId}|subject-1`]: {
            "@id": "subject-1",
            "@graph": `did:ng:${vaultB.vaultId}`,
            "@type": "did:ng:z:Tab",
            order: 0,
            title: "Late tab",
          },
        }
      : {};
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ seq: 1, records }) });
  });

  await page.goto("/join?token=66666666-6666-4666-8666-666666666666");
  await waitForOutboxToDrain(page, "aaaaaaaa-0000-0000-0000-000000000000");
  await page.getByRole("button", { name: "Take a copy" }).click();

  await expect.poll(() => page.evaluate(({ key }) =>
    JSON.parse(localStorage.getItem(key) ?? "{}").activeId, { key: REGISTRY_KEY }), { timeout: 25_000 })
    .toBe(vaultB.vaultId);

  await page.goto("/");
  await expect(page.getByText("Late tab")).toBeVisible();
});

test("a genuinely empty vault (seq 0) is trusted on the first snapshot, no retry", async ({ page }) => {
  await seedPaired(page);
  await page.route("**/sync/invite-redeem", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ code: "COPY-K3RM-9T7A-X" }),
  }));
  await page.route("**/sync/clone", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ vaultId: vaultB.vaultId, vaultToken: vaultB.vaultToken }),
  }));

  let snapshotCalls = 0;
  await page.route(`**/sync/snapshot?vault=${vaultB.vaultId}*`, (route) => {
    snapshotCalls += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ seq: 0, records: {} }) });
  });

  await page.goto("/join?token=22222222-2222-4222-8222-222222222222");
  await waitForOutboxToDrain(page, "aaaaaaaa-0000-0000-0000-000000000000");
  await page.getByRole("button", { name: "Take a copy" }).click();

  await expect.poll(() => page.evaluate(({ key }) =>
    JSON.parse(localStorage.getItem(key) ?? "{}").activeId, { key: REGISTRY_KEY }))
    .toBe(vaultB.vaultId);
  expect(snapshotCalls).toBe(1);
});

test("a PAIR invite link is named correctly and joins the same vault", async ({ page }) => {
  await seedPaired(page);
  await page.route("**/sync/invite-redeem", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}") as { codeType?: string };
    if (body.codeType !== "PAIR") {
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ reason: "not found" }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: "PAIR-K3RM-9T7A-X" }) });
  });
  await page.route("**/sync/pair-redeem", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ vaultId: vaultB.vaultId, vaultToken: vaultB.vaultToken }),
  }));

  await page.goto("/join?token=33333333-3333-4333-8333-333333333333");
  await expect(page.getByRole("heading", { name: "Join a synced vault" })).toBeVisible();
  await waitForOutboxToDrain(page, "aaaaaaaa-0000-0000-0000-000000000000");
  await page.getByRole("button", { name: "Join", exact: true }).click();

  await expect.poll(() => page.evaluate(({ key }) =>
    JSON.parse(localStorage.getItem(key) ?? "{}").activeId, { key: REGISTRY_KEY }))
    .toBe(vaultB.vaultId);
});

test("an expired or already-used invite link says so, plainly", async ({ page }) => {
  await seedPaired(page);
  await page.route("**/sync/invite-redeem", (route) => route.fulfill({
    status: 404, contentType: "application/json", body: JSON.stringify({ reason: "not found" }),
  }));

  await page.goto("/join?token=99999999-9999-4999-8999-999999999999");
  await expect(page.getByText(/expired or was already used/)).toBeVisible();
  // Nothing was joined.
  await expect.poll(() => page.evaluate(({ key }) =>
    JSON.parse(localStorage.getItem(key) ?? "{}").activeId, { key: REGISTRY_KEY }))
    .toBe("a");
});

test("a link with no token at all is refused rather than hanging", async ({ page }) => {
  await seedPaired(page);
  await page.goto("/join");
  await expect(page.getByText(/missing its invite token/)).toBeVisible();
});

test("a completely fresh browser - never visited before - gets a real error, not a silent no-op", async ({ page }) => {
  // No addInitScript at all: no local-session, no datalet registry, nothing.
  // The guard (canLeaveActiveDatalet) is checked twice: once at render, to
  // decide whether the button is enabled, and again inside
  // adoptVaultAsDatalet, after ensureLocalDatalet() has just created this
  // browser's own "this device" registry entry for the first time. On a
  // truly fresh browser the first check sees no registry at all (nothing to
  // protect, enabled) and the second sees the entry that was just created
  // (vault-less, refused) - correctly, not a bug (see adoptVaultAsDatalet's
  // own comment). What matters here is that the refusal actually reaches
  // the screen: this exact sequence used to reach it after the URL had
  // already been silently swapped to /settings/datalets, which unmounts
  // this page and swallows the error - see the beforeReload fix in
  // dataletSwitch.ts. Reported as: accepted a copy link, nothing changed,
  // dropped on Settings with no explanation.
  await page.route("**/sync/invite-redeem", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ code: "COPY-K3RM-9T7A-X" }),
  }));
  await page.route("**/sync/clone", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ vaultId: vaultB.vaultId, vaultToken: vaultB.vaultToken }),
  }));

  await page.goto("/join?token=55555555-5555-4555-8555-555555555555");
  await expect(page.getByRole("heading", { name: "Take a copy of a datalet" })).toBeVisible();
  // Enabled at render - there is genuinely nothing to protect yet.
  await expect(page.getByRole("button", { name: "Take a copy" })).toBeEnabled();
  await page.getByRole("button", { name: "Take a copy" }).click();

  // The refusal has to actually reach the screen, on the still-mounted page.
  await expect(page.getByText(/only in this browser, so there is no copy anywhere else/)).toBeVisible();
  await expect(page).toHaveURL(/\/join/);

  // And nothing was silently half-adopted: the registry holds only the
  // vault-less local placeholder ensureLocalDatalet created, never vaultB.
  const registry = await page.evaluate(({ key }) =>
    JSON.parse(localStorage.getItem(key) ?? "{}") as { activeId?: string; entries?: { id: string }[] },
    { key: REGISTRY_KEY });
  expect(registry.entries?.map((entry) => entry.id)).not.toContain(vaultB.vaultId);
});

test("the same data-loss guard as the manual field applies here: an unpaired datalet blocks joining another", async ({ page }) => {
  // The exact scenario the fuzzer's first-ever finding was about: adding a
  // second datalet before this one has ever synced would strand its records.
  // A link must not be a side door around that guard.
  await page.addInitScript(() => {
    if (localStorage.getItem("join-seeded")) return;
    localStorage.clear();
    localStorage.setItem("join-seeded", "1");
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "join-session", private_store_id: "test-private-store",
    }));
    // No vault on the active entry: unpaired.
    localStorage.setItem("meta-ui-builder:datalets", JSON.stringify({
      activeId: "a", entries: [{ id: "a" }],
    }));
  });
  await page.route("**/sync/invite-redeem", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ code: "COPY-K3RM-9T7A-X" }),
  }));

  await page.goto("/join?token=44444444-4444-4444-8444-444444444444");
  await expect(page.getByText(/only in this browser, so there is no copy anywhere else/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Take a copy" })).toBeDisabled();
});
