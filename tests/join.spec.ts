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

test("a late failure gets a real error, not a silent no-op", async ({ page }) => {
  // A local-session is seeded (but no datalet registry) so this exercises
  // the manual "Take a copy" click specifically - a completely fresh browser
  // with no prior session now skips straight past this screen (see the
  // first-time-COPY tests below), which would leave nothing here to click.
  // The failure this test forces is a late one, deep inside adopt() (a
  // /sync/snapshot error - a quota check or a guard refusal would do the
  // same), to prove the actual thing that was reported: this exact sequence
  // used to reach its failure after the URL had already been silently
  // swapped to /settings/datalets, which unmounts this page and swallows
  // whatever error follows - see the beforeReload fix in dataletSwitch.ts.
  // Reported as: accepted a copy link, nothing changed, dropped on Settings
  // with no explanation.
  await page.addInitScript(() => {
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "join-session", private_store_id: "test-private-store",
    }));
  });
  await page.route("**/sync/invite-redeem", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ code: "COPY-K3RM-9T7A-X" }),
  }));
  await page.route("**/sync/clone", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ vaultId: vaultB.vaultId, vaultToken: vaultB.vaultToken }),
  }));
  await page.route(`**/sync/snapshot?vault=${vaultB.vaultId}*`, (route) => route.fulfill({
    status: 500, contentType: "application/json", body: JSON.stringify({ reason: "down" }),
  }));

  await page.goto("/join?token=55555555-5555-4555-8555-555555555555");
  await expect(page.getByRole("heading", { name: "Take a copy of a datalet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Take a copy" })).toBeEnabled();
  await page.getByRole("button", { name: "Take a copy" }).click();

  // The failure has to actually reach the screen, on the still-mounted page.
  await expect(page.getByText(/snapshot request failed/)).toBeVisible();
  await expect(page).toHaveURL(/\/join/);

  // And the failed vault was never switched into, whatever else the
  // registry ended up holding - addDatalet() writes a retriable entry
  // before adopt() ever reaches the failing fetch, which is fine (nothing
  // was evicted or overwritten to get there); becoming the active datalet
  // despite the failure would not be.
  const registry = await page.evaluate(({ key }) =>
    JSON.parse(localStorage.getItem(key) ?? "{}") as { activeId?: string },
    { key: REGISTRY_KEY });
  expect(registry.activeId).not.toBe(vaultB.vaultId);
});

test("the same data-loss guard as the manual field applies here: an unpaired datalet WITH REAL RECORDS blocks joining another", async ({ page }) => {
  // The exact scenario the fuzzer's first-ever finding was about: adding a
  // second datalet before this one has ever synced would strand its records.
  // A link must not be a side door around that guard. The seeded record's id
  // is deliberately NOT did:ng:z:HomeTab/SettingsSingleton with their exact
  // default content - those two are exactly what the app writes into any
  // fresh graph on its own (graphHasOnlyKnownBootstrapRecords), so using
  // them here would test nothing: this has to be content only a person
  // could have put there, or the guard has nothing real to refuse over.
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
    const graph = "did:ng:test-private-store";
    const key = `${graph}|did:ng:z:meta:tab:user-notes`;
    localStorage.setItem(`meta-ui-builder:ng-local-store:record:${key}`, JSON.stringify({
      "@graph": graph, "@id": "did:ng:z:meta:tab:user-notes", "@type": "did:ng:z:Tab", title: "Notes", order: 1,
    }));
    localStorage.setItem("meta-ui-builder:ng-local-store:index", JSON.stringify([key]));
  });
  await page.route("**/sync/invite-redeem", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ code: "COPY-K3RM-9T7A-X" }),
  }));

  await page.goto("/join?token=44444444-4444-4444-8444-444444444444");
  await expect(page.getByText(/only in this browser, so there is no copy anywhere else/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Take a copy" })).toBeDisabled();
});

test("a genuinely empty local placeholder does not block joining - there is nothing there to lose", async ({ page }) => {
  // Reported live: a private window's first attempt at a copy link
  // correctly showed the confirm screen (nothing existed yet to protect),
  // but ensureLocalDatalet() creates a vault-less "this device" placeholder
  // the moment adoption is attempted at all - and from then on, EVERY
  // subsequent attempt in that same session/profile found that placeholder
  // already sitting in the registry and refused unconditionally, forever,
  // over a graph that had never held a single record. This is exactly that
  // second attempt: the placeholder already exists (as it would after a
  // first attempt, successful or not), but nothing was ever written to it.
  await page.addInitScript(() => {
    if (localStorage.getItem("join-seeded")) return;
    localStorage.clear();
    localStorage.setItem("join-seeded", "1");
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "join-session", private_store_id: "test-private-store",
    }));
    localStorage.setItem("meta-ui-builder:datalets", JSON.stringify({
      activeId: "a", entries: [{ id: "a" }],
    }));
    // Deliberately no ng-local-store records at all: the placeholder exists,
    // its graph is empty.
  });
  await page.route("**/sync/invite-redeem", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ code: "COPY-K3RM-9T7A-X" }),
  }));
  await page.route("**/sync/clone", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ vaultId: vaultB.vaultId, vaultToken: vaultB.vaultToken }),
  }));
  await page.route(`**/sync/snapshot?vault=${vaultB.vaultId}*`, (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ seq: 0, records: {} }),
  }));

  await page.goto("/join?token=77777777-7777-4777-8777-777777777777");
  await expect(page.getByRole("heading", { name: "Take a copy of a datalet" })).toBeVisible();
  await expect(page.getByText(/only in this browser, so there is no copy anywhere else/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Take a copy" })).toBeEnabled();
  await page.getByRole("button", { name: "Take a copy" }).click();

  await expect.poll(() => page.evaluate(({ key }) =>
    JSON.parse(localStorage.getItem(key) ?? "{}").activeId, { key: REGISTRY_KEY }))
    .toBe(vaultB.vaultId);
});

