// Copyright (c) 2026 Laurin Weger, Par le Peuple, NextGraph.org developers
// All rights reserved.
// Licensed under the Apache License, Version 2.0
// <LICENSE-APACHE2 or http://www.apache.org/licenses/LICENSE-2.0>
// or the MIT license <LICENSE-MIT or http://opensource.org/licenses/MIT>,
// at your option. All files in the project carrying such
// notice may not be copied, modified, or distributed except
// according to those terms.
// SPDX-License-Identifier: Apache-2.0 OR MIT

const VERSION = 4;
const SIZE = VERSION * 4 + 17;
const DATA_CODEWORDS = 80;
const ERROR_CODEWORDS = 20;
const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

export type QrCode = { version: 4; mask: number; modules: boolean[][] };

function appendBits(target: number[], value: number, length: number) {
  for (let bit = length - 1; bit >= 0; bit -= 1) target.push(((value >>> bit) & 1) !== 0 ? 1 : 0);
}

/**
 * Pad a mode+payload bit sequence out to `DATA_CODEWORDS` bytes: a
 * terminator (up to 4 zero bits), padding to a byte boundary, then
 * alternating fill bytes. Shared by both QR modes below - this part of the
 * spec doesn't care what produced the bits, only how many there are.
 */
function finishBits(bits: number[]): number[] {
  const capacity = DATA_CODEWORDS * 8;
  if (bits.length > capacity) {
    throw new Error(`QR payload needs ${bits.length} bits; this QR version holds ${capacity}.`);
  }
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const bytes: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8).join(""), 2));
  }
  for (let pad = 0; bytes.length < DATA_CODEWORDS; pad += 1) bytes.push(pad % 2 === 0 ? 0xec : 0x11);
  return bytes;
}

/** QR "alphanumeric" mode: this app's own pairing/pair/copy codes fit entirely
 * within its restricted character set, so this mode packs them at roughly
 * 5.5 bits/character rather than byte mode's 8. */
function alphanumericBits(text: string): number[] {
  if (text.length > 114 || [...text].some((character) => !ALPHANUMERIC.includes(character))) {
    throw new Error("QR payload must be at most 114 QR-alphanumeric characters.");
  }
  const bits: number[] = [];
  appendBits(bits, 0b0010, 4); // Alphanumeric mode.
  appendBits(bits, text.length, 9); // Version 1-9 character count width.
  for (let index = 0; index + 1 < text.length; index += 2) {
    appendBits(bits, ALPHANUMERIC.indexOf(text[index]) * 45 + ALPHANUMERIC.indexOf(text[index + 1]), 11);
  }
  if (text.length % 2 === 1) appendBits(bits, ALPHANUMERIC.indexOf(text.at(-1)!), 6);
  return bits;
}

/** QR "byte" mode: the only mode that can hold a URL - lowercase letters,
 * `?`, `=`, `/` and `.` are all outside alphanumeric mode's character set. */
function byteBits(text: string): number[] {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 255) {
    throw new Error("QR payload must be at most 255 bytes (this QR version holds far fewer than that anyway).");
  }
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4); // Byte mode.
  appendBits(bits, bytes.length, 8); // Version 1-9 byte-count width.
  for (const byte of bytes) appendBits(bits, byte, 8);
  return bits;
}

function gfMultiply(left: number, right: number): number {
  let result = 0;
  for (let bit = 7; bit >= 0; bit -= 1) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d);
    if (((right >>> bit) & 1) !== 0) result ^= left;
  }
  return result;
}

function reedSolomonGenerator(degree: number): number[] {
  let generator = [1];
  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    const next = Array(generator.length + 1).fill(0) as number[];
    for (let term = 0; term < generator.length; term += 1) {
      next[term] ^= generator[term];
      next[term + 1] ^= gfMultiply(generator[term], root);
    }
    generator = next;
    root = gfMultiply(root, 2);
  }
  return generator;
}

function addErrorCorrection(data: number[]): number[] {
  const generator = reedSolomonGenerator(ERROR_CODEWORDS);
  const work = [...data, ...Array(ERROR_CODEWORDS).fill(0)] as number[];
  for (let index = 0; index < data.length; index += 1) {
    const factor = work[index];
    if (factor === 0) continue;
    for (let term = 0; term < generator.length; term += 1) {
      work[index + term] ^= gfMultiply(generator[term], factor);
    }
  }
  return [...data, ...work.slice(data.length)];
}

type Matrix = Array<Array<boolean | null>>;

function blankMatrix(): { modules: Matrix; functions: boolean[][] } {
  return {
    modules: Array.from({ length: SIZE }, () => Array<boolean | null>(SIZE).fill(null)),
    functions: Array.from({ length: SIZE }, () => Array<boolean>(SIZE).fill(false)),
  };
}

