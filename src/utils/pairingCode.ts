// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

export const PAIRING_CODE_DATA_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// Five extra symbols beyond the 32-character data alphabet give the mod-37
// checksum its own digit (32 + 5 = 37). All five have to survive
// `encodePairingQr`'s QR "alphanumeric" mode, which only supports
// `0-9 A-Z $%*+-./:` (space included, but stripped by decodePairingCode
// below along with `-`, so neither is usable here). `~` and `=` used to be
// two of the five: valid Crockford-adjacent symbols, but not valid QR
// alphanumeric characters, so any vault whose checksum happened to land on
// one of them could never render as a QR code - encodePairingQr would throw
// on every attempt, for that vault, forever, on every device.
export const PAIRING_CODE_CHECK_ALPHABET = `${PAIRING_CODE_DATA_ALPHABET}*%$+U`;
const PREFIX = "LG1";
const PAYLOAD_CHARACTERS = 64;
const BODY_CHARACTERS = PAYLOAD_CHARACTERS + 1;

export type PairingCredentials = { vaultId: string; vaultToken: string };

function canonicalCharacter(character: string): string {
  if (character === "O") return "0";
  if (character === "I" || character === "L") return "1";
  return character;
}

function dataValue(character: string): number {
  return PAIRING_CODE_DATA_ALPHABET.indexOf(canonicalCharacter(character));
}

function checksum(payload: string): string {
  let remainder = 0;
  for (const character of payload) {
    const value = dataValue(character);
    if (value < 0) throw new Error("Pairing code contains a character outside Crockford base32.");
    remainder = (remainder * 32 + value) % 37;
  }
  return PAIRING_CODE_CHECK_ALPHABET[remainder];
}

function encodeBytes(bytes: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let encoded = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += PAIRING_CODE_DATA_ALPHABET[(buffer >>> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0) encoded += PAIRING_CODE_DATA_ALPHABET[(buffer << (5 - bits)) & 31];
  return encoded;
}

function decodeBytes(payload: string): Uint8Array {
  const bytes: number[] = [];
  let bits = 0;
  let buffer = 0;
  for (const character of payload) {
    const value = dataValue(character);
    if (value < 0) throw new Error("Pairing code contains a character outside Crockford base32.");
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 255);
      buffer &= (1 << bits) - 1;
    }
  }
  if (bytes.length !== 40 || bits !== 0) throw new Error("Pairing code has the wrong payload length.");
  return Uint8Array.from(bytes);
}

function uuidBytes(vaultId: string): Uint8Array {
  const compact = vaultId.replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(compact)) throw new Error("Vault ID is not a UUID.");
  return Uint8Array.from(compact.match(/../g)!.map((pair) => Number.parseInt(pair, 16)));
}

function tokenBytes(vaultToken: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{32}$/.test(vaultToken)) throw new Error("Vault token has the wrong format.");
  const binary = atob(vaultToken.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length !== 24) throw new Error("Vault token has the wrong length.");
  return bytes;
}

function formatBody(body: string): string {
  return `${PREFIX}-${body.match(/.{5}/g)!.join("-")}`;
}

/** Encode the server's existing UUID and 24-byte token as one copyable LG1 code. */
export function encodePairingCode(vaultId: string, vaultToken: string): string {
  const id = uuidBytes(vaultId);
  const token = tokenBytes(vaultToken);
  const bytes = new Uint8Array(id.length + token.length);
  bytes.set(id);
  bytes.set(token, id.length);
  const payload = encodeBytes(bytes);
  if (payload.length !== PAYLOAD_CHARACTERS) throw new Error("Pairing payload did not encode to 320 bits.");
  return formatBody(payload + checksum(payload));
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function bytesToToken(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Decode, normalize ambiguous characters, and validate the Crockford check symbol. */
export function decodePairingCode(input: string): PairingCredentials {
  const compact = input.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!compact.startsWith(PREFIX) || compact.length !== PREFIX.length + BODY_CHARACTERS) {
    throw new Error("Pairing codes start with LG1 and contain 65 Crockford characters.");
  }
  const rawBody = compact.slice(PREFIX.length);
  const payload = [...rawBody.slice(0, PAYLOAD_CHARACTERS)].map(canonicalCharacter).join("");
  const suppliedCheck = canonicalCharacter(rawBody.slice(PAYLOAD_CHARACTERS));
  if ([...payload].some((character) => dataValue(character) < 0)) {
    throw new Error("Pairing code contains a character outside Crockford base32.");
  }
  if (checksum(payload) !== suppliedCheck) {
    throw new Error("That pairing code has a typo (its check symbol does not match).");
  }
  const bytes = decodeBytes(payload);
  return {
    vaultId: bytesToUuid(bytes.slice(0, 16)),
    vaultToken: bytesToToken(bytes.slice(16)),
  };
}
