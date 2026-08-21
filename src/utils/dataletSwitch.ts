/**
 * Moving between datalets.
 *
 * Only the active datalet is resident, so a switch is a restore followed by an
 * eviction - in that order, always, because the reverse would leave the old
 * one gone and the new one unfetched. The rules that refuse a switch are here
 * rather than in the UI, so no future caller can route around them.
 */

import { evictGraph } from "./localNgEngine";
import { pendingOutboxCount, restoreDatalet } from "./remoteSyncEngine";
import { activeDatalet, dataletGraph, setActiveDatalet, type Datalet } from "./datalets";

export type SwitchRefusal =
  | { ok: false; reason: "unpaired"; message: string }
  | { ok: false; reason: "pending"; message: string }
  | { ok: false; reason: "unknown-target"; message: string };

export type SwitchCheck = { ok: true } | SwitchRefusal;

/**
 * Whether the datalet in use can be left. Separated from the switch itself so
 * the UI can explain the answer before anyone commits to it.
 */
export function canLeaveActiveDatalet(): SwitchCheck {
  const active = activeDatalet();
  if (!active) return { ok: true };
  if (!active.vault) {
    return {
      ok: false,
      reason: "unpaired",
      message:
        "This datalet is not paired, so there is no copy anywhere else. Pair it before "
        + "switching away, or its records would be lost.",
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

/**
 * Switch, or throw with a message worth showing. Reloads on success, because
 * replacing the whole graph is simpler and more robust than re-targeting every
 * live subscription - the same reason pairing and import reload.
 */
export async function switchToDatalet(target: Datalet, localGraph: string | undefined) {
  const leaving = canLeaveActiveDatalet();
  if (!leaving.ok) throw new Error(leaving.message);
  if (!target.vault) {
    throw new Error("That datalet has no vault to restore from.");
  }

  const active = activeDatalet();
  const activeGraph = active ? dataletGraph(active, localGraph) : undefined;

  // Restore first. A failure here must leave the current datalet untouched.
  await restoreDatalet(target.vault);

  const targetGraph = dataletGraph(target, localGraph);
  if (activeGraph && activeGraph !== targetGraph) evictGraph(activeGraph);
  setActiveDatalet(target.id);
  window.location.reload();
}
