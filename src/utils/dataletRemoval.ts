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

/**
 * Erase a datalet's vault, then forget it locally.
 *
 * The order is load-bearing and must not be swapped for convenience. This
 * browser's registry entry holds the only copy of the vault token, so
 * forgetting first would leave a vault on the server that nobody can ever
 * authenticate against, and therefore nobody can ever delete - the opposite of
 * what someone asking to be forgotten wants. A failed delete keeps the entry
 * so it can be retried.
 */
export async function removeDataletPermanently(entry: Datalet): Promise<RemovalOutcome> {
  if (!entry.vault) {
    // Never paired, so there is nothing on any server to erase.
    forgetDatalet(entry.id);
    return { serverErased: false };
  }

  const response = await fetch(
    `/sync/vaults?vault=${encodeURIComponent(entry.vault.vaultId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${entry.vault.vaultToken}` } },
  );

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
