import type { Page } from "@playwright/test";

/**
 * What must be true of the app between operations, whatever sequence got it
 * here. Each of these is a bug this project actually shipped, turned into a
 * rule - which is why the list is worth more than the driver that exercises it.
 */

export type InvariantBreach = { name: string; detail: string };

export async function checkInvariants(page: Page): Promise<InvariantBreach[]> {
  const breaches: InvariantBreach[] = [];

  // The safety circuits. Both opened in production before either data-loss bug
  // was understood, and both are visible in the DOM the moment they trip.
  if (await page.locator("#runtime-issue-banner").count() > 0) {
    breaches.push({
      name: "safety-circuit-open",
      detail: (await page.locator("#runtime-issue-banner").innerText()).replace(/\s+/g, " ").trim(),
    });
  }
  if (await page.getByText(/failed local validation/).count() > 0) {
    breaches.push({ name: "records-failed-validation", detail: "a switch reported invalid records" });
  }

  const state = await page.evaluate(() => {
    const REGISTRY = "meta-ui-builder:datalets";
    const INDEX = "meta-ui-builder:ng-local-store:index";
    type Entry = { id: string; vault?: { vaultId: string; vaultToken: string }; archivedAt?: number };
    const registry = JSON.parse(localStorage.getItem(REGISTRY) ?? "null") as
      { activeId: string; entries: Entry[] } | null;
    const index = JSON.parse(localStorage.getItem(INDEX) ?? "[]") as string[];
    const graphs = [...new Set(index.map((key) => key.split("|")[0]))];
    const session = JSON.parse(localStorage.getItem("meta-ui-builder:local-session") ?? "null") as
      { private_store_id?: string } | null;

    let used = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key) used += key.length + (localStorage.getItem(key)?.length ?? 0);
    }

    const outboxes = Object.fromEntries(
      Object.keys(localStorage)
        .filter((key) => key.startsWith("meta-ui-builder:sync-outbox:"))
        .map((key) => [key, (JSON.parse(localStorage.getItem(key) ?? "[]") as unknown[]).length]),
    );

    return { registry, graphs, localGraph: session?.private_store_id && `did:ng:${session.private_store_id}`, used, outboxes };
  });

  const { registry, graphs, localGraph, used, outboxes } = state;
  if (!registry) return breaches;

  const active = registry.entries.find((entry) => entry.id === registry.activeId);
  if (!active) {
    breaches.push({ name: "no-active-datalet", detail: `activeId ${registry.activeId} is not in the registry` });
    return breaches;
  }
  if (active.archivedAt !== undefined) {
    breaches.push({ name: "active-datalet-archived", detail: "the open datalet is marked archived" });
  }

  // The one-resident rule. Both data-loss bugs were a second graph left behind
  // in storage: unreachable, still occupying the budget. Exactly one graph may
  // hold records, and it must be the open datalet's.
  const activeGraph = active.vault ? `did:ng:${active.vault.vaultId}` : localGraph;
  const strays = graphs.filter((graph) => graph !== activeGraph);
  if (strays.length > 0) {
    breaches.push({
      name: "orphaned-graph",
      detail: `records exist in ${strays.join(", ")} but the open datalet is ${activeGraph}`,
    });
  }

  // A vault token exists in exactly one place. Losing it strands a vault that
  // can never be rejoined and never erased.
  const ids = registry.entries.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    breaches.push({ name: "duplicate-registry-id", detail: ids.join(", ") });
  }

  if (used > 4_500_000) {
    breaches.push({ name: "over-storage-cap", detail: `${used} characters stored` });
  }

  for (const [key, pending] of Object.entries(outboxes)) {
    if (pending > 0) breaches.push({ name: "outbox-did-not-drain", detail: `${key} still holds ${pending}` });
  }

  return breaches;
}
