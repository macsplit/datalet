/**
 * Gaining a datalet, and moving between them.
 *
 * Only the active datalet is resident, so a switch fetches the incoming graph,
 * checks it fits, evicts the one being left, and only then writes. Applying
 * before evicting would put both graphs in localStorage at once - the state
 * the one-resident rule exists to avoid, and enough on its own to trip the
 * storage cap on a switch that would otherwise be fine.
 *
 * The rules that refuse a switch live here rather than in a component, so no
 * later caller can route around them.
 */

import {
  evictGraph,
  flushLocalPersistence,
  graphFootprint,
  projectedGraphFootprint,
  readStorageUsage,
  reconcileGraphSnapshot,
  type Store,
} from "./localNgEngine";
import {
  fetchVaultSnapshot,
  pendingOutboxCount,
  setDataletCursor,
  type VaultConfig,
} from "./remoteSyncEngine";
import {
  activeDatalet,
  addDatalet,
  ensureLocalDatalet,
  dataletGraph,
  rememberActiveDataletTitle,
  setActiveDatalet,
  setDataletArchived,
  type Datalet,
} from "./datalets";
import { SETTINGS_ID } from "../hooks/useSettings";

/**
 * The datalet's own name, read out of the snapshot being adopted.
 *
 * Without this a datalet just added would sit unnamed in the list until the
 * next time it happened to be open, which is the moment its name is least
 * needed.
 */
function titleFromSnapshot(graph: string, records: Store): string | undefined {
  const settings = records[`${graph}|${SETTINGS_ID}`] ?? records[SETTINGS_ID];
  const title = (settings as { appTitle?: unknown } | undefined)?.appTitle;
  return typeof title === "string" && title.trim() !== "" ? title : undefined;
}

export type SwitchCheck =
  | { ok: true }
  | { ok: false; reason: "unpaired" | "pending"; message: string };

/**
 * Whether the datalet in use can be left. Separate from the switch so the
 * interface can explain the answer before anyone commits to it.
 */
export function canLeaveActiveDatalet(): SwitchCheck {
  const active = activeDatalet();
  if (!active) return { ok: true };
  if (!active.vault) {
    return {
      ok: false,
      reason: "unpaired",
      message:
        "This datalet is only in this browser, so there is no copy anywhere else. Set up "
        + "sync for it before adding or opening another, or its records would be lost.",
    };
  }
  const pending = pendingOutboxCount(active.vault.vaultId);
  if (pending > 0) {
    return {
      ok: false,
      reason: "pending",
      message: pending === 1
        ? "1 change has not reached the sync server yet. Switching now would discard it; "
          + "try again once it has synced."
        : `${pending} changes have not reached the sync server yet. Switching now would `
          + "discard them; try again once they have synced.",
    };
  }
  return { ok: true };
}

const mb = (value: number) => `${(value / 1_000_000).toFixed(1)} MB`;

/**
 * Whether an incoming graph fits once the current one has gone.
 *
 * The only place the question is answerable, because it is the only place both
 * numbers are known: the server's quota counts UTF-8 bytes of one vault's
 * records, while this browser's budget counts UTF-16 code units across the
 * whole origin. They are not the same measure and must not be reconciled into
 * one - see `docs/datalet-add-and-clone-plan.md`.
 */
export function adoptionFits(graph: string, records: Store, leaving: string | undefined) {
  const usage = readStorageUsage();
  const reclaimed = leaving ? graphFootprint(leaving) : 0;
  const incoming = projectedGraphFootprint(graph, records);
  const after = usage.used - reclaimed + incoming;
  if (after <= usage.cap) return { ok: true as const };
  return {
    ok: false as const,
    message:
      `That datalet needs ${mb(incoming)} and this browser has ${mb(usage.cap - usage.used + reclaimed)} `
      + "free. Nothing has been created. Make room here, or open it on a device with more space.",
  };
}

async function adopt(target: Datalet, localGraph: string | undefined) {
  if (!target.vault) throw new Error("That datalet has no vault to open from.");
  const active = activeDatalet();
  const leaving = active && active.id !== target.id ? dataletGraph(active, localGraph) : undefined;
  const targetGraph = dataletGraph(target, localGraph);
  if (!targetGraph) throw new Error("This device is still starting up; try again in a moment.");

  // Fetch first: a failure here must leave the current datalet exactly as it was.
  const snapshot = await fetchVaultSnapshot(target.vault);

  const fits = adoptionFits(targetGraph, snapshot.records, leaving);
  if (!fits.ok) throw new Error(fits.message);

  // Recorded before the eviction that makes it unreadable.
  const incomingTitle = titleFromSnapshot(targetGraph, snapshot.records);
  if (leaving) evictGraph(leaving);
  if (!reconcileGraphSnapshot(targetGraph, snapshot.records)) {
    throw new Error("That datalet's records failed local validation.");
  }
  flushLocalPersistence();
  setDataletCursor(target.vault.vaultId, snapshot.seq);
  setActiveDatalet(target.id);
  // Opening an archived datalet brings it back: something you are working in
  // is not put away, and leaving it archived would make the list disagree with
  // what the app is showing.
  setDataletArchived(target.id, false);
  if (incomingTitle) rememberActiveDataletTitle(incomingTitle);
  window.location.reload();
}

/**
 * Open a datalet already in the registry. Reloads on success, because
 * replacing the whole graph is simpler and more robust than re-targeting every
 * live subscription - the same reason pairing and import reload.
 */
export async function switchToDatalet(target: Datalet, localGraph: string | undefined) {
  ensureLocalDatalet();
  const leaving = canLeaveActiveDatalet();
  if (!leaving.ok) throw new Error(leaving.message);
  await adopt(target, localGraph);
}

/**
 * Take on a vault as a *new* datalet and open it, leaving the current one in
 * the registry rather than replacing it. This is what separates joining from
 * the first pairing, which converts the datalet you already have.
 */
export async function adoptVaultAsDatalet(
  vault: VaultConfig,
  localGraph: string | undefined,
  options: { copiedAt?: number } = {},
) {
  // Before the guard, not after. The registry was only ever written when a
  // vault was configured, so a browser that had never paired had no entry at
  // all - `canLeaveActiveDatalet` then found nothing to protect and said yes,
  // and adding a datalet stranded the local one's records in a graph nothing
  // pointed at. The rule was right; it just had nothing to apply to.
  ensureLocalDatalet();
  const leaving = canLeaveActiveDatalet();
  if (!leaving.ok) throw new Error(leaving.message);
  const entry = addDatalet(vault, options);
  await adopt(entry, localGraph);
}
