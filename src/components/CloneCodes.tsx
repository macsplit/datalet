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
import { copyText } from "../utils/clipboard";

type CloneCode = { code: string; createdAt: number };

/**
 * Mint a single-use, 7-day link wrapping a code, and return the full URL to
 * share. A raw `?code=COPY-...` link was the alternative rejected earlier:
 * the code itself would then sit in browser history, referrer headers and
 * server logs anywhere the link passed through. A wrapping token carries
 * none of that - it is worthless to anyone but the one-time exchange.
 */
async function inviteLinkFor(codeType: "COPY" | "PAIR", code: string): Promise<string> {
  const response = await fetch("/sync/invite-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ codeType, code }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { reason?: string } | undefined;
    throw new Error(body?.reason ?? `Could not create a link (status ${response.status}).`);
  }
  const { inviteToken } = await response.json() as { inviteToken: string };
  return `${window.location.origin}/join?token=${inviteToken}`;
}

/**
 * Publishing a copy of this datalet.
 *
 * The list is not a convenience. A copy code is multi-use but expires after 30 days, so
 * one that cannot be found again cannot be withdrawn - which is why it ships
 * with the publishing rather than after it.
 */
export function CloneCodes() {
  const config = getVaultConfig();
  const [codes, setCodes] = useState<CloneCode[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [linking, setLinking] = useState("");

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

  // Keyed as "code:<value>" or "link:<value>" - the two buttons in a row
  // would otherwise both read "Copied" whichever one someone actually pressed,
  // since they'd share the same bare code as their key.
  const copy = async (code: string) => {
    if (await copyText(code)) {
      setCopied(`code:${code}`);
      setTimeout(() => setCopied(""), 2000);
      return;
    }
    // Never silently: a Copy button that does nothing is indistinguishable
    // from a broken app, and the next paste would be of something stale.
    setError("This browser would not let the page copy for you. Select the code and copy it by hand.");
  };

  const copyAsLink = async (code: string) => {
    setLinking(code);
    setError("");
    try {
      const link = await inviteLinkFor("COPY", code);
      if (await copyText(link)) {
        setCopied(`link:${code}`);
        setTimeout(() => setCopied(""), 2000);
      } else {
        setError("This browser would not let the page copy for you. The link was created but not copied.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That link could not be created.");
    } finally {
      setLinking("");
    }
  };

  return (
    <section className="panel" id="copy-codes">
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
        A copy code lets someone take their own datalet from this one. Codes expire after 30 days (you can revoke them earlier). They do not get
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
                <button
                  type="button"
                  className="secondary-btn"
                  aria-label={`Copy the code ${entry.code}`}
                  onClick={() => void copy(entry.code)}
                >
                  {copied === `code:${entry.code}` ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  className="secondary-btn"
                  aria-label={`Copy a link for the code ${entry.code}`}
                  disabled={linking === entry.code}
                  onClick={() => void copyAsLink(entry.code)}
                >
                  {linking === entry.code
                    ? "Working…"
                    : copied === `link:${entry.code}` ? "Copied" : "Copy as Link"}
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
