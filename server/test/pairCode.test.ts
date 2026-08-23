import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePairCode, normalizePairCode } from "../src/pairCode.js";

const DATA_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CHECK_ALPHABET = `${DATA_ALPHABET}*~$=U`;

function compact(code: string): string {
  return code.replaceAll("-", "");
}

test("temporary pair codes carry 80 random bits and normalize Crockford aliases", () => {
  const codes = new Set(Array.from({ length: 100 }, () => generatePairCode()));
  assert.equal(codes.size, 100);
  for (const code of codes) {
    assert.match(code, /^PAIR-[0-9A-HJKMNP-TV-Z]{8}-[0-9A-HJKMNP-TV-Z]{8}-[0-9A-Z*~$=]$/);
    assert.equal(normalizePairCode(code.toLowerCase()), code);
    assert.equal(normalizePairCode(`  ${code.replaceAll("-", " ")}  `), code);
  }

  let code = generatePairCode();
  while (!/[01]/.test(code)) code = generatePairCode();
  const aliased = code.replace("0", "O").replace("1", "L");
  assert.equal(normalizePairCode(aliased), code);
});

test("the check symbol rejects substitutions and adjacent transpositions", () => {
  const code = generatePairCode();
  const body = compact(code).slice(4);
  for (let index = 0; index < body.length; index += 1) {
    const alphabet = index < 8 ? DATA_ALPHABET : CHECK_ALPHABET;
    for (const replacement of alphabet) {
      if (replacement === body[index]) continue;
      assert.throws(() => normalizePairCode(`PAIR${body.slice(0, index)}${replacement}${body.slice(index + 1)}`));
    }
  }
  for (let index = 0; index < 7; index += 1) {
    if (body[index] === body[index + 1]) continue;
    const transposed = body.slice(0, index) + body[index + 1] + body[index] + body.slice(index + 2);
    assert.throws(() => normalizePairCode(`PAIR${transposed}`));
  }
});
