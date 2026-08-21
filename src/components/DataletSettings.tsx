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
import { useSettings } from "../hooks/useSettings";
import usePrivateNuri from "./usePrivateNuri";
import { listDatalets, type Datalet } from "../utils/datalets";
import { canLeaveActiveDatalet, switchToDatalet } from "../utils/dataletSwitch";

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

  // One datalet is the ordinary case and needs no list; the panel only earns
  // its place once there is something to choose between.
  if (entries.length < 2) return null;

  const leaving = canLeaveActiveDatalet();

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
        time; the others live in their vaults until you switch to them.
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
                  disabled={!leaving.ok || switching !== ""}
                  onClick={() => void goTo(entry)}
                >
                  {switching === entry.id ? "Opening…" : "Open"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