function drawFunctionPatterns(modules: Matrix, functions: boolean[][]) {
  const set = (x: number, y: number, dark: boolean) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    modules[y][x] = dark;
    functions[y][x] = true;
  };
  for (let index = 0; index < SIZE; index += 1) {
    set(6, index, index % 2 === 0);
    set(index, 6, index % 2 === 0);
  }
  for (const [centerX, centerY] of [[3, 3], [SIZE - 4, 3], [3, SIZE - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        set(centerX + dx, centerY + dy, distance !== 2 && distance !== 4);
      }
    }
  }
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      set(26 + dx, 26 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  drawFormatBits(modules, functions, 0);
}

function formatValue(mask: number): number {
  const data = (0b01 << 3) | mask; // Error correction level L.
  let remainder = data;
  for (let index = 0; index < 10; index += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function drawFormatBits(modules: Matrix, functions: boolean[][], mask: number) {
  const bits = formatValue(mask);
  const set = (x: number, y: number, bit: number) => {
    modules[y][x] = ((bits >>> bit) & 1) !== 0;
    functions[y][x] = true;
  };
  for (let index = 0; index <= 5; index += 1) set(8, index, index);
  set(8, 7, 6);
  set(8, 8, 7);
  set(7, 8, 8);
  for (let index = 9; index < 15; index += 1) set(14 - index, 8, index);
  for (let index = 0; index < 8; index += 1) set(SIZE - 1 - index, 8, index);
  for (let index = 8; index < 15; index += 1) set(8, SIZE - 15 + index, index);
  modules[SIZE - 8][8] = true;
  functions[SIZE - 8][8] = true;
}

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

function drawCodewords(base: Matrix, functions: boolean[][], codewords: number[], mask: number): boolean[][] {
  const modules = base.map((row) => [...row]);
  let bitIndex = 0;
  let upward = true;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < SIZE; vertical += 1) {
      const y = upward ? SIZE - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        if (functions[y][x]) continue;
        const raw = bitIndex < codewords.length * 8
          ? ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0
          : false;
        modules[y][x] = raw !== maskApplies(mask, x, y);
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
  if (bitIndex < codewords.length * 8) throw new Error("QR matrix did not have room for every codeword.");
  drawFormatBits(modules, functions.map((row) => [...row]), mask);
  return modules as boolean[][];
}

function penalty(modules: boolean[][]): number {
  let score = 0;
  const lines = [
    ...modules,
    ...Array.from({ length: SIZE }, (_, x) => modules.map((row) => row[x])),
  ];
  for (const line of lines) {
    let run = 1;
    for (let index = 1; index <= SIZE; index += 1) {
      if (index < SIZE && line[index] === line[index - 1]) run += 1;
      else {
        if (run >= 5) score += 3 + run - 5;
        run = 1;
      }
    }
    const pattern = line.map((dark) => dark ? "1" : "0").join("");
    for (let index = 0; index <= SIZE - 11; index += 1) {
      const window = pattern.slice(index, index + 11);
      if (window === "00001011101" || window === "10111010000") score += 40;
    }
  }
  for (let y = 0; y < SIZE - 1; y += 1) {
    for (let x = 0; x < SIZE - 1; x += 1) {
      const value = modules[y][x];
      if (modules[y][x + 1] === value && modules[y + 1][x] === value && modules[y + 1][x + 1] === value) {
        score += 3;
      }
    }
  }
  const dark = modules.reduce((total, row) => total + row.filter(Boolean).length, 0);
  score += Math.floor(Math.abs(dark * 20 - SIZE * SIZE * 10) / (SIZE * SIZE)) * 10;
  return score;
}

function buildQr(payloadBits: number[]): QrCode {
  const codewords = addErrorCorrection(finishBits(payloadBits));
  const { modules: base, functions } = blankMatrix();
  drawFunctionPatterns(base, functions);
  let best: QrCode | undefined;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = drawCodewords(base, functions, codewords, mask);
    const candidatePenalty = penalty(modules);
    if (candidatePenalty < bestPenalty) {
      best = { version: VERSION, mask, modules };
      bestPenalty = candidatePenalty;
    }
  }
  return best!;
}

/** Encode an LG1 pairing string as a standards-compliant Version 4-L QR matrix. */
export function encodePairingQr(text: string): QrCode {
  return buildQr(alphanumericBits(text));
}

/**
 * Encode an https:// invite link (COPY or PAIR) as a Version 4-L QR matrix.
 * Byte mode's overhead means less room than `encodePairingQr` gets from the
 * same 80 data codewords - about 78 bytes here, comfortably above a typical
 * `https://<host>/join?token=<uuid>` (a bare UUID token is 36 characters),
 * but not unbounded for an unusually long self-hosted domain. Throws rather
 * than truncating a link into one that silently resolves to something else;
 * callers already treat a QR as optional and fall back to the copyable link.
 */
export function encodeLinkQr(url: string): QrCode {
  return buildQr(byteBits(url));
}
