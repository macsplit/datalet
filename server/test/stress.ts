/**
 * Hammering the sync tier to find *logic* faults, not to exhaust a machine.
 *
 * The interesting bugs live where size and concurrency change behaviour: two
 * writers racing on one field, a batch that straddles the quota, a retry that
 * arrives twice, a stream trimmed past a reader's cursor. None of those need a
 * big machine to provoke - they need overlap and awkward sizes, which is what
 * this generates.
 *
 * Deliberately not tuned to the machine it runs on. Sizes are set by
 * environment so a weaker box runs the same logic at a gentler volume rather
 * than a different test:
 *
 *   pnpm stress
 *   STRESS_VAULTS=8 STRESS_WRITERS=6 STRESS_ROUNDS=40 pnpm stress
 *   STRESS_RECORD_BYTES=200000 pnpm stress     # large payloads
 *   STRESS_SEED=42 pnpm stress                 # replay
 *
 * It aborts on the first breached invariant and prints the seed, because
 * running to completion to collect a second symptom of the same fault wastes
 * the time this exists to save.
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createSyncServer } from "../src/httpServer.js";
import { redis } from "../src/redis/client.js";
import { snapshot, deleteVault } from "../src/vaultStore.js";
import { VAULT_QUOTA_BYTES } from "../src/redis/config.js";
import { MaterializerService } from "../src/materializer.js";
import { closeNeo4j, neo4jDriver } from "../src/neo4j/client.js";

const SEED = Number(process.env.STRESS_SEED ?? Math.floor(Math.random() * 1e9));
const VAULTS = Number(process.env.STRESS_VAULTS ?? 4);
const WRITERS = Number(process.env.STRESS_WRITERS ?? 4);
const ROUNDS = Number(process.env.STRESS_ROUNDS ?? 15);
const RECORD_BYTES = Number(process.env.STRESS_RECORD_BYTES ?? 2_000);

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const next = random(SEED);

const progress = (line: string) => process.stdout.write(`stress: ${line}\n`);

function fail(what: string, detail: unknown): never {
  throw new Error(
    `${what}\n${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}`,
  );
}

/** The client's snapshot rule, enforced here so a vault cannot become unreadable. */
function snapshotProblem(graph: string, records: Record<string, Record<string, unknown>>): string | undefined {
  for (const [key, record] of Object.entries(records)) {
    if (typeof record["@id"] !== "string") return `${key} has no @id`;
    if (record["@graph"] !== graph) return `${key} has @graph ${JSON.stringify(record["@graph"])}`;
    if (key !== `${graph}|${record["@id"] as string}`) return `${key} is not ${graph}|@id`;
  }
  return undefined;
}

/** An HLC that sorts lexically, matching the client's format. */
function hlc(millis: number, counter: number, node: string): string {
  return `${String(millis).padStart(15, "0")}-${String(counter).padStart(6, "0")}-${node}`;
}

