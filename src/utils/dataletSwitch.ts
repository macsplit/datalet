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
  graphHasOnlyKnownBootstrapRecords,
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
  type VaultSnapshot,
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
import { HOME_TAB_ID } from "../hooks/useTabs";

// The only two records the app ever writes into a fresh graph on its own,
// unprompted - see graphHasOnlyKnownBootstrapRecords's own doc comment.
const BOOTSTRAP_ONLY_IDS = [SETTINGS_ID, HOME_TAB_ID];

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
 *
 * `localGraph` lets the vault-less branch tell "nothing written yet" apart
 * from "this browser's own work, unsynced." `ensureLocalDatalet()` creates a
 * vault-less local entry eagerly - before anyone has done anything with the
 * app at all, including on the very first visit a shared link is opened on -
 * and the app then writes a default Settings record and Home tab into
 * whatever graph is active within moments of rendering anything at all, so
 * checking for zero records (`graphFootprint`) would still refuse: those two
 * writes happen unprompted, on every device, whether or not anyone does
 * anything else. `graphHasOnlyKnownBootstrapRecords` looks past exactly
 * those two, not at whether the graph is literally empty. Omitting
 * `localGraph` (or its graph being unresolved) stays conservative and
 * refuses, same as before this existed.
 */
export function canLeaveActiveDatalet(localGraph?: string): SwitchCheck {
  const active = activeDatalet();
  if (!active) return { ok: true };
  if (!active.vault) {
    const graph = dataletGraph(active, localGraph);
    const nothingToProtect = graph !== undefined && graphHasOnlyKnownBootstrapRecords(graph, BOOTSTRAP_ONLY_IDS);
    if (!nothingToProtect) {
      return {
        ok: false,
        reason: "unpaired",
        message:
          "This datalet is only in this browser, so there is no copy anywhere else. Set up "
          + "sync for it before adding or opening another, or its records would be lost.",
      };
    }
    return { ok: true };
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

/**
 * `/sync/snapshot`'s `records` come from Neo4j, materialized asynchronously
 * from the same accepted writes that bump `seq` in Redis immediately - a
 * vault created moments ago (a fresh clone especially) can report a nonzero
 * `seq` before the materializer has caught up, and come back with zero
 * records even though real data was genuinely accepted. `seq === 0` means a
 * genuinely empty vault and is trusted immediately.
 *
 * `seq > 0` used to be retried only until `records` was non-empty - correct
 * for a small vault, wrong at scale: materialization is incremental, not
 * atomic. A 2,000-record clone measured directly against a real
 * materializer showed 25 records visible at 5s and the full 2,000 only at
 * 11.5s - stopping at "non-empty" would have silently adopted a datalet
 * missing 99% of its records, with no error and no sign anything was wrong.
 * `materializerLag`/`materializerPending` (from the server's own consumer-
 * group backlog, the same numbers `vaultStats` already reported) are the
 * real "is this actually finished" signal instead: both `0` means caught
 * up, `null` means no consumer group yet - not started, not done - and an
 * old server that doesn't send these fields at all falls back to the
 * previous best-effort record-presence check rather than retrying forever.
 *
 * The server discovers a newly created vault's stream on a 3-second poll
 * (`VAULT_DISCOVERY_INTERVAL_MS`), so a vault created moments after a cycle
 * fired waits nearly the full 3s before the materializer even starts on it,
 * before any replay time on top - and that offset is essentially random per
 * clone, adding jitter on top of a record count's own replay time rather
 * than a fixed cost. Measured directly against a freshly deployed instance:
 * a handful of records took ~6s end to end; 2,000 records took ~11.5s of
 * replay alone, consistent across repeated runs, but a real end-to-end
 * clone-and-join at that same size sometimes exceeded a 15s budget - the
 * discovery jitter, not the replay time, was what made it inconsistent.
 * The tail settles to 3s steps, matching that discovery cadence, rather
 * than continuing to grow exponentially past the point where finer steps
 * stop helping; the full budget (~27s) gives real margin over 2,000
 * records' ~11.5s replay plus up to ~3s of discovery jitter, not just
 * enough to clear it on a lucky run.
 */
function materializerCaughtUp(snapshot: VaultSnapshot): boolean {
  if (snapshot.materializerLag === undefined || snapshot.materializerPending === undefined) {
    return Object.keys(snapshot.records).length > 0;
  }
  return snapshot.materializerLag === 0 && snapshot.materializerPending === 0;
}

async function fetchVaultSnapshotSettled(vault: VaultConfig): Promise<VaultSnapshot> {
  const backoffMs = [200, 400, 800, 1600, 3000, 3000, 3000, 3000, 3000, 3000, 3000, 3000];
  let snapshot = await fetchVaultSnapshot(vault);
  for (const delay of backoffMs) {
    if (snapshot.seq === 0 || materializerCaughtUp(snapshot)) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    snapshot = await fetchVaultSnapshot(vault);
  }
  return snapshot;
}

async function adopt(
  target: Datalet,
  localGraph: string | undefined,
  freshlyAdopted = false,
  beforeReload?: () => void,
) {
  if (!target.vault) throw new Error("That datalet has no vault to open from.");
  const active = activeDatalet();
  const leaving = active && active.id !== target.id ? dataletGraph(active, localGraph) : undefined;
  const targetGraph = dataletGraph(target, localGraph);
  if (!targetGraph) throw new Error("This device is still starting up; try again in a moment.");

  // Fetch first: a failure here must leave the current datalet exactly as it
  // was. Only a freshly adopted vault gets the settling retry: a vault
  // already resident in this browser's registry has had plenty of time to
  // materialize, so a nonzero seq with no records there is far more likely
  // to mean "everything in it was deleted" than "not there yet" - retrying
  // that case would just delay every reopen of a legitimately emptied vault.
  const snapshot = freshlyAdopted
    ? await fetchVaultSnapshotSettled(target.vault)
    : await fetchVaultSnapshot(target.vault);

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
  // Only reached once every check above has already passed - the one point
  // a caller can safely move the address bar ahead of the reload it's about
  // to trigger. Called any earlier (e.g. before this function even runs) and
  // a subsequent failure throws from a page a router history-listener has
  // already navigated its own component away from, silently swallowing the
  // error instead of showing it - see JoinPage.tsx for the incident this
  // guards against.
  beforeReload?.();
  window.location.reload();
}

/**
 * Open a datalet already in the registry. Reloads on success, because
 * replacing the whole graph is simpler and more robust than re-targeting every
 * live subscription - the same reason pairing and import reload.
 */
export async function switchToDatalet(target: Datalet, localGraph: string | undefined) {
  ensureLocalDatalet();
  const leaving = canLeaveActiveDatalet(localGraph);
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
  options: { copiedAt?: number; beforeReload?: () => void } = {},
) {
  // Before the guard, not after. The registry was only ever written when a
  // vault was configured, so a browser that had never paired had no entry at
  // all - `canLeaveActiveDatalet` then found nothing to protect and said yes,
  // and adding a datalet stranded the local one's records in a graph nothing
  // pointed at. The rule was right; it just had nothing to apply to.
  //
  // ensureLocalDatalet() creates "this device"'s own registry entry the
  // moment it first runs, which for a browser with no registry yet is right
  // here, not before - a caller that read canLeaveActiveDatalet() earlier
  // (to decide whether to enable a button, say) was reading a registry that
  // did not have this entry in it yet. Passing `localGraph` through both
  // checks keeps them in agreement on a genuinely empty local datalet
  // (nothing written, so nothing to protect either way); they can still
  // legitimately disagree if real local content was written in between.
  ensureLocalDatalet();
  const leaving = canLeaveActiveDatalet(localGraph);
  if (!leaving.ok) throw new Error(leaving.message);
  const entry = addDatalet(vault, options);
  await adopt(entry, localGraph, true, options.beforeReload);
}
