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
import { clearVaultConfig, getVaultConfig, rotateVaultToken, setVaultConfig } from "../utils/remoteSyncEngine";
import { decodePairingCode, encodePairingCode } from "../utils/pairingCode";
import { PairingQr, PairingScanner } from "./PairingQr";
import { copyText } from "../utils/clipboard";

/**
 * Pairing/unpairing switches which graph the whole app reads from
 * (usePrivateNuri.ts) — a full reload is the simplest way to get every
 * `useShape` subscription to restart scoped to the new graph.
 */
async function applyAndReload(vaultId: string, vaultToken: string) {
  await setVaultConfig(vaultId, vaultToken);
  window.location.reload();
}

export function SyncSettings() {
  const config = getVaultConfig();
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [showPairingCode, setShowPairingCode] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  // Keyed by which control was pressed, not a boolean. One flag for two Copy
  // buttons meant copying the temporary code also reported success under the
  // pairing code - and replaced its "anyone with this code can read and write
  // this vault" warning with "Copied." for two seconds.
  const [copied, setCopied] = useState<"" | "pairing" | "temporary">("");
  const [copyFailed, setCopyFailed] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | undefined>();
  const [generatingTemporary, setGeneratingTemporary] = useState(false);
  const [temporaryCode, setTemporaryCode] = useState<string>();
  const [temporaryExpiresAt, setTemporaryExpiresAt] = useState<string>();

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
      await applyAndReload(created.vaultId, created.vaultToken);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not reach the sync server - check that it's running (see secrets.md).",
      );
      setCreating(false);
    }
  }

  async function join(vaultId: string, vaultToken: string) {
    setJoining(true);
    setError(undefined);
    try {
      await applyAndReload(vaultId, vaultToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join the vault.");
      setJoining(false);
    }
  }

  async function handleCodeJoin() {
    if (!joinCode.trim()) return;
    try {
      if (joinCode.trim().toUpperCase().startsWith("PAIR")) {
        setJoining(true);
        setError(undefined);
        const response = await fetch("/sync/pair-redeem", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: joinCode }),
        });
        const body = (await response.json()) as {
          vaultId?: string;
          vaultToken?: string;
          reason?: string;
        };
        if (!response.ok || !body.vaultId || !body.vaultToken) {
          throw new Error(body.reason ?? `Pairing failed with status ${response.status}.`);
        }
        // Redemption is deliberately one-shot. Preserve the returned durable
        // credential in the field before fetching the initial snapshot, so a
        // transient snapshot failure can be retried without issuing a new code.
        setJoinCode(encodePairingCode(body.vaultId, body.vaultToken));
        try {
          await applyAndReload(body.vaultId, body.vaultToken);
        } catch {
          throw new Error(
            "The temporary code was redeemed, but the vault could not be loaded. " +
              "Retry with the durable pairing code now shown.",
          );
        }
        return;
      }
      const credentials = decodePairingCode(joinCode);
      await join(credentials.vaultId, credentials.vaultToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That pairing code is not valid.");
      setJoining(false);
    }
  }

  async function handleGenerateTemporary() {
    if (!config) return;
    setGeneratingTemporary(true);
    setRotateError(undefined);
    try {
      const response = await fetch(`/sync/pair-code?vault=${encodeURIComponent(config.vaultId)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.vaultToken}` },
      });
      const body = (await response.json()) as { code?: string; expiresAt?: string; reason?: string };
      if (!response.ok || !body.code || !body.expiresAt) {
        throw new Error(body.reason ?? `Temporary code request failed with status ${response.status}.`);
      }
      setTemporaryCode(body.code);
      setTemporaryExpiresAt(body.expiresAt);
    } catch (err) {
      setRotateError(err instanceof Error ? err.message : "Could not create a temporary pair code.");
    } finally {
      setGeneratingTemporary(false);
    }
  }

  async function handleRotate() {
    if (
      !window.confirm(
        "Generate a new pairing code? The old code stops working immediately - every other " +
          "device paired to this vault will need the new code before it can sync again.",
      )
    ) {
      return;
    }
    setRotating(true);
    setRotateError(undefined);
    try {
      await rotateVaultToken();
      window.location.reload();
    } catch (err) {
      setRotateError(
        err instanceof Error ? err.message : "Could not rotate the token - check that the sync server is running.",
      );
      setRotating(false);
    }
  }

  function handleLeave() {
    if (!window.confirm("Stop syncing this device? Records stay in this browser but won't sync anymore.")) {
      return;
    }
    clearVaultConfig();
    window.location.reload();
  }

  async function handleCopy(text: string, which: "pairing" | "temporary") {
    if (await copyText(text)) {
      setCopyFailed(false);
      setCopied(which);
      setTimeout(() => setCopied(""), 2000);
      return;
    }
    setCopied("");
    setCopyFailed(true);
  }

  if (config) {
    // A stored credential that cannot be encoded must not take the page down
    // with it: Settings is where someone would go to repair or leave a vault,
    // so throwing here would remove the only way out.
    let pairingCode = "";
    let pairingCodeError = "";
    try {
      pairingCode = encodePairingCode(config.vaultId, config.vaultToken);
    } catch (caught) {
      pairingCodeError = caught instanceof Error
        ? caught.message
        : "This vault's stored credential could not be read.";
    }
    return (
      <section className="panel" id="sync">
        <div className="panel-header">
          <div>
            <p className="label-accent">Sync</p>
            <h2 className="title">Remote sync</h2>
          </div>
          <span className="badge">Connected</span>
        </div>
        <p className="helper-text">
          This device syncs continuously with the server. Paste this pairing code into
          Settings on another device to connect it to the same vault.
        </p>
        <div className="field-group">
          <label className="field-label" htmlFor="sync-pairing-code">
            Pairing code
          </label>
          <div className="layout-row">
            <textarea
              id="sync-pairing-code"
              className="input"
              readOnly
              rows={showPairingCode ? 3 : 1}
              value={showPairingCode ? pairingCode : "••••••••••••••••••••••••••••••••"}
            />
            <button type="button" className="secondary-btn" onClick={() => setShowPairingCode((value) => !value)}>
              {showPairingCode ? "Hide" : "Show"}
            </button>
            <button
              type="button"
              className="secondary-btn"
              aria-label="Copy pairing code"
              onClick={() => void handleCopy(pairingCode, "pairing")}
            >
              {copied === "pairing" ? "Copied" : "Copy"}
            </button>
          </div>
          {/* The warning stays put. It used to be replaced by "Copied.", so the
              one moment someone was about to send this code elsewhere was the
              moment the page stopped saying what it grants. */}
          <p className="helper-text">
            Anyone with this code can read and write this vault — share it only with your
            own devices.
          </p>
          {copyFailed && (
            <p className="helper-text danger-text" role="alert">
              This browser would not let the page copy for you. Select the code and copy it
              by hand.
            </p>
          )}
        </div>
        {pairingCodeError && (
          <p className="helper-text danger-text" role="alert">
            {pairingCodeError} You can still leave this vault or rotate its token.
          </p>
        )}
        {showPairingCode && pairingCode !== "" && <PairingQr value={pairingCode} />}
        <div className="field-group">
          <button
            type="button"
            className="secondary-btn"
            onClick={handleGenerateTemporary}
            disabled={generatingTemporary}
          >
            {generatingTemporary ? "Creating temporary code…" : "Create temporary code"}
          </button>
          <p className="helper-text">
            For a device elsewhere: this short code expires after 10 minutes and works once.
          </p>
          {temporaryCode && (
            <div className="layout-row">
              <input className="input" aria-label="Temporary pair code" readOnly value={temporaryCode} />
              <button
                type="button"
                className="secondary-btn"
                aria-label="Copy temporary pair code"
                onClick={() => void handleCopy(temporaryCode, "temporary")}
              >
                {copied === "temporary" ? "Copied" : "Copy"}
              </button>
            </div>
          )}
          {temporaryExpiresAt && (
            <p className="helper-text">
              Expires at {new Date(temporaryExpiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
            </p>
          )}
        </div>
        {rotateError && <p className="helper-text danger-text">{rotateError}</p>}
        <div className="layout-row">
          <button type="button" className="secondary-btn" onClick={handleRotate} disabled={rotating}>
            {rotating ? "Rotating…" : "Rotate pairing code"}
          </button>
          <button type="button" className="secondary-btn danger-text" onClick={handleLeave}>
            Leave vault
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="panel" id="sync">
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
          <label className="field-label" htmlFor="join-pairing-code">
            Pairing code
          </label>
          <textarea
            id="join-pairing-code"
            className="input"
            rows={3}
            value={joinCode}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="LG1-…"
            onChange={(event) => setJoinCode(event.target.value)}
          />
          <p className="helper-text">
            Paste the pairing code shown on a device already in the vault. A temporary
            PAIR- code from that device also works, once, within ten minutes.
          </p>
        </div>
        <button
          type="button"
          className="secondary-btn"
          onClick={handleCodeJoin}
          disabled={joining || !joinCode.trim()}
        >
          {joining ? "Joining…" : "Join vault"}
        </button>
        <PairingScanner onCode={setJoinCode} />
      </div>
    </section>
  );
}
