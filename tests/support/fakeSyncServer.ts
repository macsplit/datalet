import type { Page } from "@playwright/test";

/**
 * A sync server that actually stores what it is sent.
 *
 * Fidelity on the one axis that has mattered: a snapshot returns what patches
 * put in, keyed the same way. Client and server holding different ideas of a
 * record's key is precisely the class of bug that reached production, and a
 * stub returning a canned snapshot cannot see it.
 *
 * Every snapshot served is checked against the client's own rule before it
 * goes out, so a vault that has been made unreadable is caught at the moment
 * it becomes unreadable rather than at the next switch.
 */

export type SnapshotViolation = { vaultId: string; reason: string };

export type FakeSyncServer = {
  /** Anything served that the client would have rejected. Empty is the invariant. */
  violations: SnapshotViolation[];
  vaultCount: () => number;
};

/** The client's `validGraphSnapshot` rule, restated so the harness can enforce it. */
function snapshotProblem(graph: string, records: Record<string, Record<string, unknown>>): string | undefined {
  for (const [key, record] of Object.entries(records)) {
    if (typeof record["@id"] !== "string") return `${key} has no @id`;
    if (record["@graph"] !== graph) return `${key} has @graph ${JSON.stringify(record["@graph"])}, expected ${graph}`;
    if (key !== `${graph}|${record["@id"] as string}`) return `${key} is not keyed as ${graph}|@id`;
  }
  return undefined;
}

function decodeSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

export async function installFakeSyncServer(page: Page): Promise<FakeSyncServer> {
  const vaults = new Map<string, Record<string, Record<string, unknown>>>();
  const sequences = new Map<string, number>();
  const violations: SnapshotViolation[] = [];
  let created = 0;

  await page.route("**/sync/vaults*", async (route) => {
    const request = route.request();
    if (request.method() === "DELETE") {
      const vaultId = new URL(request.url()).searchParams.get("vault") ?? "";
      vaults.delete(vaultId);
      sequences.delete(vaultId);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: true }) });
    }
    if (request.method() !== "POST") return route.fallback();
    created += 1;
    const vaultId = `${created.toString().padStart(8, "0")}-0000-4000-8000-000000000000`;
    vaults.set(vaultId, {});
    sequences.set(vaultId, 0);
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ vaultId, vaultToken: `TOKEN${created}`.padEnd(32, "x") }),
    });
  });

  await page.route("**/sync/patches?*", async (route) => {
    const vaultId = new URL(route.request().url()).searchParams.get("vault") ?? "";
    const body = JSON.parse(route.request().postData() ?? "{}") as {
      patches?: Array<{ op: string; path: string; value?: unknown }>;
    };
    const store = vaults.get(vaultId) ?? {};
    for (const patch of body.patches ?? []) {
      const [subject, property] = patch.path.slice(1).split("/").map(decodeSegment);
      if (property === undefined) {
        if (patch.op === "remove") delete store[subject];
        else store[subject] ??= {};
        continue;
      }
      store[subject] ??= {};
      if (patch.op === "remove") delete store[subject][property];
      else store[subject][property] = patch.value;
    }
    vaults.set(vaultId, store);
    const seq = (sequences.get(vaultId) ?? 0) + 1;
    sequences.set(vaultId, seq);
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ accepted: true, seq, acceptedCount: 1, submittedCount: 1 }),
    });
  });

  await page.route("**/sync/snapshot?*", async (route) => {
    const vaultId = new URL(route.request().url()).searchParams.get("vault") ?? "";
    const records = vaults.get(vaultId) ?? {};
    const problem = snapshotProblem(`did:ng:${vaultId}`, records);
    if (problem) violations.push({ vaultId, reason: problem });
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ seq: sequences.get(vaultId) ?? 0, records }),
    });
  });

  await page.route("**/sync/stream-ticket?*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ ticket: "t" }) }));
  await page.route("**/sync/stream?*", (route) => route.abort());
  await page.route("**/sync/clone-codes*", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: JSON.stringify({ codes: [] }) }));

  return { violations, vaultCount: () => vaults.size };
}
