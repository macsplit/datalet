/**
 * The registry of datalets this browser holds.
 *
 * A *datalet* is one self-contained instance of the app - its schemas, tabs,
 * blocks, widgets, theme and records - living in its own graph. Only one is
 * active at a time; see `docs/multiple-datalets-plan.md` for why several
 * cannot be resident at once.
 *
 * This exists because vault configuration used to be a single key, which
 * silently assumed there was only ever one thing to be paired. Everything that
 * asked "am I paired?" was really asking "is *this* datalet paired?" without
 * having a way to say which.
 */

import { randomUuid } from "./randomId";

const REGISTRY_KEY = "meta-ui-builder:datalets";

/**
 * The single-vault key this replaced. Read once to migrate, never written.
 * A browser paired before the registry existed must come back paired.
 */
const LEGACY_VAULT_KEY = "meta-ui-builder:sync-vault";

export type DataletVault = { vaultId: string; vaultToken: string; nodeId: string };

export type Datalet = {
  /** Stable across pairing and unpairing, unlike the graph. */
  id: string;
  /** Present once paired. Absent means the device's local-only datalet. */
  vault?: DataletVault;
  /**
   * When this datalet was made by copying another, if it was.
   *
   * Not version control, and deliberately not the source's sequence number: a
   * copy starts with the same `appTitle` as the datalet it came from, so
   * without this the list shows two identically named entries and no way to
   * tell which is which.
   */
  copiedAt?: number;
};

/**
 * Which graph a datalet's records live in. Derived rather than stored: a
 * paired datalet is its vault's graph and an unpaired one is this device's
 * local graph, so a stored copy could only ever disagree with the truth.
 */
export function dataletGraph(datalet: Datalet, localGraph: string | undefined): string | undefined {
  return datalet.vault ? `did:ng:${datalet.vault.vaultId}` : localGraph;
}

type Registry = { activeId: string; entries: Datalet[] };

function readJson<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function isVault(value: unknown): value is DataletVault {
  const vault = value as DataletVault | undefined;
  return typeof vault?.vaultId === "string"
    && typeof vault.vaultToken === "string"
    && typeof vault.nodeId === "string";
}

function isRegistry(value: unknown): value is Registry {
  const registry = value as Registry | undefined;
  if (typeof registry?.activeId !== "string" || !Array.isArray(registry.entries)) return false;
  return registry.entries.every((entry) =>
    typeof entry?.id === "string"
    && (entry.vault === undefined || isVault(entry.vault)));
}

/**
 * The registry, migrating a pre-registry pairing on first read.
 *
 * Migration deliberately produces **one** entry, matching what the app did
 * before: when paired, the previous local graph was left on disk and
 * unreachable. Surfacing it as a second datalet would both change behaviour
 * silently and create an unpaired entry alongside a paired one, which is
 * exactly the state the design forbids.
 */
export function readDatalets(): Registry | undefined {
  const stored = readJson<unknown>(REGISTRY_KEY);
  if (isRegistry(stored) && stored.entries.length > 0) return stored;

  const legacy = readJson<unknown>(LEGACY_VAULT_KEY);
  if (isVault(legacy)) {
    return { activeId: legacy.vaultId, entries: [{ id: legacy.vaultId, vault: legacy }] };
  }
  return undefined;
}

function writeDatalets(registry: Registry) {
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry));
}

/** The datalet in use, or `undefined` before one has been recorded. */
export function activeDatalet(): Datalet | undefined {
  const registry = readDatalets();
  return registry?.entries.find((entry) => entry.id === registry.activeId);
}

/** Record this device's local datalet if nothing is recorded yet. */
export function ensureLocalDatalet(): Datalet {
  const existing = readDatalets();
  if (existing) {
    const active = existing.entries.find((entry) => entry.id === existing.activeId);
    if (active) return active;
  }
  const entry: Datalet = { id: randomUuid() };
  writeDatalets({ activeId: entry.id, entries: [entry] });
  return entry;
}

/**
 * Point the active datalet at a vault. Pairing replaces which graph the active
 * datalet *is*, which is what it has always done - the previous graph stays on
 * disk, unreferenced.
 */
export function pairActiveDatalet(vault: DataletVault): void {
  const registry = readDatalets();
  if (!registry) {
    writeDatalets({ activeId: vault.vaultId, entries: [{ id: vault.vaultId, vault }] });
    return;
  }
  const entries = registry.entries.map((entry) =>
    entry.id === registry.activeId ? { ...entry, vault } : entry);
  writeDatalets({ ...registry, entries });
}

/** Detach the active datalet from its vault, returning it to the local graph. */
export function unpairActiveDatalet(): void {
  const registry = readDatalets();
  if (!registry) return;
  const entries = registry.entries.map((entry) =>
    entry.id === registry.activeId ? { id: entry.id } : entry);
  writeDatalets({ ...registry, entries });
}

/** Add a datalet for a vault this browser has just created or joined. */
export function addDatalet(vault: DataletVault, options: { copiedAt?: number } = {}): Datalet {
  const registry = readDatalets() ?? { activeId: "", entries: [] };
  const existing = registry.entries.find((entry) => entry.vault?.vaultId === vault.vaultId);
  if (existing) return existing;
  const entry: Datalet = { id: vault.vaultId, vault, ...options };
  writeDatalets({ activeId: registry.activeId || entry.id, entries: [...registry.entries, entry] });
  return entry;
}

/** Make `id` the datalet in use. The caller reloads; nothing here does. */
export function setActiveDatalet(id: string): void {
  const registry = readDatalets();
  if (!registry?.entries.some((entry) => entry.id === id)) return;
  writeDatalets({ ...registry, activeId: id });
}

/** Forget a datalet. Its vault is untouched, so the data is not destroyed. */
export function forgetDatalet(id: string): void {
  const registry = readDatalets();
  if (!registry) return;
  const entries = registry.entries.filter((entry) => entry.id !== id);
  if (entries.length === 0) return;
  const activeId = entries.some((entry) => entry.id === registry.activeId)
    ? registry.activeId
    : entries[0].id;
  writeDatalets({ activeId, entries });
}

/** Every datalet this browser knows about, active first. */
export function listDatalets(): { entries: Datalet[]; activeId: string } {
  const registry = readDatalets();
  return registry ? { entries: registry.entries, activeId: registry.activeId } : { entries: [], activeId: "" };
}
