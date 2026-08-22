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
  /**
   * The last known `Settings.appTitle` of this datalet.
   *
   * Cached here because a datalet that is not open has been evicted from
   * localStorage, so its own title is unreadable without fetching its vault -
   * which is why the list used to fall back to a vault id. Written while the
   * datalet is active and from the snapshot when one is adopted, so it can be
   * stale if the title was changed on another device since. That is worth it:
   * a name that is one edit out of date still identifies the thing, and a
   * `Vault 1586f18f` never did.
   */
  title?: string;
  /**
   * When this datalet was put out of the way, if it was.
   *
   * Archiving is emphatically not deleting: the vault, its credentials and
   * every record stay exactly as they were, and restoring is one click. It
   * exists because datalets are cheap to make and some are made to be
   * finished with - a list that only ever grows makes the three you are using
   * harder to find, which is the opposite of what the list is for.
   */
  archivedAt?: number;
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

/**
 * Detach the active datalet from its vault, returning it to the local graph
 * and keeping the vault as an archived datalet of its own.
 *
 * The vault token exists in exactly one place: this entry. Dropping it, which
 * is what this used to do, left a vault on the server that nobody could ever
 * reach again - not to rejoin it, and not to erase it either, since erasure
 * has to authenticate. Keeping it archived means leaving is reversible and the
 * server copy stays erasable, which is the difference between stopping syncing
 * and abandoning data.
 */
export function unpairActiveDatalet(): void {
  const registry = readDatalets();
  if (!registry) return;
  const active = registry.entries.find((entry) => entry.id === registry.activeId);
  const entries = registry.entries.map((entry) =>
    entry.id === registry.activeId ? { id: entry.id, ...(entry.title ? { title: entry.title } : {}) } : entry);
  if (active?.vault) {
    // A fresh id: the active entry may already be keyed by this vault's id,
    // and two entries sharing one id would make the registry ambiguous.
    entries.push({
      id: randomUuid(),
      vault: active.vault,
      archivedAt: Date.now(),
      ...(active.title ? { title: active.title } : {}),
    });
  }
  writeDatalets({ ...registry, entries });
}

/** Add a datalet for a vault this browser has just created or joined. */
export function addDatalet(
  vault: DataletVault,
  options: { copiedAt?: number; title?: string } = {},
): Datalet {
  const registry = readDatalets() ?? { activeId: "", entries: [] };
  const existing = registry.entries.find((entry) => entry.vault?.vaultId === vault.vaultId);
  if (existing) return existing;
  const entry: Datalet = { id: vault.vaultId, vault, ...options };
  writeDatalets({ activeId: registry.activeId || entry.id, entries: [...registry.entries, entry] });
  return entry;
}

/**
 * Remember what the active datalet is called, so it stays nameable once it is
 * closed. A no-op when unchanged: this runs on every title keystroke.
 */
export function rememberActiveDataletTitle(title: string): void {
  const registry = readDatalets();
  if (!registry) return;
  const active = registry.entries.find((entry) => entry.id === registry.activeId);
  if (!active || active.title === title) return;
  writeDatalets({
    ...registry,
    entries: registry.entries.map((entry) =>
      entry.id === registry.activeId ? { ...entry, title } : entry),
  });
}

/** Make `id` the datalet in use. The caller reloads; nothing here does. */
export function setActiveDatalet(id: string): void {
  const registry = readDatalets();
  if (!registry?.entries.some((entry) => entry.id === id)) return;
  writeDatalets({ ...registry, activeId: id });
}

/**
 * Put a datalet out of the way, or bring it back.
 *
 * The open datalet cannot be archived. Archiving it would mean evicting and
 * switching in one gesture, which is the operation `canLeaveActiveDatalet`
 * exists to guard - and it would leave the app deciding on its own which
 * datalet you land in. Open another one first.
 */
export function setDataletArchived(id: string, archived: boolean): void {
  const registry = readDatalets();
  if (!registry) return;
  if (archived && id === registry.activeId) return;
  writeDatalets({
    ...registry,
    entries: registry.entries.map((entry) =>
      entry.id === id
        ? archived
          ? { ...entry, archivedAt: Date.now() }
          : stripArchive(entry)
        : entry),
  });
}

function stripArchive(entry: Datalet): Datalet {
  const { archivedAt: _archivedAt, ...rest } = entry;
  return rest;
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

/**
 * Every datalet this browser knows about, split by whether it has been put
 * away. The active one is never in `archived`, because it cannot be archived
 * while it is open.
 */
export function listDatalets(): { entries: Datalet[]; archived: Datalet[]; activeId: string } {
  const registry = readDatalets();
  if (!registry) return { entries: [], archived: [], activeId: "" };
  return {
    entries: registry.entries.filter((entry) => entry.archivedAt === undefined),
    archived: registry.entries.filter((entry) => entry.archivedAt !== undefined),
    activeId: registry.activeId,
  };
}
