// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { useEffect, useState } from "react";
import { useSettings } from "../hooks/useSettings";
import usePrivateNuri from "./usePrivateNuri";
import { ensureLocalDatalet, listDatalets, setDataletArchived, type Datalet } from "../utils/datalets";
import { removeDataletPermanently } from "../utils/dataletRemoval";
import {
  adoptVaultAsDatalet,
  canLeaveActiveDatalet,
  switchToDatalet,
} from "../utils/dataletSwitch";
import { decodePairingCode } from "../utils/pairingCode";
import { randomUuid } from "../utils/randomId";

/**
 * What to call a datalet in the list.
 *
 * Every row is named the same way, by its title, rather than the active one
 * being named and the rest reduced to `Vault 1586f18f` - which asked someone
 * to recognise their own work by a hash. The active title comes from the live
 * `Settings`; the others come from what was recorded while they were last
 * open. A datalet added before that was recorded, or one whose title is
 * genuinely blank, still has no name to show, so it says so rather than
 * pretending the vault id is one.
 *
 * The vault id is kept alongside rather than dropped: two datalets may share a
 * title, and it is the only thing that never does.
 */
function dataletName(entry: Datalet, isActive: boolean, activeTitle: string): string {
  if (isActive) return activeTitle;
  if (entry.title) return entry.title;
  if (entry.vault) return "Untitled datalet";
  return "This device";
}

