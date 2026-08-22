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
import { Link } from "@tanstack/react-router";
import { readStorageUsage } from "../utils/localNgEngine";
import { subscribeRuntimeIssues } from "../utils/runtimeHealth";

/**
 * How full this browser is, said where the filling happens.
 *
 * The bar in Settings was the only place a percentage appeared, and it is on a
 * page nobody visits while entering records: measured at 99% full, someone
 * working on a tab saw nothing at all, and the first signal was saving
 * stopping. A warning that only appears where you are not is not a warning.
 *
 * Two bands, because they are different kinds of message. NOTICE is "worth
 * knowing", so it can be dismissed and stays dismissed for the session.
 * URGENT is "you are about to lose the ability to save", which is not a
 * preference, so it carries no dismiss control at all - there is no version of
 * that message someone benefits from hiding while it remains true.
 */
const NOTICE = 0.75;
const URGENT = 0.9;

/**
 * Per session, not per browser: sessionStorage clears with the tab. A
 * dismissal that outlived the session would hide a nearly-full store on every
 * future visit, which is precisely when it needs saying again.
 */
const DISMISSED_KEY = "meta-ui-builder:storage-notice-dismissed";

function wasDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

const mb = (value: number) => `${(value / 1_000_000).toFixed(1)} MB`;

export function StorageBanner() {
  const [usage, setUsage] = useState(() => readStorageUsage());
  const [dismissed, setDismissed] = useState(wasDismissed);

  useEffect(() => {
    const refresh = () => setUsage(readStorageUsage());
    const timer = setInterval(refresh, 5_000);
    // Fires the moment saving stops, so the banner appears then rather than up
    // to five seconds later.
    const unsubscribe = subscribeRuntimeIssues(refresh);
    return () => { clearInterval(timer); unsubscribe(); };
  }, []);

  const urgent = usage.paused || usage.fraction >= URGENT;
  if (!urgent && (usage.fraction < NOTICE || dismissed)) return null;

  const percent = Math.min(100, Math.round(usage.fraction * 100));

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Private mode can refuse; hiding it for this render is still correct.
    }
    setDismissed(true);
  };

  return (
    <aside
      id="storage-banner"
      className={`runtime-banner storage-banner-${urgent ? "urgent" : "notice"}`}
      role="alert"
    >
      <div>
        <span>
          {usage.paused
            ? "This browser is full, so your changes are no longer being saved."
            : urgent
              ? `This browser is ${percent}% full. Saving stops when it fills.`
              : `This browser is ${percent}% full.`}
        </span>
        <small>
          {mb(usage.used)} of {mb(usage.cap)} used.{" "}
          <Link to="/settings/datalets" hash="storage">Export a backup and make room</Link>.
        </small>
      </div>
      {/* No dismiss above the urgent threshold: the message stays true whether
          or not it has been read, and hiding it only delays the discovery. */}
      {!urgent && (
        <button type="button" className="secondary-btn" onClick={dismiss}>
          Dismiss
        </button>
      )}
    </aside>
  );
}
