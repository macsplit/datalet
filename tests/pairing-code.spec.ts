// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { expect, test } from "@playwright/test";

/**
 * `PAIRING_CODE_CHECK_ALPHABET` (src/utils/pairingCode.ts) used to include
 * `~` and `=` - valid as check symbols in isolation, but not valid QR
 * "alphanumeric" characters (src/utils/qrCode.ts's own ALPHANUMERIC set).
 * Any vault whose checksum happened to land on one of those two symbols -
 * about 2 in 37, ~5.4% of vaults - could never render as a QR code on any
 * device: `encodePairingQr` threw on every attempt, uncaught, straight into
 * the router's generic error boundary (a blank panel behind a "Show error"
 * toggle - this is what got reported as an iPad-specific bug; it wasn't
 * iPad-specific, it was that particular vault's checksum, which happens to
 * be stable per vault and so looks device-specific from one person's seat).
 *
 * This is deliberately a static, exhaustive check rather than a sweep over
 * sampled vaults: the checksum is always one of the 37 characters in this
 * alphabet, so proving all 37 are QR-safe proves no vault can ever produce
 * an unsafe one - no randomness, no chance of missing the unlucky case.
 */
test("every possible pairing-code checksum symbol is QR-alphanumeric-safe", async ({ page }) => {
  await page.goto("/");
  const unsafe = await page.evaluate(async () => {
    const { PAIRING_CODE_CHECK_ALPHABET } = await import("/src/utils/pairingCode.ts");
    // Independently restated rather than imported from qrCode.ts: the point
    // is to catch either file drifting out of sync with the other, which an
    // import shared between the check and the thing it's checking cannot do.
    const QR_ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
    return [...(PAIRING_CODE_CHECK_ALPHABET as string)].filter(
      (character) => !QR_ALPHANUMERIC.includes(character),
    );
  });
  expect(unsafe).toEqual([]);
});

test("many real vaultId/token pairs encode, become a QR code, and decode back losslessly", async ({ page }) => {
  await page.goto("/");
  const failures = await page.evaluate(async () => {
    const { encodePairingCode, decodePairingCode } = await import("/src/utils/pairingCode.ts");
    const { encodePairingQr } = await import("/src/utils/qrCode.ts");
    const problems: string[] = [];
    for (let index = 0; index < 500; index += 1) {
      const idBytes = crypto.getRandomValues(new Uint8Array(16));
      idBytes[6] = (idBytes[6] & 0x0f) | 0x40;
      idBytes[8] = (idBytes[8] & 0x3f) | 0x80;
      const hex = [...idBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const vaultId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      const tokenBytes = crypto.getRandomValues(new Uint8Array(24));
      let binary = "";
      for (const byte of tokenBytes) binary += String.fromCharCode(byte);
      const vaultToken = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      try {
        const code = encodePairingCode(vaultId, vaultToken);
        encodePairingQr(code);
        const decoded = decodePairingCode(code);
        if (decoded.vaultId !== vaultId || decoded.vaultToken !== vaultToken) {
          problems.push(`round trip mismatch at index ${index}`);
        }
      } catch (error) {
        problems.push(`index ${index}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return problems;
  });
  expect(failures).toEqual([]);
});