export function DataletSettings() {
  const { appTitle } = useSettings();
  const privateNuri = usePrivateNuri();
  const { entries, archived, activeId } = listDatalets();
  const [, forceRender] = useState(0);
  const [removing, setRemoving] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [erasing, setErasing] = useState(false);
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState("");

  // Re-checked on a timer rather than once per render: the commonest refusal
  // is a queued outbox, which clears itself moments later as the changes sync.
  // Evaluated only at render, the panel would stay refused with nothing to act
  // on and no way forward short of reloading.
  const [leaving, setLeaving] = useState(() => canLeaveActiveDatalet());
  useEffect(() => {
    // The local datalet has to be a registry entry before the guard is asked
    // about it, or the answer is "nothing to protect" and the controls offer
    // an action that will refuse itself on click.
    ensureLocalDatalet();
    setLeaving(canLeaveActiveDatalet());
    const timer = setInterval(() => setLeaving(canLeaveActiveDatalet()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const [adding, setAdding] = useState(false);
  const [joinCode, setJoinCode] = useState("");

  const adopt = async (
    work: () => Promise<{ vaultId: string; vaultToken: string; copiedAt?: number }>,
  ) => {
    setAdding(true);
    setError("");
    try {
      const { copiedAt, ...vault } = await work();
      await adoptVaultAsDatalet({ ...vault, nodeId: randomUuid() }, privateNuri, { copiedAt });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That datalet could not be added.");
      setAdding(false);
    }
  };

  const startEmpty = () => adopt(async () => {
    const response = await fetch("/sync/vaults", { method: "POST" });
    if (!response.ok) throw new Error(`The sync server answered with status ${response.status}.`);
    return (await response.json()) as { vaultId: string; vaultToken: string };
  });

  const joinFromCode = () => adopt(async () => {
    const code = joinCode.trim();
    if (code.toUpperCase().startsWith("COPY")) {
      // A copy code makes a new datalet from someone else's; it never grants
      // access to theirs. The server does the copying, so what comes back is
      // a vault of your own that happens to start out looking like theirs.
      const response = await fetch("/sync/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = (await response.json()) as
        { vaultId?: string; vaultToken?: string; reason?: string };
      if (!response.ok || !body.vaultId || !body.vaultToken) {
        throw new Error(body.reason ?? `That copy could not be made (status ${response.status}).`);
      }
      // Noted because a copy arrives carrying the source's own title, so two
      // identically named entries would otherwise be indistinguishable.
      return { vaultId: body.vaultId, vaultToken: body.vaultToken, copiedAt: Date.now() };
    }
    if (code.toUpperCase().startsWith("PAIR")) {
      const response = await fetch("/sync/pair-redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = (await response.json()) as
        { vaultId?: string; vaultToken?: string; reason?: string };
      if (!response.ok || !body.vaultId || !body.vaultToken) {
        throw new Error(body.reason ?? `Redeeming that code failed with status ${response.status}.`);
      }
      return { vaultId: body.vaultId, vaultToken: body.vaultToken };
    }
    return decodePairingCode(code);
  });

  const goTo = async (entry: Datalet) => {
    setSwitching(entry.id);
    setError("");
    try {
      await switchToDatalet(entry, privateNuri);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That datalet could not be opened.");
      setSwitching("");
    }
  };

  const setArchived = (entry: Datalet, archived: boolean) => {
    setDataletArchived(entry.id, archived);
    // The registry is localStorage, not React state, so nothing re-renders on
    // its own.
    forceRender((tick) => tick + 1);
  };

  const erase = async (entry: Datalet) => {
    setErasing(true);
    setError("");
    try {
      await removeDataletPermanently(entry);
      setRemoving("");
      setConfirmText("");
      forceRender((tick) => tick + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That datalet could not be erased.");
    } finally {
      setErasing(false);
    }
  };

  /**
   * The second step of removal, and the reason there is a second step.
   *
   * Erasure is not undoable and reaches a server, so this states what it does
   * and does not reach before asking for the name back. The list of what
   * survives is not hedging: someone erasing their data is entitled to know
   * precisely which copies this removes and which it cannot.
   */
  const renderRemoval = (entry: Datalet) => {
    const name = dataletName(entry, false, appTitle);
    return (
      <div className="datalet-remove" role="group" aria-label={`Remove ${name} permanently`}>
        <p className="danger-text">
          <strong>Erase this datalet? This cannot be undone.</strong>
        </p>
        <p className="helper-text">This removes:</p>
        <ul className="helper-text">
          <li>
            its vault on the sync server — every record in it, and the server's own
valid for 30 days
          </li>
          <li>this browser's record of it</li>
        </ul>
        <p className="helper-text">This cannot reach:</p>
        <ul className="helper-text">
          <li>copies anyone took with a <strong>COPY</strong> code — those became separate
            datalets and are not yours to erase</li>
          <li>another device that still has this datalet open or stored in its browser</li>
          <li>backup files you exported</li>
          <li>
            the sync server operator's own backups, which may keep a copy until they
            expire on whatever schedule that operator keeps
          </li>
        </ul>
        <div className="field-group">
          {/* Not `.field-label`: that uppercases, so the label read TYPE
              CONFERENCE NOTES while the check below is case-sensitive - it
              instructed you to type the one thing that would not work. */}
          <label className="field-label datalet-remove-label" htmlFor={`confirm-${entry.id}`}>
            {`Type ${name} to confirm`}
          </label>
          <input
            id={`confirm-${entry.id}`}
            className="input"
            value={confirmText}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setConfirmText(event.target.value)}
          />
        </div>
        <div className="layout-row">
          <button
            type="button"
            className="secondary-btn"
            disabled={erasing}
            onClick={() => { setRemoving(""); setConfirmText(""); }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="secondary-btn danger-text"
            disabled={erasing || confirmText.trim() !== name}
            onClick={() => void erase(entry)}
          >
            {erasing ? "Erasing…" : "Remove permanently"}
          </button>
        </div>
      </div>
    );
  };

  const renderRow = (entry: Datalet) => {
    const isActive = entry.id === activeId;
    const isArchived = entry.archivedAt !== undefined;
    return (
      <div className="layout-row" key={entry.id}>
        <span className="datalet-name">
          {dataletName(entry, isActive, appTitle)}
          {isActive && <span className="badge">Open</span>}
          {entry.vault && (
            <span className="helper-text datalet-vault-id">
              {` vault ${entry.vault.vaultId.slice(0, 8)}`}
            </span>
          )}
          {entry.copiedAt !== undefined && (
            <span className="helper-text">
              {` copied ${new Date(entry.copiedAt).toLocaleDateString()}`}
            </span>
          )}
        </span>
        {/* Both buttons in one child, because `.layout-row > *` gives every
            child a 360px basis that does not shrink: a third child overflows
            the panel instead of fitting. */}
        {!isActive && (
          <div className="datalet-row-actions">
            <button
              type="button"
              className="secondary-btn"
              disabled={!leaving.ok || switching !== "" || adding}
              onClick={() => void goTo(entry)}
            >
              {switching === entry.id ? "Opening…" : "Open"}
            </button>
            {/* The open datalet cannot be archived: that would be an eviction
                and a switch in one gesture, and would leave the app choosing
                where you land. */}
            <button
              type="button"
              className="secondary-btn"
              disabled={switching !== "" || adding}
              onClick={() => setArchived(entry, !isArchived)}
            >
              {isArchived ? "Restore" : "Archive"}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="panel" id="switch-datalet">
      <div className="panel-header">
        <div>
          <p className="label-accent">Datalets</p>
          <h2 className="title">Switch datalet</h2>
        </div>
      </div>
      <p className="helper-text">
        Each datalet is a separate set of records, schemas and screens. Only the one you
        have open is kept in this browser — the rest are stored on the sync server until
        you open them. A datalet that has never synced has no copy anywhere else, so
        syncing is what makes it safe to keep more than one.
      </p>
      {!leaving.ok && <p className="helper-text danger-text">{leaving.message}</p>}
      {error && <p className="danger-text" role="alert">{error}</p>}
      <div className="section-stack">
        {entries.map((entry) => renderRow(entry))}
      </div>

      {archived.length > 0 && (
        <details className="datalet-archive">
          <summary className="field-label datalet-archive-summary">
            {`Archived (${archived.length})`}
          </summary>
          <p className="helper-text">
            Put away, not deleted. Each one's vault and every record in it are
            untouched, and opening one brings it back to the list above.
          </p>
          {/* Its own stack, so the rows here are spaced exactly like the rows
              above rather than inheriting whatever the <details> does. */}
          <div className="section-stack">
            {archived.map((entry) => (
              <div key={entry.id}>
                {renderRow(entry)}
                {removing === entry.id
                  ? renderRemoval(entry)
                  : (
                    <button
                      type="button"
                      className="secondary-btn danger-text datalet-remove-start"
                      disabled={switching !== "" || adding}
                      onClick={() => { setRemoving(entry.id); setConfirmText(""); setError(""); }}
                    >
                      Remove permanently…
                    </button>
                  )}
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="section-stack">
        <p className="label-accent">Add a datalet</p>
        <div className="layout-row">
          <button
            type="button"
            className="secondary-btn"
            disabled={!leaving.ok || adding}
            onClick={() => void startEmpty()}
          >
            {adding ? "Working…" : "Start an empty one"}
          </button>
        </div>
        <div className="field-group">
          <label className="field-label" htmlFor="datalet-join-code">
            Or open one from a code
          </label>
          <div className="layout-row">
            <input
              id="datalet-join-code"
              className="input"
              value={joinCode}
              placeholder="LG1-… or COPY-…"
              spellCheck={false}
              autoCapitalize="characters"
              autoCorrect="off"
              onChange={(event) => setJoinCode(event.target.value)}
            />
            <button
              type="button"
              className="secondary-btn"
              disabled={!leaving.ok || adding || joinCode.trim() === ""}
              onClick={() => void joinFromCode()}
            >
              Add
            </button>
          </div>
          <p className="helper-text">
            Use an <strong>LG1</strong> or <strong>PAIR</strong> code to add an existing
            datalet to this device. A <strong>COPY</strong> code creates a separate datalet
            from someone else's data. The original and the copy remain independent.
          </p>
          <p className="helper-text">
            To start a datalet from a backup file, add an empty one and then use
            <strong> Import backup</strong> below.
          </p>
        </div>
      </div>
    </section>
  );
}
