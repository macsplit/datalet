import { expect, test, type Page } from "@playwright/test";
import { installFakeSyncServer, type FakeSyncServer } from "./support/fakeSyncServer";
import { checkInvariants } from "./support/dataletInvariants";

/**
 * A random walk through datalet operations, checking the invariants after
 * every step and stopping at the first breach.
 *
 * Every datalet bug this project has shipped lived in a *composition* -
 * create then switch, pair then leave, leave then return - and each individual
 * step had a passing test. A random walk explores compositions; example-based
 * tests only cover the ones someone thought to write.
 *
 * Stopping at the first breach is the point. A run that reports at the end
 * makes you wait out the whole budget to learn what step three already knew.
 *
 * Deterministic: `FUZZ_SEED` fixes the walk and the failure message prints the
 * seed and the operation log, so `FUZZ_SEED=<n> pnpm fuzz` replays it exactly.
 * Without that a failure is an anecdote.
 *
 *   pnpm fuzz                        # a short default walk
 *   FUZZ_STEPS=400 pnpm fuzz         # a long one; same harness, bigger budget
 *   FUZZ_SEED=12345 pnpm fuzz        # replay
 */

const STEPS = Number(process.env.FUZZ_STEPS ?? 40);

/**
 * Resolved inside the test, never at module scope, and kept out of the test
 * title. Playwright loads this file twice - once to collect tests, once in the
 * worker - so a random value chosen at module scope differs between the two
 * loads. Putting it in the title then made the titles disagree and the worker
 * could not find the test at all, which is a confusing way for `pnpm fuzz`
 * with no seed to fail.
 */
function resolveSeed(): number {
  const configured = process.env.FUZZ_SEED;
  return configured === undefined ? Math.floor(Math.random() * 1e9) : Number(configured);
}

/** mulberry32: small, seedable, and good enough to choose between buttons. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedApp(page: Page) {
  await page.addInitScript(() => {
    if (localStorage.getItem("fuzz-seeded")) return;
    localStorage.clear();
    localStorage.setItem("fuzz-seeded", "1");
    localStorage.setItem("meta-ui-builder:local-session", JSON.stringify({
      session_id: "fuzz", private_store_id: "fuzz-private-store" }));
    const graph = "did:ng:fuzz-private-store";
    const records = [
      { "@graph": graph, "@id": "did:ng:z:HomeTab", "@type": "did:ng:z:Tab", title: "Home", order: 0 },
      { "@graph": graph, "@id": "did:ng:z:SettingsSingleton", "@type": "did:ng:z:Settings", appTitle: "Fuzz" },
    ];
    const ids = records.map((r) => `${r["@graph"]}|${r["@id"]}`);
    localStorage.setItem("meta-ui-builder:ng-local-store:index", JSON.stringify(ids));
    records.forEach((r, i) =>
      localStorage.setItem(`meta-ui-builder:ng-local-store:record:${ids[i]}`, JSON.stringify(r)));
  });
}

/** An operation is only attempted when its control is present and enabled. */
type Operation = { name: string; run: () => Promise<void> };

async function availableOperations(page: Page): Promise<Operation[]> {
  const operations: Operation[] = [];
  const enabled = async (locator: ReturnType<Page["getByRole"]>) =>
    (await locator.count()) > 0 && (await locator.first().isEnabled());

  const create = page.getByRole("button", { name: "Create sync vault" });
  if (await enabled(create)) operations.push({ name: "create vault", run: () => create.first().click() });

  const empty = page.getByRole("button", { name: "Start an empty one" });
  if (await enabled(empty)) operations.push({ name: "add empty datalet", run: () => empty.first().click() });

  const leave = page.getByRole("button", { name: "Leave vault" });
  if (await enabled(leave)) {
    operations.push({ name: "leave vault", run: async () => {
      page.once("dialog", (dialog) => void dialog.accept());
      await leave.first().click();
    } });
  }

  const open = page.getByRole("button", { name: "Open" });
  const openCount = await open.count();
  for (let i = 0; i < openCount; i += 1) {
    if (await open.nth(i).isEnabled()) {
      operations.push({ name: `open datalet #${i}`, run: () => open.nth(i).click() });
    }
  }

  const archive = page.getByRole("button", { name: "Archive" });
  const archiveCount = await archive.count();
  for (let i = 0; i < archiveCount; i += 1) {
    if (await archive.nth(i).isEnabled()) {
      operations.push({ name: `archive #${i}`, run: () => archive.nth(i).click() });
    }
  }

  const summary = page.locator("summary", { hasText: /Archived \(/ });
  if (await summary.count() > 0) {
    operations.push({ name: "expand archived", run: () => summary.first().click() });
  }

  const restore = page.getByRole("button", { name: "Restore" });
  const restoreCount = await restore.count();
  for (let i = 0; i < restoreCount; i += 1) {
    if (await restore.nth(i).isEnabled()) {
      operations.push({ name: `restore #${i}`, run: () => restore.nth(i).click() });
    }
  }

  return operations;
}

test("datalet operations survive a random walk", async ({ page }) => {
  test.setTimeout(STEPS * 4_000 + 60_000);

  const SEED = resolveSeed();
  console.log(`fuzz: seed ${SEED}, up to ${STEPS} steps`);
  const next = random(SEED);
  const log: string[] = [];
  let server: FakeSyncServer;

  await seedApp(page);
  server = await installFakeSyncServer(page);
  await page.goto("/settings/datalets");

  const fail = (why: string, extra = "") => {
    throw new Error(
      `${why}\n\n`
      + `Replay with: FUZZ_SEED=${SEED} FUZZ_STEPS=${STEPS} pnpm fuzz\n\n`
      + `Steps taken (${log.length}):\n${log.map((line, i) => `  ${i + 1}. ${line}`).join("\n")}`
      + (extra ? `\n\n${extra}` : ""),
    );
  };

  for (let step = 0; step < STEPS; step += 1) {
    const operations = await availableOperations(page);
    if (operations.length === 0) {
      console.log(`fuzz: step ${step + 1}/${STEPS}: no operation is available; walk complete`);
      break;
    }

    const operation = operations[Math.floor(next() * operations.length)];
    log.push(operation.name);
    console.log(
      `fuzz: step ${step + 1}/${STEPS}: ${operation.name} (${operations.length} available)`,
    );
    await operation.run();

    // Several operations reload; wait for the page to be usable again rather
    // than racing it.
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("heading", { name: "Switch datalet" }))
      .toBeVisible({ timeout: 20_000 })
      .catch(() => undefined);
    await page.waitForTimeout(250);

    const breaches = await checkInvariants(page);
    if (breaches.length > 0) {
      fail(
        `Invariant breached after "${operation.name}":\n`
        + breaches.map((breach) => `  - ${breach.name}: ${breach.detail}`).join("\n"),
      );
    }
    if (server.violations.length > 0) {
      fail(
        "The server served a snapshot the client would reject:\n"
        + server.violations.map((violation) => `  - vault ${violation.vaultId}: ${violation.reason}`).join("\n"),
      );
    }
    console.log(`fuzz: step ${step + 1}/${STEPS}: invariants hold`);
  }

  console.log(`fuzz: seed ${SEED}, ${log.length} operations, no invariant breached`);
});
