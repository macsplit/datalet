import { closeNeo4j, neo4jDriver, neo4jSession } from "../src/neo4j/client.js";
import { readRecord } from "../src/neo4j/materialize.js";
import { MATERIALIZER_STREAMS_PER_CONNECTION } from "../src/neo4j/config.js";
import { redis } from "../src/redis/client.js";
import { MaterializerService, materializerShardFor } from "../src/materializer.js";
import { applyBatch, createVault } from "../src/vaultStore.js";

const vaultCount = Number(process.env.MULTI_TENANT_VAULTS ?? 200);
const activeCount = Math.min(vaultCount, Number(process.env.MULTI_TENANT_ACTIVE_VAULTS ?? 50));
const timeoutMs = Number(process.env.MULTI_TENANT_TIMEOUT_MS ?? 60_000);
const initialCount = Math.min(10, vaultCount);
const shardCount = Number(process.env.MULTI_TENANT_SHARDS ?? 2);
const ownedVaults = new Set<string>();
const vaults: Array<{ vaultId: string; vaultToken: string }> = [];
const services = Array.from({ length: shardCount }, (_, shardIndex) => new MaterializerService({
  streamsPerConnection: MATERIALIZER_STREAMS_PER_CONNECTION,
  discoveryIntervalMs: 100,
  blockMs: 100,
  shardIndex,
  shardCount,
  ownsVault: (vaultId) =>
    ownedVaults.has(vaultId) && materializerShardFor(vaultId, shardCount) === shardIndex,
}));

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function redisMetrics() {
  const [memory, clients] = await Promise.all([redis().info("memory"), redis().info("clients")]);
  const list = await redis().client("LIST") as string;
  return {
    usedMemoryBytes: Number(/^used_memory:(\d+)$/m.exec(memory)?.[1] ?? 0),
    connectedClients: Number(/^connected_clients:(\d+)$/m.exec(clients)?.[1] ?? 0),
    materializerConnections: list
      .split("\n")
      .filter((line) => line.includes("name=localgraph-materializer-batch-"))
      .length,
  };
}

async function addVaults(count: number) {
  for (let index = 0; index < count; index += 1) {
    const vault = await createVault();
    vaults.push(vault);
    ownedVaults.add(vault.vaultId);
  }
  await Promise.all(services.map((service) => service.discoverNow()));
}

async function cleanup() {
  await Promise.all(services.map((service) => service.stop()));
  for (const { vaultId } of vaults) {
    const keys = await redis().keys(`vault:${vaultId}:*`);
    if (keys.length > 0) await redis().del(...keys);
    await redis().srem("vaults:index", vaultId);
  }
  if (vaults.length > 0) {
    const session = neo4jSession();
    try {
      const vaultIds = vaults.map(({ vaultId }) => vaultId);
      await session.run(
        "MATCH (n) WHERE (n:Record AND n.graph IN $vaultIds) OR " +
          "(n:VaultMeta AND n.id IN $vaultIds) DETACH DELETE n",
        { vaultIds },
      );
    } finally {
      await session.close();
    }
  }
  redis().disconnect();
  await closeNeo4j();
}

try {
  await Promise.all([redis().ping(), neo4jDriver().verifyConnectivity()]);
  const before = await redisMetrics();
  await Promise.all(services.map((service) => service.start()));

  await addVaults(initialCount);
  const initial = await redisMetrics();
  await addVaults(vaultCount - initialCount);
  const full = await redisMetrics();

  const active = Array.from({ length: activeCount }, (_, index) =>
    vaults[Math.floor(index * vaults.length / activeCount)],
  );
  const acceptedAt = new Map<string, number>();
  await Promise.all(active.map(async ({ vaultId }, index) => {
    const subject = `multi-tenant-${index}`;
    const result = await applyBatch(vaultId, {
      nodeId: "multi-tenant-harness",
      batchId: `multi-tenant-batch-${index}`,
      hlc: `${String(Date.now()).padStart(15, "0")}-000000-multi-tenant-harness`,
      shape: "did:ng:z:MultiTenantHarness",
      patches: [
        { op: "add", path: `/${subject}` },
        { op: "add", path: `/${subject}/@id`, value: subject },
        { op: "add", path: `/${subject}/@graph`, value: vaultId },
        { op: "add", path: `/${subject}/@type`, value: "did:ng:z:MultiTenantHarness" },
        { op: "add", path: `/${subject}/value`, value: index },
      ],
    });
    if (!result.accepted) throw new Error(`vault ${vaultId} rejected its harness write: ${result.reason}`);
    acceptedAt.set(vaultId, Date.now());
  }));

  const lagByVault = new Map<string, number>();
  const deadline = Date.now() + timeoutMs;
  while (lagByVault.size < active.length && Date.now() < deadline) {
    await Promise.all(active.map(async ({ vaultId }, index) => {
      if (lagByVault.has(vaultId)) return;
      if (await readRecord(vaultId, `multi-tenant-${index}`)) {
        lagByVault.set(vaultId, Date.now() - acceptedAt.get(vaultId)!);
      }
    }));
    if (lagByVault.size < active.length) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const lags = [...lagByVault.values()];
  const after = await redisMetrics();
  const vaultsPerShard = Array.from({ length: shardCount }, (_, shardIndex) =>
    vaults.filter(({ vaultId }) => materializerShardFor(vaultId, shardCount) === shardIndex).length);
  const expectedConnections = vaultsPerShard.reduce(
    (total, count) => total + Math.ceil(count / MATERIALIZER_STREAMS_PER_CONNECTION),
    0,
  );
  const summary = {
    ok: lagByVault.size === active.length && full.materializerConnections === expectedConnections,
    vaultCount,
    activeVaults: active.length,
    materializedVaults: lagByVault.size,
    streamsPerConnection: MATERIALIZER_STREAMS_PER_CONNECTION,
    shardCount,
    vaultsPerShard,
    expectedConnections,
    connections: {
      before: before.connectedClients,
      atInitialVaults: initial.materializerConnections,
      atAllVaults: full.materializerConnections,
      afterWrites: after.materializerConnections,
    },
    redisMemoryBytes: {
      before: before.usedMemoryBytes,
      after: after.usedMemoryBytes,
      delta: after.usedMemoryBytes - before.usedMemoryBytes,
    },
    materializationLagMs: {
      p50: percentile(lags, 0.5),
      p95: percentile(lags, 0.95),
      p99: percentile(lags, 0.99),
      max: Math.max(0, ...lags),
    },
  };
  console.log(JSON.stringify(summary));
  if (!summary.ok) process.exitCode = 1;
} finally {
  await cleanup();
}
