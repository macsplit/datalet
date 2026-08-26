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
import { readStorageUsage } from "../utils/localNgEngine";
import { subscribeRuntimeIssues } from "../utils/runtimeHealth";
import {
  readStoragePersistence,
  requestStoragePersistence,
  type StoragePersistence,
} from "../utils/storagePersistence";

const mb = (value: number) => `${(value / 1_000_000).toFixed(1)} MB`;

/**
 * How full this browser is, and whether it has agreed to keep what is here.
 *
 * A panel of its own rather than a line inside the backup panel. As a sentence
 * among other sentences it was, in practice, invisible - which defeats the
 * point of a warning that exists to arrive before saving stops.
 */
export function StorageUsage() {
  const [usage, setUsage] = useState(() => readStorageUsage());
  const [persistence, setPersistence] = useState<StoragePersistence>("unsupported");
  const [asking, setAsking] = useState(false);
  // Distinct from `persistence === "not-persisted"` on its own, which is also
  // true before anyone has ever asked. Without this, a real, silent refusal
  // (reported live: the button "has no discernible result" on mobile Chrome
  // and Safari, which - unlike Firefox's own explicit prompt - typically
  // grant this from engagement/installed-state heuristics and just as often
  // decline without ever surfacing a prompt) redraws the exact same button
  // and the exact same sentence, so a real answer reads as no answer at all.
  const [justDeclined, setJustDeclined] = useState(false);

  useEffect(() => {
    const refresh = () => setUsage(readStorageUsage());
    const timer = setInterval(refresh, 5_000);
    // The issue reporter is what fires when saving stops, so the figure
    // updates at the moment it matters rather than up to five seconds later.
    const unsubscribe = subscribeRuntimeIssues(refresh);
    return () => { clearInterval(timer); unsubscribe(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void readStoragePersistence().then((state) => { if (!cancelled) setPersistence(state); });
    return () => { cancelled = true; };
  }, []);

  const askToKeep = async () => {
    setAsking(true);
    setJustDeclined(false);
    try {
      const result = await requestStoragePersistence();
      setPersistence(result);
      setJustDeclined(result === "not-persisted");
    } finally {
      setAsking(false);
    }
  };

  const percent = Math.min(100, Math.round(usage.fraction * 100));
  const level = usage.paused || usage.fraction >= 0.9
    ? "danger"
    : usage.fraction >= 0.6 ? "warn" : "ok";

  return (
    <section className="panel" id="storage">
      <div className="panel-header">
        <div>
          <p className="label-accent">Storage</p>
          <h2 className="title">Space in this browser</h2>
        </div>
        <span className="badge">{percent}%</span>
      </div>

      <div
        className={`storage-bar storage-bar-${level}`}
        role="progressbar"
        aria-label="Browser storage used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${mb(usage.used)} of ${mb(usage.cap)} used`}
      >
        <span className="storage-bar-fill" style={{ width: `${percent}%` }} />
      </div>
      <p className="helper-text">{mb(usage.used)} of {mb(usage.cap)} used.</p>

      {usage.paused && (
        <p className="helper-text danger-text" role="alert">
          Storage is full, so saving has stopped. Export a backup, then delete records or
          schemas you no longer need.
        </p>
      )}
      {!usage.paused && usage.fraction >= 0.9 && (
        <p className="helper-text danger-text">
          Storage is nearly full. Saving stops when it fills, so export a backup and make
          room now.
        </p>
      )}

      {persistence === "persisted" && (
        <p className="helper-text">
          This browser has agreed to keep your data: it will not be removed to reclaim
          space, and ordinary cleanup leaves it alone. Keep exporting backups anyway —
          nothing here survives losing the device.
        </p>
      )}
      {persistence === "not-persisted" && (
        <div className="layout-row">
          <p className="helper-text">
            {justDeclined
              ? "This browser was just asked, and said no for now. Some browsers only agree "
                + "after you've used a site more — try again later, or rely on backups and "
                + "pairing to protect your data instead."
              : "This browser has not agreed to keep your data, so clearing site data deletes "
                + "it. There is no copy anywhere else unless you have paired or exported one."}
          </p>
          <button type="button" className="secondary-btn" onClick={() => void askToKeep()} disabled={asking}>
            {asking ? "Asking…" : justDeclined ? "Ask again" : "Ask to keep data"}
          </button>
        </div>
      )}
    </section>
  );
}
