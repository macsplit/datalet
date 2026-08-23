// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { decodePairingCode } from "./pairingCode";

export type RedeemedVault = { vaultId: string; vaultToken: string; copiedAt?: number };

/**
 * Turn any of this app's pasteable codes into vault credentials.
 *
 * Shared by the manual paste field in DataletSettings and by /join (invite
 * links), so the two never drift into judging a code differently. A COPY
 * code makes a new datalet from someone else's - it never grants access to
 * theirs, the server does the copying. A PAIR code hands over the same
 * durable credentials. Anything else is assumed to be an LG1 pairing code.
 */
export async function redeemDataletCode(rawCode: string): Promise<RedeemedVault> {
  const code = rawCode.trim();
  if (code.toUpperCase().startsWith("COPY")) {
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
}

/**
 * Recognize the pasteable forms an invite link can take, and reduce them all
 * to the bare token: a full https://…/join?token=… URL (what "Copy as Link"
 * actually produces), a bare token, or - unlikely by hand, but harmless to
 * accept - the query string alone.
 *
 * Exists because someone will paste the link, not just the code it wraps,
 * into whichever box they find first. The code-entry field is that box far
 * more often than /join is, so it has to recognize a link as well as a code.
 */
export function extractInviteToken(pasted: string): string | undefined {
  const trimmed = pasted.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed, window.location.origin);
    const fromQuery = url.searchParams.get("token");
    if (fromQuery) return fromQuery;
  } catch {
    // Not a URL - fall through to treating it as a bare token.
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed;
  }
  return undefined;
}

/**
 * Redeem an invite token (from /join or a pasted link) into the code it
 * wraps. Tries COPY then PAIR, since the pasted token alone doesn't say
 * which kind it is - only the server, which minted it, knows.
 */
export async function redeemInviteToken(token: string): Promise<{ codeType: "COPY" | "PAIR"; code: string }> {
  for (const codeType of ["COPY", "PAIR"] as const) {
    const response = await fetch("/sync/invite-redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codeType, inviteToken: token }),
    });
    if (response.ok) {
      const body = (await response.json()) as { code: string };
      return { codeType, code: body.code };
    }
    if (response.status === 404) continue;
    throw new Error(`Redeeming that link failed with status ${response.status}.`);
  }
  throw new Error("That link has expired or was already used.");
}
