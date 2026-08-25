// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Erasing a datalet: the server's copy first, then this browser's record of it.
 *
 * `DELETE /sync/vaults` has existed and been tested since the sync tier was
 * built, but nothing in the interface ever called it, so there was no way for
 * someone to erase their own data from the server. That is the gap this
 * closes, and it is why the order below matters.
 */

import { forgetDatalet, type Datalet } from "./datalets";

export type RemovalOutcome = { serverErased: boolean };

// Matches SYNC_DOWN_WARNING_DELAY_MS (remoteSyncEngine.ts) - this app's own
// established judgment for "long enough that something is genuinely wrong,"
// not a new number invented for this one call.
const DELETE_TIMEOUT_MS = 15_000;

/**
 * Erase a datalet's vault, then forget it locally.
 *
 * The order is load-bearing and must not be swapped for convenience. This
 * browser's registry entry holds the only copy of the vault token, so
 * forgetting first would leave a vault on the server that nobody can ever
 * authenticate against, and therefore nobody can ever delete - the opposite of
 * what someone asking to be forgotten wants. A failed delete keeps the entry
 * so it can be retried.
 *
 * `externalSignal` lets a caller offer a genuine "Cancel" while offline: the
 * DELETE fetch had no timeout at all before this, so on a connection that
 * looked present but couldn't actually reach the server (unlike true
 * airplane-mode, which fails a fetch immediately), it could hang for as long
 * as the browser's own TCP timeout - reported live as "left a contentless
 * screen pending indefinitely... could not be reached again until
 * connectivity returned." Both the timeout below and an external cancel abort
 * the same in-flight request; neither ever calls `forgetDatalet` - the entry
 * and its credentials are untouched either way, so the attempt is always
 * retryable once back online.
 */
export async function removeDataletPermanently(
  entry: Datalet,
  externalSignal?: AbortSignal,
): Promise<RemovalOutcome> {
  if (!entry.vault) {
    // Never paired, so there is nothing on any server to erase.
    forgetDatalet(entry.id);
    return { serverErased: false };
  }

  const controller = new AbortController();
  const forwardExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) forwardExternalAbort();
  externalSignal?.addEventListener("abort", forwardExternalAbort);
  const timedOut = { current: false };
  const timeout = setTimeout(() => {
    timedOut.current = true;
    controller.abort();
  }, DELETE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(
      `/sync/vaults?vault=${encodeURIComponent(entry.vault.vaultId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${entry.vault.vaultToken}` }, signal: controller.signal },
    );
  } catch {
    if (externalSignal?.aborted) {
      throw new Error("Cancelled. Nothing has been removed, so you can try again.");
    }
    if (timedOut.current) {
      throw new Error(
        "The sync server did not answer in time. Nothing has been removed, so it's still "
        + "safe here - try again once your connection is back.",
      );
    }
    // A genuine connection failure (not a timeout, not a cancel) - the fetch
    // itself rejected, typically with a browser-worded TypeError that is not
    // something to show as-is.
    throw new Error(
      "This browser could not reach the sync server. Nothing has been removed, so it's still "
      + "safe here - try again once your connection is back.",
    );
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", forwardExternalAbort);
  }

  // A vault the server no longer has is already erased; treat it as done
  // rather than stranding the entry forever on a 404.
  if (!response.ok && response.status !== 404) {
    const reason = await response.text().catch(() => "");
    throw new Error(
      `The sync server refused to erase this datalet (status ${response.status}${reason ? `: ${reason}` : ""}). `
      + "Nothing has been removed, so you can try again.",
    );
  }

  forgetDatalet(entry.id);
  return { serverErased: true };
}
