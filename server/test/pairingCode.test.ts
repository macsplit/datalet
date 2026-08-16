import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodePairingCode,
  encodePairingCode,
  PAIRING_CODE_CHECK_ALPHABET,
  PAIRING_CODE_DATA_ALPHABET,
} from "../../src/utils/pairingCode.ts";

const credentials = {
  vaultId: "00112233-4455-4677-8899-aabbccddeeff",
  vaultToken: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX",
};

function compactBody(code: string): string {
  return code.replaceAll("-", "").slice(3);
}

function withBody(body: string): string {
  return `LG1-${body}`;
}

test("LG1 pairing codes round-trip case-insensitively and normalize Crockford aliases", () => {
  const code = encodePairingCode(credentials.vaultId, credentials.vaultToken);
  assert.match(code, /^LG1(?:-[0-9A-Z*~$=]{5}){13}$/);
  assert.deepEqual(decodePairingCode(code), credentials);
  assert.deepEqual(decodePairingCode(code.toLowerCase()), credentials);

  const aliased = withBody(compactBody(code).replaceAll("0", "O").replaceAll("1", "I"));
  assert.deepEqual(decodePairingCode(aliased), credentials);
  assert.deepEqual(decodePairingCode(aliased.replaceAll("I", "L")), credentials);
});

test("the check symbol rejects every canonical single-character substitution", () => {
  const body = compactBody(encodePairingCode(credentials.vaultId, credentials.vaultToken));
  for (let index = 0; index < body.length; index += 1) {
    const alphabet = index === body.length - 1
      ? PAIRING_CODE_CHECK_ALPHABET
      : PAIRING_CODE_DATA_ALPHABET;
    for (const replacement of alphabet) {
      if (replacement === body[index]) continue;
      const changed = body.slice(0, index) + replacement + body.slice(index + 1);
      assert.throws(() => decodePairingCode(withBody(changed)), undefined, `position ${index}: ${replacement}`);
    }
  }
});

test("the check symbol rejects every adjacent transposition that changes the code", () => {
  const body = compactBody(encodePairingCode(credentials.vaultId, credentials.vaultToken));
  for (let index = 0; index < body.length - 1; index += 1) {
    if (body[index] === body[index + 1]) continue;
    const changed =
      body.slice(0, index) + body[index + 1] + body[index] + body.slice(index + 2);
    assert.throws(() => decodePairingCode(withBody(changed)), undefined, `positions ${index}/${index + 1}`);
  }
});
