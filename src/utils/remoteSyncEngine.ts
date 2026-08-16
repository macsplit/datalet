// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Continuous background sync against the server implemented in `server/`.
 * A no-op unless a sync vault has been paired (see the Settings page) — the
 * app is fully local-only until then, exactly as it was before this module
 * existed. See docs/remote-sync-architecture.md for the design this
 * implements.
 */

import {
  applyRemoteSyncPatches,
  flushLocalPersistence,
  onLocalPatch,
  reconcileGraphSnapshot,
  type Patch,
  type Store,
} from "./localNgEngine";
import { dismissRuntimeIssue, reportRuntimeIssue } from "./runtimeHealth";
import { randomUuid } from "./randomId";

const CONFIG_KEY = "meta-ui-builder:sync-vault";
const CURSOR_PREFIX = "meta-ui-builder:sync-cursor:";
const OUTBOX_PREFIX = "meta-ui-builder:sync-outbox:";
const HLC_KEY = "meta-ui-builder:sync-hlc";
const APPLIED_BATCH_RING = 512;

export type VaultConfig = { vaultId: string; vaultToken: string; nodeId: string };

type OutboxEntry = { batchId: string; hlc: string; shape: string; patches: Patch[] };
type PatchResponse = {
  acceptedCount?: number;
  submittedCount?: number;
  reason?: string;
};

function readJson<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function getVaultConfig(): VaultConfig | undefined {
  return readJson<VaultConfig>(CONFIG_KEY);
}

async function fetchAndReconcileSnapshot(config: VaultConfig, flushImmediately = false) {
  const response = await fetch(`/sync/snapshot?vault=${encodeURIComponent(config.vaultId)}`, {
    headers: { Authorization: `Bearer ${config.vaultToken}` },
  });
  if (!response.ok) throw new Error(`snapshot request failed with status ${response.status}`);
  const snapshot = (await response.json()) as { seq: number; records: Store };
  const graph = `did:ng:${config.vaultId}`;
  if (!reconcileGraphSnapshot(graph, snapshot.records)) {
    throw new Error("snapshot failed local validation");
  }
  if (flushImmediately) flushLocalPersistence();
  setCursor(config.vaultId, snapshot.seq);
}

/** Validate and prime a vault locally before the caller reloads into its graph. */
export async function setVaultConfig(vaultId: string, vaultToken: string) {
  const config: VaultConfig = { vaultId, vaultToken, nodeId: randomUuid() };
  // A joining browser must have the remote records on disk before reload.
  // Otherwise providers can bootstrap defaults before the asynchronous sync
  // connection delivers its first snapshot, creating a newer conflicting edit.
  await fetchAndReconcileSnapshot(config, true);
  writeJson(CONFIG_KEY, config);
  return config;
}

/**
 * Requests a fresh token for the currently configured vault, invalidating
 * the old one server-side immediately (server/src/vaultStore.ts's
 * rotateVaultToken). Persists it and reconnects the live stream with the
 * new token; callers still need a full reload if they want the token
 * displayed anywhere in the UI to reflect the new value (see
 * SyncSettings.tsx, which reloads after calling this - same pattern as
 * create/join/leave).
 */
export async function rotateVaultToken(): Promise<string> {
  const config = getVaultConfig();
  if (!config) throw new Error("no vault is configured");
  const response = await fetch(`/sync/vaults/rotate?vault=${encodeURIComponent(config.vaultId)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.vaultToken}` },
  });
  if (!response.ok) throw new Error(`rotate failed with status ${response.status}`);
  const { vaultToken } = (await response.json()) as { vaultToken: string };
  writeJson(CONFIG_KEY, { ...config, vaultToken });
  if (started) void connectStream({ ...config, vaultToken });
  return vaultToken;
}

export function clearVaultConfig() {
  const config = getVaultConfig();
  stopSync();
  localStorage.removeItem(CONFIG_KEY);
  if (config) {
    localStorage.removeItem(CURSOR_PREFIX + config.vaultId);
    localStorage.removeItem(OUTBOX_PREFIX + config.vaultId);
  }
}

function nextHlc(nodeId: string): string {
  const previous = readJson<{ lastMs: number; counter: number }>(HLC_KEY) ?? { lastMs: 0, counter: 0 };
  const now = Date.now();
  const next =
    now > previous.lastMs ? { lastMs: now, counter: 0 } : { lastMs: previous.lastMs, counter: previous.counter + 1 };
  writeJson(HLC_KEY, next);
  // Fixed-width fields make this lexicographically sortable, which is what
  // the server relies on to compare HLCs with a plain string >= (see
  // server/src/vaultStore.ts). The nodeId suffix breaks ties between two
  // nodes that mint a patch in the same millisecond at the same counter.
  return `${String(next.lastMs).padStart(15, "0")}-${String(next.counter).padStart(6, "0")}-${nodeId}`;
}

