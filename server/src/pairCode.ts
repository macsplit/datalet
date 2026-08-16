// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

import { randomBytes } from "node:crypto";

const DATA_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CHECK_ALPHABET = `${DATA_ALPHABET}*~$=U`;
const PREFIX = "PAIR";
const PAYLOAD_CHARACTERS = 8;

function canonicalCharacter(character: string): string {
  if (character === "O") return "0";
  if (character === "I" || character === "L") return "1";
  return character;
}

function checksum(payload: string): string {
  let remainder = 0;
  for (const character of payload) {
    const value = DATA_ALPHABET.indexOf(character);
    if (value < 0) throw new Error("Pair code contains a character outside Crockford base32.");
    remainder = (remainder * 32 + value) % 37;
  }
  return CHECK_ALPHABET[remainder];
}

function format(payload: string, check: string): string {
  return `${PREFIX}-${payload.slice(0, 4)}-${payload.slice(4)}-${check}`;
}

/** Generate 40 random bits plus a Crockford mod-37 check symbol. */
export function generatePairCode(): string {
  const bytes = randomBytes(5);
  let payload = "";
  let bits = 0;
  let buffer = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      payload += DATA_ALPHABET[(buffer >>> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }
  return format(payload, checksum(payload));
}

/** Normalize separators/aliases and reject a mistyped or malformed code. */
export function normalizePairCode(input: string): string {
  const compact = input.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!compact.startsWith(PREFIX) || compact.length !== PREFIX.length + PAYLOAD_CHARACTERS + 1) {
    throw new Error("Temporary pair codes have the form PAIR-XXXX-XXXX-X.");
  }
  const body = compact.slice(PREFIX.length);
  const payload = [...body.slice(0, PAYLOAD_CHARACTERS)].map(canonicalCharacter).join("");
  const suppliedCheck = canonicalCharacter(body.at(-1)!);
  if ([...payload].some((character) => !DATA_ALPHABET.includes(character))) {
    throw new Error("Pair code contains a character outside Crockford base32.");
  }
  if (checksum(payload) !== suppliedCheck) {
    throw new Error("That temporary pair code has a typo (its check symbol does not match).");
  }
  return format(payload, suppliedCheck);
}
