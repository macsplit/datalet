import { readFile, writeFile } from "node:fs/promises";
import { redis } from "../src/redis/client.js";
import { closeNeo4j, neo4jSession } from "../src/neo4j/client.js";

const baseUrl = process.env.ENDURANCE_BASE_URL ?? "http://127.0.0.1:3800";
const durationMs = Number(process.env.ENDURANCE_DURATION_MS ?? 2 * 60 * 60 * 1_000);
const writesPerSecond = Number(process.env.ENDURANCE_WRITES_PER_SECOND ?? 1);
const sseConnections = Number(process.env.ENDURANCE_SSE_CONNECTIONS ?? 20);
const metricsFile = process.env.ENDURANCE_METRICS_FILE ?? "/tmp/localgraph-endurance-metrics.json";
const syncServerPid = Number(process.env.ENDURANCE_SYNC_SERVER_PID ?? 0);
const materializerPid = Number(process.env.ENDURANCE_MATERIALIZER_PID ?? 0);
const materializerPidFile = process.env.ENDURANCE_MATERIALIZER_PID_FILE;

type Sample = {
  elapsedMs: number;
  accepted: number;
  errors: number;
  redisBytes?: number;
  syncServerRssKb?: number;
  materializerRssKb?: number;
  pending?: number;
};

async function jsonRequest(path: string, init?: RequestInit) {
  const response = await fetch(baseUrl + path, init);
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} returned ${response.status}`);
  return response.json() as Promise<Record<string, unknown>>;
}

async function rssKb(pid: number): Promise<number | undefined> {
  if (!pid) return undefined;
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

async function currentMaterializerPid(): Promise<number> {
  if (!materializerPidFile) return materializerPid;
  try {
    return Number((await readFile(materializerPidFile, "utf8")).trim());
  } catch {
    return materializerPid;
  }
}

const { vaultId, vaultToken } = (await jsonRequest("/sync/vaults", {
  method: "POST",
  headers: { "X-Forwarded-For": `203.0.113.${Math.floor(Math.random() * 200) + 1}` },
})) as { vaultId: string; vaultToken: string };
const auth = { Authorization: `Bearer ${vaultToken}` };
const aborters: AbortController[] = [];

for (let index = 0; index < sseConnections; index += 1) {
  const { ticket } = (await jsonRequest(`/sync/stream-ticket?vault=${encodeURIComponent(vaultId)}`, {
    method: "POST",
    headers: auth,
  })) as { ticket: string };
  const controller = new AbortController();
  aborters.push(controller);
  void fetch(
    `${baseUrl}/sync/stream?vault=${encodeURIComponent(vaultId)}&since=0&ticket=${encodeURIComponent(ticket)}`,
    { signal: controller.signal },
  ).then(async (response) => {
    if (!response.ok) throw new Error(`SSE ${index} returned ${response.status}`);
    const reader = response.body?.getReader();
    while (reader) {
      const result = await reader.read();
      if (result.done) break;
    }
  }).catch((error) => {
    if (!controller.signal.aborted) console.error(error);
  });
}

const startedAt = Date.now();
let accepted = 0;
let errors = 0;
let writeCounter = 0;
const samples: Sample[] = [];
let stopped = false;

async function writeOne() {
  const index = writeCounter++;
  const subject = `endurance-${index}`;
  const hlc = `${String(Date.now()).padStart(15, "0")}-000000-endurance`;
  try {
    await jsonRequest(`/sync/patches?vault=${encodeURIComponent(vaultId)}`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        nodeId: "endurance-node",
        batchId: `endurance-batch-${index}`,
        hlc,
        shape: "did:ng:z:EnduranceShape",
        patches: [
          { op: "add", path: `/${subject}` },
          { op: "add", path: `/${subject}/@id`, value: subject },
          { op: "add", path: `/${subject}/@graph`, value: vaultId },
          { op: "add", path: `/${subject}/@type`, value: "did:ng:z:EnduranceRecord" },
          { op: "add", path: `/${subject}/value`, value: index },
        ],
      }),
    });
    accepted += 1;
  } catch (error) {
    errors += 1;
    console.error(error);
  }
}

async function sample() {
  const info = await redis().info("memory");
  const redisBytes = Number(/^used_memory:(\d+)$/m.exec(info)?.[1]);
  let pending: number | undefined;
  try {
    const result = await redis().xpending(`vault:${vaultId}:stream`, "materializer");
    pending = Number(result[0]);
  } catch {
    pending = undefined;
  }
  samples.push({
    elapsedMs: Date.now() - startedAt,
    accepted,
    errors,
    redisBytes: Number.isFinite(redisBytes) ? redisBytes : undefined,
    syncServerRssKb: await rssKb(syncServerPid),
    materializerRssKb: await rssKb(await currentMaterializerPid()),
    pending,
  });
  await writeFile(metricsFile, JSON.stringify({ vaultId, durationMs, writesPerSecond, sseConnections, samples }, null, 2));
}

const writeTimer = setInterval(() => {
  if (!stopped) void writeOne();
}, 1_000 / writesPerSecond);
const sampleTimer = setInterval(() => void sample(), 60_000);
await sample();
await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
stopped = true;
clearInterval(writeTimer);
clearInterval(sampleTimer);

const deadline = Date.now() + 5 * 60_000;
let materialized = 0;
while (Date.now() < deadline) {
  const snapshot = await jsonRequest(`/sync/snapshot?vault=${encodeURIComponent(vaultId)}`, { headers: auth });
  materialized = Object.keys(snapshot.records as Record<string, unknown>).length;
  if (materialized === accepted) break;
  await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
}
await sample();
aborters.forEach((controller) => controller.abort());

const summary = {
  vaultId,
  durationMs,
  writesPerSecond,
  sseConnections,
  accepted,
  materialized,
  errors,
  samples,
  completedAt: new Date().toISOString(),
};
await writeFile(metricsFile, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));

if (materialized !== accepted || errors !== 0) process.exitCode = 1;

if (process.env.ENDURANCE_CLEANUP === "1") {
  const keys = await redis().keys(`vault:${vaultId}:*`);
  if (keys.length > 0) await redis().del(...keys);
  await redis().srem("vaults:index", vaultId);
  const session = neo4jSession();
  try {
    await session.run("MATCH (n) WHERE (n:Record AND n.graph = $vaultId) OR (n:VaultMeta AND n.id = $vaultId) DETACH DELETE n", { vaultId });
  } finally {
    await session.close();
  }
}

redis().disconnect();
await closeNeo4j();