function loadOutbox(vaultId: string): OutboxEntry[] {
  return readJson<OutboxEntry[]>(OUTBOX_PREFIX + vaultId) ?? [];
}

function saveOutbox(vaultId: string, entries: OutboxEntry[]) {
  writeJson(OUTBOX_PREFIX + vaultId, entries);
}

function cursorKey(vaultId: string) {
  return CURSOR_PREFIX + vaultId;
}

function getCursor(vaultId: string): number {
  return Number(localStorage.getItem(cursorKey(vaultId)) ?? 0);
}

function setCursor(vaultId: string, seq: number) {
  localStorage.setItem(cursorKey(vaultId), String(seq));
}

let unsubscribeLocalPatches: (() => void) | undefined;
let eventSource: EventSource | undefined;
let streamConnectGeneration = 0;
let flushing = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushBackoffMs = 1_000;
const MAX_FLUSH_BACKOFF_MS = 30_000;

// EventSource retries natively (typically every few seconds) after any
// drop, so a bare "error" event fires on ordinary transient blips too -
// warning the user on every one of those would be noise, not signal. Only
// surface a banner if the connection hasn't recovered within this window;
// clear it the moment "open" fires again. This is a separate, deliberately
// silent path from resyncFromSnapshot's failure reporting below - a lost
// connection isn't itself an error condition on its own (edits still queue
// locally and flush once reconnected), it only becomes worth surfacing if
// it persists.
const SYNC_DOWN_WARNING_DELAY_MS = 15_000;
let syncDownTimer: ReturnType<typeof setTimeout> | undefined;
let syncDownWarningId: string | undefined;

function clearSyncDownWarning() {
  if (syncDownTimer !== undefined) {
    clearTimeout(syncDownTimer);
    syncDownTimer = undefined;
  }
  if (syncDownWarningId !== undefined) {
    dismissRuntimeIssue(syncDownWarningId);
    syncDownWarningId = undefined;
  }
}

const appliedBatchIds: string[] = [];
const appliedBatchIdSet = new Set<string>();

function rememberApplied(batchId: string) {
  if (appliedBatchIdSet.has(batchId)) return;
  appliedBatchIdSet.add(batchId);
  appliedBatchIds.push(batchId);
  if (appliedBatchIds.length > APPLIED_BATCH_RING) {
    const evicted = appliedBatchIds.shift();
    if (evicted) appliedBatchIdSet.delete(evicted);
  }
}

async function flushOutbox(config: VaultConfig) {
  if (flushing) return;
  flushing = true;
  try {
    let queue = loadOutbox(config.vaultId);
    while (queue.length > 0) {
      const entry = queue[0];
      let response: Response;
      try {
        response = await fetch(`/sync/patches?vault=${encodeURIComponent(config.vaultId)}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.vaultToken}`,
          },
          body: JSON.stringify({
            nodeId: config.nodeId,
            batchId: entry.batchId,
            hlc: entry.hlc,
            shape: entry.shape,
            patches: entry.patches,
          }),
        });
      } catch {
        break; // offline or unreachable — stop, retry on the next scheduled flush
      }

      if (response.status === 401) {
        reportRuntimeIssue(
          "This device's sync vault token was rejected by the server.",
          "Remote sync paused",
          "error",
        );
        return;
      }

      // Rejections are terminal under field-level LWW, but no longer silent:
      // the response counts cover both an all-rejected 409 and patches dropped
      // from an otherwise accepted batch.
      if (response.ok || response.status === 409) {
        const result = await response.json().catch(() => ({})) as PatchResponse;
        const submittedCount = Number.isFinite(result.submittedCount)
          ? Math.max(0, Number(result.submittedCount))
          : entry.patches.length;
        const acceptedCount = response.status === 409
          ? 0
          : Number.isFinite(result.acceptedCount)
            ? Math.max(0, Number(result.acceptedCount))
            : submittedCount;
        const droppedCount = Math.max(0, submittedCount - acceptedCount);
        if (droppedCount > 0) {
          const reason = result.reason || "superseded by a newer remote value";
          reportRuntimeIssue(
            `${droppedCount} of ${submittedCount} local ${submittedCount === 1 ? "change was" : "changes were"} not applied: ${reason}.`,
            "Remote sync discarded changes",
            "warning",
          );
        }
        rememberApplied(entry.batchId);
        queue = queue.slice(1);
        saveOutbox(config.vaultId, queue);
        flushBackoffMs = 1_000;
        continue;
      }
      break;
    }
  } finally {
    flushing = false;
  }
  if (loadOutbox(config.vaultId).length > 0) scheduleFlush(config, flushBackoffMs);
}

function scheduleFlush(config: VaultConfig, delayMs = 0) {
  if (flushTimer !== undefined) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flushBackoffMs = Math.min(flushBackoffMs * 2, MAX_FLUSH_BACKOFF_MS);
    void flushOutbox(config);
  }, delayMs);
}

