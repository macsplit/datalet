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
import { getVaultConfig } from "../utils/remoteSyncEngine";

type CloneCode = { code: string; createdAt: number };

/**
 * Publishing a copy of this datalet.
 *
 * The list is not a convenience. A copy code is long-lived and multi-use, so
 * one that cannot be found again cannot be withdrawn - which is why it ships
 * with the publishing rather than after it.
 */
export function CloneCodes() {
  const config = getVaultConfig();
  const [codes, setCodes] = useState<CloneCode[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/sync/clone-codes?vault=${encodeURIComponent(config.vaultId)}`,
          { headers: { Authorization: `Bearer ${config.vaultToken}` } },
        );
        if (!response.ok) return;
        const body = (await response.json()) as { codes?: CloneCode[] };
        if (!cancelled) setCodes(body.codes ?? []);
      } catch {
        // Offline: the list is unavailable, which the empty state already says.
      }
    })();
    return () => { cancelled = true; };
  }, [config?.vaultId, config?.vaultToken]);

  if (!config) return null;

  const publish = async () => {
    const agreed = window.confirm(
      "Create a code that hands over a copy of this datalet?\n\n"
      + "• It copies everything here — every record, not just the schemas and screens.\n"
      + "• The sync server can read all of it. Nothing here is end-to-end encrypted.\n"
      + "• Anyone with the code can take a copy, as often as they like, until you "
      + "revoke it. Revoking does nothing about copies already taken.",
    );
    if (!agreed) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/sync/clone-codes?vault=${encodeURIComponent(config.vaultId)}`,
        { method: "POST", headers: { Authorization: `Bearer ${config.vaultToken}` } },
      );
      if (!response.ok) throw new Error(`The sync server answered with status ${response.status}.`);
      const issued = await response.json() as CloneCode;
      setCodes((current) => [issued, ...current]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That code could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (code: string) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/sync/clone-codes?vault=${encodeURIComponent(config.vaultId)}`
        + `&code=${encodeURIComponent(code)}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${config.vaultToken}` } },
      );
      if (!response.ok) throw new Error(`The sync server answered with status ${response.status}.`);
      setCodes((current) => current.filter((entry) => entry.code !== code));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That code could not be revoked.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      // Clipboard unavailable; the code is on screen to copy by hand.
    }
  };

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <p className="label-accent">Datalets</p>
          <h2 className="title">Give someone a copy</h2>
        </div>
        <button type="button" className="secondary-btn" disabled={busy} onClick={() => void publish()}>
          {busy ? "Working…" : "Create a copy code"}
        </button>
      </div>
      <p className="helper-text">
        A copy code lets someone take their own datalet from this one. They do not get
        access to yours, and nothing they change afterwards comes back here. It copies
        everything, including your records, and the sync server can read all of it.
      </p>
      {error && <p className="danger-text" role="alert">{error}</p>}
      {codes.length === 0
        ? <p className="helper-text">No copy codes exist for this datalet.</p>
        : (
          <div className="section-stack">
            {codes.map((entry) => (
              <div className="layout-row" key={entry.code}>
                <input className="input" readOnly aria-label={`Copy code ${entry.code}`} value={entry.code} />
                <button type="button" className="secondary-btn" onClick={() => void copy(entry.code)}>
                  {copied === entry.code ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  className="secondary-btn danger-text"
                  disabled={busy}
                  onClick={() => void revoke(entry.code)}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
    </section>
  );
}
