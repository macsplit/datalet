import assert from "node:assert/strict";
import { test } from "node:test";
import { encodePairingCode } from "../../src/utils/pairingCode.ts";
import { encodePairingQr } from "../../src/utils/qrCode.ts";

const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return (x * y) % 2 + (x * y) % 3 === 0;
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
    default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
  }
}

function functionModules(size: number): boolean[][] {
  const result = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const mark = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < size && y < size) result[y][x] = true;
  };
  for (let index = 0; index < size; index += 1) {
    mark(6, index);
    mark(index, 6);
  }
  for (const [centerX, centerY] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) mark(centerX + dx, centerY + dy);
    }
  }
  for (let y = 24; y <= 28; y += 1) for (let x = 24; x <= 28; x += 1) mark(x, y);
  for (let index = 0; index <= 5; index += 1) mark(8, index);
  mark(8, 7);
  mark(8, 8);
  mark(7, 8);
  for (let index = 9; index < 15; index += 1) mark(14 - index, 8);
  for (let index = 0; index < 8; index += 1) mark(size - 1 - index, 8);
  for (let index = 8; index < 15; index += 1) mark(8, size - 15 + index);
  mark(8, size - 8);
  return result;
}

function readCodewords(modules: boolean[][], mask: number): number[] {
  const size = modules.length;
  const functions = functionModules(size);
  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      const y = upward ? size - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        if (!functions[y][x]) bits.push(Number(modules[y][x] !== maskApplies(mask, x, y)));
      }
    }
    upward = !upward;
  }
  const bytes: number[] = [];
  for (let index = 0; index < 800; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8).join(""), 2));
  }
  return bytes;
}

function gfMultiply(left: number, right: number): number {
  let result = 0;
  for (let bit = 7; bit >= 0; bit -= 1) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d);
    if (((right >>> bit) & 1) !== 0) result ^= left;
  }
  return result;
}

function gfPower(power: number): number {
  let result = 1;
  for (let index = 0; index < power; index += 1) result = gfMultiply(result, 2);
  return result;
}

function decodeAlphanumeric(data: number[]): string {
  const bits = data.slice(0, 80).flatMap((byte) =>
    Array.from({ length: 8 }, (_, bit) => (byte >>> (7 - bit)) & 1),
  );
  let offset = 0;
  const take = (length: number) => {
    const value = Number.parseInt(bits.slice(offset, offset + length).join(""), 2);
    offset += length;
    return value;
  };
  assert.equal(take(4), 0b0010);
  const count = take(9);
  let decoded = "";
  while (decoded.length + 1 < count) {
    const pair = take(11);
    decoded += ALPHANUMERIC[Math.floor(pair / 45)] + ALPHANUMERIC[pair % 45];
  }
  if (decoded.length < count) decoded += ALPHANUMERIC[take(6)];
  return decoded;
}

test("the Version 4-L QR matrix round-trips an LG1 code with valid Reed-Solomon parity", () => {
  const pairingCode = encodePairingCode(
    "00112233-4455-4677-8899-aabbccddeeff",
    "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX",
  );
  const qr = encodePairingQr(pairingCode);
  assert.equal(qr.version, 4);
  assert.equal(qr.modules.length, 33);
  assert.ok(qr.mask >= 0 && qr.mask <= 7);

  const codewords = readCodewords(qr.modules, qr.mask);
  assert.equal(codewords.length, 100);
  for (let root = 0; root < 20; root += 1) {
    let syndrome = 0;
    const point = gfPower(root);
    for (const codeword of codewords) syndrome = gfMultiply(syndrome, point) ^ codeword;
    assert.equal(syndrome, 0, `Reed-Solomon syndrome ${root}`);
  }
  assert.equal(decodeAlphanumeric(codewords), pairingCode);
});
