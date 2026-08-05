// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { useState } from "react";
import { clearVaultConfig, getVaultConfig, setVaultConfig } from "../utils/remoteSyncEngine";

/**
 * Pairing/unpairing switches which graph the whole app reads from
 * (usePrivateNuri.ts) — a full reload is the simplest way to get every
 * `useShape` subscription to restart scoped to the new graph.
 */
function applyAndReload(vaultId: string, vaultToken: string) {
  setVaultConfig(vaultId, vaultToken);
  window.location.reload();
}

export function SyncSettings() {
  const config = getVaultConfig();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [showToken, setShowToken] = useState(false);
  const [joinVaultId, setJoinVaultId] = useState("");
  const [joinToken, setJoinToken] = useState("");
  const [copied, setCopied] = useState(false);

  async function handleCreate() {
    setCreating(true);
    setError(undefined);
    try {
      const response = await fetch("/sync/vaults", { method: "POST" });
      if (!response.ok) {
        // A 404 here almost always means there's no sync-server process
        // answering at all (the dev-only Vite proxy has nothing to forward
        // to, or a production deploy's reverse proxy has no upstream) -
        // say that plainly rather than surfacing a bare status code, since
        // "404" alone doesn't point anyone at the actual fix.
        throw new Error(
          response.status === 404
            ? "No sync server responded at /sync/vaults (got 404). If you're running locally, start it " +
              "with `pnpm dev:server` (see secrets.md) - `pnpm dev` alone only serves the app, not sync."
            : `Sync server responded with status ${response.status}.`,
        );
      }
      const created = (await response.json()) as { vaultId: string; vaultToken: string };
      applyAndReload(created.vaultId, created.vaultToken);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not reach the sync server - check that it's running (see secrets.md).",
      );
      setCreating(false);
    }
  }

  function handleJoin() {
    if (!joinVaultId.trim() || !joinToken.trim()) return;
    applyAndReload(joinVaultId.trim(), joinToken.trim());
  }

  function handleLeave() {
    if (!window.confirm("Stop syncing this device? Records stay in this browser but won't sync anymore.")) {
      return;
    }
    clearVaultConfig();
    window.location.reload();
  }

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — the value is
      // still visible for manual copy, so this is a silent no-op.
    }
  }

  if (config) {
    return (
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="label-accent">Sync</p>
            <h2 className="title">Remote sync</h2>
          </div>
          <span className="badge">Connected</span>
        </div>
        <p className="helper-text">
          This device syncs continuously with the server. Enter the same vault ID and
          token in Settings on another device to keep it in sync too.
        </p>
        <div className="field-group">
          <label className="field-label" htmlFor="sync-vault-id">
            Vault ID
          </label>
          <div className="layout-row">
            <input id="sync-vault-id" className="input" readOnly value={config.vaultId} />
            <button type="button" className="secondary-btn" onClick={() => handleCopy(config.vaultId)}>
              Copy
            </button>
          </div>
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor="sync-vault-token">
            Pairing token
          </label>
          <div className="layout-row">
            <input
              id="sync-vault-token"
              className="input"
              readOnly
              type={showToken ? "text" : "password"}
              value={config.vaultToken}
            />
            <button type="button" className="secondary-btn" onClick={() => setShowToken((v) => !v)}>
              {showToken ? "Hide" : "Show"}
            </button>
            <button type="button" className="secondary-btn" onClick={() => handleCopy(config.vaultToken)}>
              Copy
            </button>
          </div>
          <p className="helper-text">
            {copied ? "Copied." : "Anyone with this token can read and write this vault — share it only with your own devices."}
          </p>
        </div>
        <button type="button" className="secondary-btn danger-text" onClick={handleLeave}>
          Leave vault
        </button>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <p className="label-accent">Sync</p>
          <h2 className="title">Remote sync</h2>
        </div>
      </div>
      <p className="helper-text">
        Not connected. Data stays in this browser only. Create a vault to start syncing
        this device with others, or join a vault created elsewhere.
      </p>
      {error && <p className="helper-text danger-text">{error}</p>}
      <button type="button" className="primary-btn" onClick={handleCreate} disabled={creating}>
        {creating ? "Creating…" : "Create sync vault"}
      </button>
      <div className="section-stack">
        <p className="label-accent">Join an existing vault</p>
        <div className="field-group">
          <label className="field-label" htmlFor="join-vault-id">
            Vault ID
          </label>
          <input
            id="join-vault-id"
            className="input"
            value={joinVaultId}
            onChange={(e) => setJoinVaultId(e.target.value)}
          />
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor="join-vault-token">
            Pairing token
          </label>
          <input
            id="join-vault-token"
            className="input"
            value={joinToken}
            onChange={(e) => setJoinToken(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="secondary-btn"
          onClick={handleJoin}
          disabled={!joinVaultId.trim() || !joinToken.trim()}
        >
          Join vault
        </button>
      </div>
    </section>
  );
}