async function main() {
  await Promise.all([redis().ping(), neo4jDriver().verifyConnectivity()]);
  progress(`seed ${SEED}, ${VAULTS} vaults x ${WRITERS} writers x ${ROUNDS} rounds, `
    + `${RECORD_BYTES}B records`);

  const server = createSyncServer("/tmp/localgraph-no-static-files");
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const vaults: Array<{ vaultId: string; vaultToken: string }> = [];
  let materializer: MaterializerService | undefined;
  try {
    const creationIdentity = `stress-test-${SEED}-${randomUUID()}`;
    for (let i = 0; i < VAULTS; i += 1) {
      progress(`creating vault ${i + 1}/${VAULTS}`);
      const response = await fetch(`${base}/sync/vaults`, {
        method: "POST",
        headers: { "X-Forwarded-For": creationIdentity },
      });
      if (!response.ok) fail("vault creation failed", `status ${response.status}`);
      vaults.push(await response.json() as { vaultId: string; vaultToken: string });
    }

    const post = (vault: { vaultId: string; vaultToken: string }, body: unknown) =>
      fetch(`${base}/sync/patches?vault=${encodeURIComponent(vault.vaultId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${vault.vaultToken}` },
        body: JSON.stringify(body),
      });

    const vaultIds = new Set(vaults.map(({ vaultId }) => vaultId));
    materializer = new MaterializerService({
      claimShard: false,
      discoveryIntervalMs: 50,
      blockMs: 50,
      consumerName: `stress-${randomUUID()}`,
      ownsVault: (vaultId) => vaultIds.has(vaultId),
    });
    await materializer.start();
    for (let round = 0; round < ROUNDS; round += 1) {
      progress(`round ${round + 1}/${ROUNDS} starting`);
      for (const [vaultIndex, vault] of vaults.entries()) {
        const graph = `did:ng:${vault.vaultId}`;
        const subject = `${graph}|record-${Math.floor(next() * 5)}`;
        const path = `/${subject.replace(/~/g, "~0").replace(/\//g, "~1")}`;
        progress(
          `round ${round + 1}/${ROUNDS}, vault ${vaultIndex + 1}/${VAULTS}: `
          + `racing ${WRITERS} writers`,
        );

        // Concurrent writers on one field. Per-field LWW has to settle on the
        // highest HLC no matter what order they arrive in.
        const contenders = Array.from({ length: WRITERS }, (_, writer) => ({
          writer,
          hlc: hlc(1_700_000_000_000 + round, writer, `node-${writer}`),
          value: "x".repeat(RECORD_BYTES) + `-w${writer}`,
        }));
        const shuffled = [...contenders].sort(() => next() - 0.5);

        const results = await Promise.all(shuffled.map((contender) => post(vault, {
          nodeId: `node-${contender.writer}`,
          batchId: randomUUID(),
          hlc: contender.hlc,
          shape: "did:ng:z:Stress",
          patches: [
            { op: "add", path, value: {} },
            { op: "add", path: `${path}/@graph`, value: graph },
            { op: "add", path: `${path}/@id`, value: subject.slice(graph.length + 1) },
            { op: "add", path: `${path}/field`, value: contender.value },
          ],
        })));

        const accepted = results.filter((response) => response.ok);
        const rejected = results.filter((response) => !response.ok);
        for (const response of rejected) {
          // Only quota and rate limiting may refuse; anything else is a fault.
          if (![409, 429].includes(response.status)) {
            fail("a write was refused for an unexpected reason",
              `status ${response.status}: ${await response.text()}`);
          }
        }

        if (accepted.length === 0) {
          fail("every concurrent writer was refused", `round ${round}, vault ${vaultIndex}`);
        }

        // Idempotency: replaying an accepted field update must not apply twice.
        // A distinct id per round avoids accidentally checking an older dedupe
        // entry, and a field patch (not duplicate root creation) is accepted.
        const replayBody = {
          nodeId: "node-replay",
          batchId: `fixed-replay-batch-${round}`,
          hlc: hlc(1_700_000_000_000 + round, 900, "node-replay"),
          shape: "did:ng:z:Stress",
          patches: [{ op: "add", path: `${path}/replay`, value: round }],
        };
        const first = await post(vault, replayBody);
        const second = await post(vault, replayBody);
        if (!first.ok || !second.ok) {
          fail(
            "an idempotency probe was refused",
            `first ${first.status}: ${await first.text()}; second ${second.status}: ${await second.text()}`,
          );
        }
        const a = await first.json() as { seq: number };
        const b = await second.json() as { seq: number };
        if (a.seq !== b.seq) {
          fail("a replayed batchId produced a new sequence number",
            `first seq ${a.seq}, replay seq ${b.seq}`);
        }

        // Neo4j is asynchronous. Poll until the highest-HLC contender is
        // materialized, then apply the same key-shape invariant as the client.
        const winner = contenders[contenders.length - 1];
        let state = await snapshot(vault.vaultId);
        let record = state.records[subject] as Record<string, unknown> | undefined;
        const deadline = Date.now() + 8_000;
        while (record?.field !== winner.value && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          state = await snapshot(vault.vaultId);
          record = state.records[subject] as Record<string, unknown> | undefined;
        }
        if (record?.field !== winner.value) {
          fail(
            "the highest-HLC writer did not reach the durable snapshot",
            `expected writer ${winner.writer}, stored ${JSON.stringify(record?.field)}`,
          );
        }

        const problem = snapshotProblem(graph, state.records as Record<string, Record<string, unknown>>);
        if (problem) fail("the server holds a snapshot the client would reject", problem);

        const stored = Number(await redis().get(`vault:${vault.vaultId}:bytes`) ?? "0");
        if (stored > VAULT_QUOTA_BYTES) {
          fail("stored bytes exceeded the vault quota",
            `${stored} > ${VAULT_QUOTA_BYTES} after round ${round}`);
        }
        progress(
          `round ${round + 1}/${ROUNDS}, vault ${vaultIndex + 1}/${VAULTS}: `
          + `durable winner w${winner.writer}, ${stored} bytes`,
        );
      }
      progress(`round ${round + 1}/${ROUNDS} complete`);
    }

    progress(`seed ${SEED}, ${ROUNDS} rounds over ${VAULTS} vaults, no invariant breached`);
  } finally {
    progress("cleaning up materializer and test vaults");
    await materializer?.stop().catch(() => undefined);
    for (const vault of vaults) await deleteVault(vault.vaultId).catch(() => undefined);
    server.close();
    await once(server, "close");
    redis().disconnect();
    await closeNeo4j();
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`\nReplay with: STRESS_SEED=${SEED} STRESS_VAULTS=${VAULTS} `
    + `STRESS_WRITERS=${WRITERS} STRESS_ROUNDS=${ROUNDS} `
    + `STRESS_RECORD_BYTES=${RECORD_BYTES} pnpm stress`);
  process.exit(1);
});
