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
import { useNavigate, useSearch } from "@tanstack/react-router";
import usePrivateNuri from "../components/usePrivateNuri";
import { canLeaveActiveDatalet } from "../utils/dataletSwitch";
import { adoptVaultAsDatalet } from "../utils/dataletSwitch";
import { redeemDataletCode, redeemInviteToken } from "../utils/codeRedemption";
import { randomUuid } from "../utils/randomId";

type Stage =
  | { step: "loading" }
  | { step: "error"; message: string }
  | { step: "confirm"; codeType: "COPY" | "PAIR"; code: string }
  | { step: "adding" }
  | { step: "done" };

/**
 * Landing page for an invite link: /join?token=<uuid>.
 *
 * "Act as if it had been pasted into Settings" is the point of this page -
 * not a preview of the code with a copy button, which would just relocate
 * the paste rather than remove it. It runs the same redemption and the same
 * canLeaveActiveDatalet guard the manual field uses, so a link can't strand
 * this browser's unsynced records any more than pasting could.
 */
export function JoinPage() {
  const navigate = useNavigate();
  const privateNuri = usePrivateNuri();
  const search = useSearch({ from: "/join" }) as { token?: string };
  const token = search.token;

  const [stage, setStage] = useState<Stage>({ step: "loading" });

  // Re-checked on a timer rather than once at render: the commonest refusal is
  // a queued outbox, which clears itself moments later as the changes sync,
  // asynchronously and outside React's knowledge. Computed only at render, the
  // confirm screen would render once while a sync was still pending and then
  // never notice it finish - the button would stay disabled for as long as the
  // person kept looking at an otherwise-unchanging screen. DataletSettings.tsx
  // solves the same problem the same way, for the same reason.
  const [leaving, setLeaving] = useState(() => canLeaveActiveDatalet());
  useEffect(() => {
    const timer = setInterval(() => setLeaving(canLeaveActiveDatalet()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!token) {
      setStage({ step: "error", message: "This link is missing its invite token." });
      return;
    }
    let cancelled = false;
    void redeemInviteToken(token)
      .then(({ codeType, code }) => {
        if (!cancelled) setStage({ step: "confirm", codeType, code });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStage({
            step: "error",
            message: error instanceof Error ? error.message : "That link could not be redeemed.",
          });
        }
      });
    return () => { cancelled = true; };
  }, [token]);

  if (stage.step === "loading") {
    return (
      <section className="panel">
        <p className="helper-text">Checking this link…</p>
      </section>
    );
  }

  if (stage.step === "error") {
    return (
      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="label-accent">Invite link</p>
            <h2 className="title">This link didn't work</h2>
          </div>
        </div>
        <p className="danger-text" role="alert">{stage.message}</p>
        <p className="helper-text">
          Invite links are single-use and expire after a week. Ask whoever sent it to create
          a new one.
        </p>
        <button type="button" className="primary-btn" onClick={() => void navigate({ to: "/settings/datalets" })}>
          Go to Settings
        </button>
      </section>
    );
  }

  if (stage.step === "adding") {
    return (
      <section className="panel">
        <p className="helper-text">Adding this datalet…</p>
      </section>
    );
  }

  if (stage.step === "done") {
    return (
      <section className="panel">
        <p className="helper-text">Done. Taking you there…</p>
      </section>
    );
  }

  const { codeType, code } = stage;

  const confirm = async () => {
    setStage({ step: "adding" });
    try {
      const { copiedAt, ...vault } = await redeemDataletCode(code);
      // adoptVaultAsDatalet ends with window.location.reload() - matching the
      // manual-paste path exactly. Left pointed at /join, that reload would
      // land back on this same URL and retry redemption against a token
      // that redeemInviteToken already consumed, turning a successful join
      // into a false "link expired" error. Moving the address first, without
      // a navigation of its own, means the reload lands somewhere sane.
      window.history.replaceState(null, "", "/settings/datalets");
      await adoptVaultAsDatalet({ ...vault, nodeId: randomUuid() }, privateNuri, { copiedAt });
      setStage({ step: "done" });
    } catch (error) {
      setStage({
        step: "error",
        message: error instanceof Error ? error.message : "That datalet could not be added.",
      });
    }
  };

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <p className="label-accent">Invite link</p>
          <h2 className="title">
            {codeType === "COPY" ? "Take a copy of a datalet" : "Join a synced vault"}
          </h2>
        </div>
      </div>
      <p className="helper-text">
        {codeType === "COPY"
          ? "This makes a separate datalet of your own, starting from someone else's data. "
            + "It never grants access to theirs, and nothing you change afterwards reaches "
            + "them either."
          : "This adds the same synced datalet to this browser. Changes made here and on "
            + "other devices holding it will converge."}
      </p>
      {!leaving.ok && <p className="danger-text" role="alert">{leaving.message}</p>}
      <button type="button" className="primary-btn" disabled={!leaving.ok} onClick={() => void confirm()}>
        {codeType === "COPY" ? "Take a copy" : "Join"}
      </button>
      <button type="button" className="secondary-btn" onClick={() => void navigate({ to: "/settings/datalets" })}>
        Not now
      </button>
    </section>
  );
}
