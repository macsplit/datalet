// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { initNg as initNgSignals } from "@ng-org/orm";
import { localEngine } from "./localNgEngine";

const SESSION_STORAGE_KEY = "meta-ui-builder:local-session";

/**
 * `crypto.randomUUID()` throws outside a secure context (plain HTTP on
 * anything other than localhost/127.0.0.1 - e.g. a LAN IP like
 * `http://192.168.1.17:5173`), which would crash `init()` before React ever
 * mounts, leaving a permanently blank page. `crypto.getRandomValues` has no
 * such restriction, so build a UUID-shaped id from it instead.
 */
function generateId(): string {
  if (typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // Insecure context (e.g. plain HTTP on a LAN IP) - fall through below.
    }
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A local stand-in for NextGraph's `Session` type. No wallet involved. */
export type LocalSession = {
  session_id: string;
  private_store_id: string;
  protected_store_id: string;
  public_store_id: string;
  [key: string]: unknown;
};

function loadOrCreateSession(): LocalSession {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as LocalSession;
  } catch {
    // Ignore corrupt storage and create a fresh session below.
  }
  const newSession: LocalSession = {
    session_id: generateId(),
    private_store_id: generateId(),
    protected_store_id: generateId(),
    public_store_id: generateId(),
  };
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(newSession));
  return newSession;
}

/** The current local session, or undefined until `init()` has run. */
export let session: LocalSession | undefined;

let resolveSessionPromise: (value: LocalSession) => void;

/** Resolves to the current local session. */
export const sessionPromise: Promise<LocalSession> = new Promise((resolve) => {
  resolveSessionPromise = resolve;
});

/**
 * Sets up the local session and wires it into the ORM. Unlike the hosted
 * NextGraph setup, this is synchronous and never navigates away from the
 * page - there is no wallet to authenticate with.
 */
export function init() {
  session = loadOrCreateSession();
  // The ORM's public types expect `@ng-org/web`'s NG/Session shapes; our
  // local engine and session satisfy the same structural contract.
  initNgSignals(localEngine as any, session as any);
  resolveSessionPromise(session);
}
