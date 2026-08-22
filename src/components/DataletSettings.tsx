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
import { listDatalets, type Datalet } from "../utils/datalets";
import {
  adoptVaultAsDatalet,
  canLeaveActiveDatalet,
  switchToDatalet,
} from "../utils/dataletSwitch";
import { decodePairingCode } from "../utils/pairingCode";
import { randomUuid } from "../utils/randomId";

/**
 * Only the active datalet is resident, so this lists the others by what is
 * known about them without loading them: their vault. The active one can be
 * named from its own `Settings.appTitle`, because that is the datalet whose
 * records are actually in memory.
 */
function dataletLabel(entry: Datalet, isActive: boolean, activeTitle: string): string {
  if (isActive) return activeTitle;
  if (entry.vault) return `Vault ${entry.vault.vaultId.slice(0, 8)}`;
  return "This device";
}

export function DataletSettings() {
  const { appTitle } = useSettings();
  const privateNuri = usePrivateNuri();
  const { entries, activeId } = listDatalets();
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

  const adopt = async (work: () => Promise<{ vaultId: string; vaultToken: string }>) => {
    setAdding(true);
    setError("");
    try {
      const vault = await work();
      await adoptVaultAsDatalet({ ...vault, nodeId: randomUuid() }, privateNuri);
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
      return { vaultId: body.vaultId, vaultToken: body.vaultToken };
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

  return (
    <section className="panel">
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
        {entries.map((entry) => {
          const isActive = entry.id === activeId;
          return (
            <div className="layout-row" key={entry.id}>
              <span className="field-label">
                {dataletLabel(entry, isActive, appTitle)}
                {isActive && <span className="badge">Open</span>}
              </span>
              {!isActive && (
                <button
                  type="button"
                  className="secondary-btn"
                  disabled={!leaving.ok || switching !== "" || adding}
                  onClick={() => void goTo(entry)}
                >
                  {switching === entry.id ? "Opening…" : "Open"}
                </button>
              )}
            </div>
          );
        })}
      </div>

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