async function resyncFromSnapshot(config: VaultConfig) {
  try {
    await fetchAndReconcileSnapshot(config);
    void flushOutbox(config);
    void connectStream(config);
  } catch (error) {
    reportRuntimeIssue(error, "Remote sync snapshot resync failed", "warning");
    scheduleReconnect(config);
  }
}

let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleReconnect(config: VaultConfig, delayMs = 5_000) {
  if (reconnectTimer !== undefined) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connectStream(config);
  }, delayMs);
}

async function connectStream(config: VaultConfig) {
  const generation = ++streamConnectGeneration;
  eventSource?.close();
  let ticket: string;
  try {
    const response = await fetch(
      `/sync/stream-ticket?vault=${encodeURIComponent(config.vaultId)}`,
      { method: "POST", headers: { Authorization: `Bearer ${config.vaultToken}` } },
    );
    if (!response.ok) throw new Error(`stream ticket request failed with status ${response.status}`);
    ticket = ((await response.json()) as { ticket: string }).ticket;
  } catch {
    if (generation === streamConnectGeneration && started) {
      if (syncDownTimer === undefined && syncDownWarningId === undefined) {
        syncDownTimer = setTimeout(() => {
          syncDownTimer = undefined;
          syncDownWarningId = reportRuntimeIssue(
            "Changes made on this device are still being saved locally and will sync automatically once the connection returns.",
            "Remote sync connection lost",
            "warning",
          );
        }, SYNC_DOWN_WARNING_DELAY_MS);
      }
      scheduleReconnect(config);
    }
    return;
  }
  if (generation !== streamConnectGeneration || !started) return;
  const since = getCursor(config.vaultId);
  const url =
    `/sync/stream?vault=${encodeURIComponent(config.vaultId)}` +
    `&since=${since}&ticket=${encodeURIComponent(ticket)}`;
  const source = new EventSource(url);
  eventSource = source;

  source.addEventListener("open", clearSyncDownWarning);
  source.addEventListener("error", () => {
    if (syncDownTimer !== undefined || syncDownWarningId !== undefined) return;
    syncDownTimer = setTimeout(() => {
      syncDownTimer = undefined;
      syncDownWarningId = reportRuntimeIssue(
        "Changes made on this device are still being saved locally and will sync automatically once the connection returns.",
        "Remote sync connection lost",
        "warning",
      );
    }, SYNC_DOWN_WARNING_DELAY_MS);
    scheduleReconnect(config);
  });

  source.addEventListener("patches", (event) => {
    const message = event as MessageEvent<string>;
    try {
      const entry = JSON.parse(message.data) as {
        seq: number;
        batchId: string;
        nodeId: string;
        shape: string;
        patches: Patch[];
      };
      if (entry.nodeId !== config.nodeId && !appliedBatchIdSet.has(entry.batchId)) {
        applyRemoteSyncPatches(entry.patches, entry.shape);
      }
      rememberApplied(entry.batchId);
      setCursor(config.vaultId, entry.seq);
    } catch (error) {
      reportRuntimeIssue(error, "A remote sync update was stopped");
    }
  });

  source.addEventListener("resync", () => {
    source.close();
    void resyncFromSnapshot(config);
  });
  // EventSource retries natively, while scheduleReconnect also obtains a
  // fresh short-lived stream ticket in case the previous one expired.
}

function enqueueOutbound(config: VaultConfig, patches: Patch[], shape: string) {
  const entry: OutboxEntry = {
    batchId: randomUuid(),
    hlc: nextHlc(config.nodeId),
    shape,
    patches,
  };
  const queue = loadOutbox(config.vaultId);
  queue.push(entry);
  saveOutbox(config.vaultId, queue);
  scheduleFlush(config);
}

let started = false;

/** Start (or restart) continuous sync if a vault is configured. Safe to call more than once. */
export function startSync() {
  const config = getVaultConfig();
  if (!config) return;
  if (started) stopSync();
  started = true;

  unsubscribeLocalPatches = onLocalPatch((patches, shape) => {
    enqueueOutbound(config, patches, shape);
  });
  void connectStream(config);
  if (loadOutbox(config.vaultId).length > 0) scheduleFlush(config);

  window.addEventListener("online", onOnline);
}

function onOnline() {
  const config = getVaultConfig();
  if (!config) return;
  flushBackoffMs = 1_000;
  scheduleFlush(config, 0);
  void connectStream(config);
}

export function stopSync() {
  started = false;
  unsubscribeLocalPatches?.();
  unsubscribeLocalPatches = undefined;
  eventSource?.close();
  eventSource = undefined;
  streamConnectGeneration += 1;
  clearSyncDownWarning();
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = undefined;
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  window.removeEventListener("online", onOnline);
}