test("a first-time COPY link proceeds straight to the clone, with no confirmation click needed", async ({ page }) => {
  // No addInitScript at all: a completely fresh browser, nothing in
  // localStorage before this load. Someone receiving their first Datalet
  // link has no context for a yes/no dialog and no established datalet to
  // protect, so this should never need a click at all.
  await page.route("**/sync/invite-redeem", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ code: "COPY-K3RM-9T7A-X" }),
  }));
  await page.route("**/sync/clone", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ vaultId: vaultB.vaultId, vaultToken: vaultB.vaultToken }),
  }));
  await page.route(`**/sync/snapshot?vault=${vaultB.vaultId}*`, (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ seq: 0, records: {} }),
  }));

  await page.goto("/join?token=88888888-8888-4888-8888-888888888888");
  await expect.poll(() => page.evaluate(({ key }) =>
    JSON.parse(localStorage.getItem(key) ?? "{}").activeId, { key: REGISTRY_KEY }))
    .toBe(vaultB.vaultId);
  await expect(page).not.toHaveURL(/\/join/);
});

test("a first-time COPY link still surfaces a late failure without anyone having clicked anything", async ({ page }) => {
  // Same fresh browser as above, but the clone succeeds and the settle
  // fails - proving auto-confirm reaches the same real-error handling as a
  // manual click, rather than an unattended failure going nowhere.
  await page.route("**/sync/invite-redeem", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ code: "COPY-K3RM-9T7A-X" }),
  }));
  await page.route("**/sync/clone", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ vaultId: vaultB.vaultId, vaultToken: vaultB.vaultToken }),
  }));
  await page.route(`**/sync/snapshot?vault=${vaultB.vaultId}*`, (route) => route.fulfill({
    status: 500, contentType: "application/json", body: JSON.stringify({ reason: "down" }),
  }));

  await page.goto("/join?token=91919191-9191-4191-8191-919191919191");
  await expect(page.getByText(/snapshot request failed/)).toBeVisible();
  await expect(page).toHaveURL(/\/join/);
  const registry = await page.evaluate(({ key }) =>
    JSON.parse(localStorage.getItem(key) ?? "{}") as { activeId?: string },
    { key: REGISTRY_KEY });
  expect(registry.activeId).not.toBe(vaultB.vaultId);
});

test("a PAIR link always keeps its confirmation, even for a first-time browser", async ({ page }) => {
  // PAIR joins the same synced vault - a bigger commitment than a COPY's
  // separate, disposable clone - so this must never auto-skip regardless of
  // whether the browser has been used before.
  //
  // redeemInviteToken always tries codeType "COPY" first, falling through to
  // "PAIR" only on a 404 - so this has to discriminate by the request body
  // like the other PAIR fixture does, or the COPY attempt would resolve
  // first with a mismatched code and auto-confirm as if it were one.
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
  await page.route(`**/sync/snapshot?vault=${vaultB.vaultId}*`, (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ seq: 0, records: {} }),
  }));

  await page.goto("/join?token=92929292-9292-4292-8292-929292929292");
  await expect(page.getByRole("heading", { name: "Join a synced vault" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Join", exact: true })).toBeEnabled();
  // Still sitting on the confirm screen: nothing joined itself.
  await expect.poll(() => page.evaluate(({ key }) =>
    JSON.parse(localStorage.getItem(key) ?? "{}").activeId, { key: REGISTRY_KEY }))
    .not.toBe(vaultB.vaultId);

  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect.poll(() => page.evaluate(({ key }) =>
    JSON.parse(localStorage.getItem(key) ?? "{}").activeId, { key: REGISTRY_KEY }))
    .toBe(vaultB.vaultId);
});

test("a browser that has merely visited before still sees the COPY confirmation", async ({ page }) => {
  // Only the durable session marker is seeded - no datalet registry, no
  // records - proving the signal is "has this browser ever opened the app",
  // not "does it currently hold a datalet worth protecting".
  await page.addInitScript(() => {
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "join-session", private_store_id: "test-private-store",
    }));
  });
  await page.route("**/sync/invite-redeem", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ code: "COPY-K3RM-9T7A-X" }),
  }));

  await page.goto("/join?token=93939393-9393-4393-8393-939393939393");
  await expect(page.getByRole("heading", { name: "Take a copy of a datalet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Take a copy" })).toBeEnabled();
});
