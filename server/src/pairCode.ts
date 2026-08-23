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
const PAYLOAD_CHARACTERS = 16;  // 80 bits = 16 * 5-bit chars (Crockford base32)

/** Code kinds. The prefix is what tells one from another in a single input. */
export const PAIR_PREFIX = "PAIR";
export const CLONE_PREFIX = "COPY";

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

function format(prefix: string, payload: string, check: string): string {
  return `${prefix}-${payload.slice(0, 8)}-${payload.slice(8)}-${check}`;
}

/** Generate 80 random bits plus a Crockford mod-37 check symbol. */
export function generateCode(prefix: string): string {
  const bytes = randomBytes(10);  // 80 bits
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
  return format(prefix, payload, checksum(payload));
}

/**
 * Normalize separators and Crockford aliases, and reject a mistyped or
 * malformed code. Separators are stripped before the prefix is checked, so a
 * code pasted without its hyphens is still valid input.
 */
export function normalizeCode(prefix: string, input: string): string {
  const compact = input.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!compact.startsWith(prefix) || compact.length !== prefix.length + PAYLOAD_CHARACTERS + 1) {
    throw new Error(`Codes of this kind have the form ${prefix}-XXXX-XXXX-X.`);
  }
  const body = compact.slice(prefix.length);
  const payload = [...body.slice(0, PAYLOAD_CHARACTERS)].map(canonicalCharacter).join("");
  const suppliedCheck = canonicalCharacter(body.at(-1)!);
  if ([...payload].some((character) => !DATA_ALPHABET.includes(character))) {
    throw new Error("Pair code contains a character outside Crockford base32.");
  }
  if (checksum(payload) !== suppliedCheck) {
    throw new Error("That code has a typo (its check symbol does not match).");
  }
  return format(prefix, payload, suppliedCheck);
}

/** A one-use pairing handoff. */
export const generatePairCode = () => generateCode(PAIR_PREFIX);
export const normalizePairCode = (input: string) => normalizeCode(PAIR_PREFIX, input);

/** A revocable capability to take a copy of a vault, with 80-bit entropy and a 30-day TTL. */
export const generateCloneCode = () => generateCode(CLONE_PREFIX);
export const normalizeCloneCode = (input: string) => normalizeCode(CLONE_PREFIX, input);
