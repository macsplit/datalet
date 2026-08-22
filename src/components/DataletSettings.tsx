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
import { listDatalets, setDataletArchived, type Datalet } from "../utils/datalets";
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
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState("");

  // Re-checked on a timer rather than once per render: the commonest refusal
  // is a queued outbox, which clears itself moments later as the changes sync.
  // Evaluated only at render, the panel would stay refused with nothing to act
  // on and no way forward short of reloading.
  const [leaving, setLeaving] = useState(() => canLeaveActiveDatalet());
  useEffect(() => {
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
        Each datalet is a separate set of records, schemas and screens. One is open at a
        time; the others live in their vaults until you open them. Because only the open
        one is held in this browser, every datalet you keep has to be paired — a datalet
        with no vault has no other copy to come back from.
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
            {archived.map((entry) => renderRow(entry))}
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
            To start a datalet from a backup file, add an empty one and then use
            <strong> Import backup</strong> below, which fills whichever datalet is open.
          </p>
          <p className="helper-text">
            An <strong>LG1</strong> or <strong>PAIR</strong> code opens the same datalet
            here as well, so edits made in either place meet. A <strong>COPY</strong> code
            makes a new datalet of your own from someone else's — from then on the two are
            unrelated, and nothing you do reaches theirs.
          </p>
        </div>
      </div>
    </section>
  );
}
