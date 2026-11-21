import { utf8Encode } from "./oscwire.ts";

const MODE_NUMBER = 1;
const MODE_ALPHA_NUM = 2;
const MODE_8BIT_BYTE = 4;

const ALPHA_NUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const NUMBER_LENGTH = [0, 4, 7, 10];
const PAD0 = 0xec;
const PAD1 = 0x11;
const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1;
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1;
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);
const EC_LEVEL_M = 0;
const OPTIMIZE = 20;

const PATTERN_POSITION_TABLE: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

const RS_M: number[][] = [
  [1, 26, 16],
  [1, 44, 28],
  [1, 70, 44],
  [2, 50, 32],
  [2, 67, 43],
  [4, 43, 27],
  [4, 49, 31],
  [2, 60, 38, 2, 61, 39],
  [3, 58, 36, 2, 59, 37],
  [4, 69, 43, 1, 70, 44],
  [1, 80, 50, 4, 81, 51],
  [6, 58, 36, 2, 59, 37],
  [8, 59, 37, 1, 60, 38],
  [4, 64, 40, 5, 65, 41],
  [5, 65, 41, 5, 66, 42],
  [7, 73, 45, 3, 74, 46],
  [10, 74, 46, 1, 75, 47],
  [9, 69, 43, 4, 70, 44],
  [3, 70, 44, 11, 71, 45],
  [3, 67, 41, 13, 68, 42],
  [17, 68, 42],
  [17, 74, 46],
  [4, 75, 47, 14, 76, 48],
  [6, 73, 45, 14, 74, 46],
  [8, 75, 47, 13, 76, 48],
  [19, 74, 46, 4, 75, 47],
  [22, 73, 45, 3, 74, 46],
  [3, 73, 45, 23, 74, 46],
  [21, 73, 45, 7, 74, 46],
  [19, 75, 47, 10, 76, 48],
  [2, 74, 46, 29, 75, 47],
  [10, 74, 46, 23, 75, 47],
  [14, 74, 46, 21, 75, 47],
  [14, 74, 46, 23, 75, 47],
  [12, 75, 47, 26, 76, 48],
  [6, 75, 47, 34, 76, 48],
  [29, 74, 46, 14, 75, 47],
  [13, 74, 46, 32, 75, 47],
  [40, 75, 47, 7, 76, 48],
  [18, 75, 47, 31, 76, 48],
];

interface Chunk {
  mode: number;
  data: number[];
}

type Cell = boolean | null;

export interface QrCode {
  version: number;
  modules: boolean[][];
}

const EXP_TABLE: number[] = new Array<number>(256).fill(0);
const LOG_TABLE: number[] = new Array<number>(256).fill(0);
for (let i = 0; i < 8; i++) EXP_TABLE[i] = 1 << i;
for (let i = 8; i < 256; i++) {
  EXP_TABLE[i] = EXP_TABLE[i - 4]! ^ EXP_TABLE[i - 5]! ^ EXP_TABLE[i - 6]! ^ EXP_TABLE[i - 8]!;
}
for (let i = 0; i < 255; i++) LOG_TABLE[EXP_TABLE[i]!] = i;

const gexp = (n: number): number => EXP_TABLE[n % 255]!;
const glog = (n: number): number => LOG_TABLE[n]!;

function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}

function isAlphaNum(b: number): boolean {
  return b < 128 && ALPHA_NUM.includes(String.fromCharCode(b));
}

function splitRuns(
  data: number[],
  cls: (b: number) => boolean,
  anchored: boolean,
): { hit: boolean; chunk: number[] }[] {
  const out: { hit: boolean; chunk: number[] }[] = [];
  let rest = data;
  while (rest.length > 0) {
    let start = -1;
    let end = -1;
    if (anchored) {
      let e = 0;
      while (e < rest.length && cls(rest[e]!)) e++;
      if (e > 0 && (e === rest.length || (e === rest.length - 1 && rest[e] === 10))) {
        start = 0;
        end = e;
      }
    } else {
      let i = 0;
      while (i < rest.length) {
        if (!cls(rest[i]!)) {
          i++;
          continue;
        }
        let e = i;
        while (e < rest.length && cls(rest[e]!)) e++;
        if (e - i >= OPTIMIZE) {
          start = i;
          end = e;
          break;
        }
        i = e;
      }
    }
    if (start < 0) break;
    if (start > 0) out.push({ hit: false, chunk: rest.slice(0, start) });
    out.push({ hit: true, chunk: rest.slice(start, end) });
    rest = rest.slice(end);
  }
  if (rest.length > 0) out.push({ hit: false, chunk: rest });
  return out;
}

function optimalChunks(bytes: number[]): Chunk[] {
  const anchored = bytes.length <= OPTIMIZE;
  const out: Chunk[] = [];
  for (const num of splitRuns(bytes, isDigit, anchored)) {
    if (num.hit) {
      out.push({ mode: MODE_NUMBER, data: num.chunk });
      continue;
    }
    for (const alpha of splitRuns(num.chunk, isAlphaNum, anchored)) {
      out.push({ mode: alpha.hit ? MODE_ALPHA_NUM : MODE_8BIT_BYTE, data: alpha.chunk });
    }
  }
  return out;
}

function lengthBits(mode: number, version: number): number {
  const idx = mode === MODE_NUMBER ? 0 : mode === MODE_ALPHA_NUM ? 1 : 2;
  if (version < 10) return [10, 9, 8][idx]!;
  if (version < 27) return [12, 11, 16][idx]!;
  return [14, 13, 16][idx]!;
}

class BitBuffer {
  bits: number[] = [];

  put(num: number, length: number): void {
    for (let i = 0; i < length; i++) this.bits.push((num >> (length - i - 1)) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  toBytes(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.bits.length; i++) {
      const k = i >> 3;
      if (out.length <= k) out.push(0);
      if (this.bits[i]) out[k] = out[k]! | (0x80 >> (i % 8));
    }
    return out;
  }
}

function writeChunk(buffer: BitBuffer, chunk: Chunk): void {
  const d = chunk.data;
  if (chunk.mode === MODE_NUMBER) {
    for (let i = 0; i < d.length; i += 3) {
      const part = d.slice(i, i + 3);
      let v = 0;
      for (const c of part) v = v * 10 + (c - 0x30);
      buffer.put(v, NUMBER_LENGTH[part.length]!);
    }
  } else if (chunk.mode === MODE_ALPHA_NUM) {
    const idx = (c: number): number => ALPHA_NUM.indexOf(String.fromCharCode(c));
    for (let i = 0; i < d.length; i += 2) {
      if (i + 1 < d.length) buffer.put(idx(d[i]!) * 45 + idx(d[i + 1]!), 11);
      else buffer.put(idx(d[i]!), 6);
    }
  } else {
    for (const c of d) buffer.put(c, 8);
  }
}

function rsBlocks(version: number): { total: number; data: number }[] {
  const row = RS_M[version - 1]!;
  const blocks: { total: number; data: number }[] = [];
  for (let i = 0; i < row.length; i += 3) {
    for (let k = 0; k < row[i]!; k++) blocks.push({ total: row[i + 1]!, data: row[i + 2]! });
  }
  return blocks;
}

function bitLimit(version: number): number {
  let n = 0;
  for (const b of rsBlocks(version)) n += b.data * 8;
  return n;
}

function bestFit(chunks: Chunk[]): number {
  let start = 1;
  for (;;) {
    const buffer = new BitBuffer();
    for (const c of chunks) {
      buffer.put(c.mode, 4);
      buffer.put(c.data.length, lengthBits(c.mode, start));
      writeChunk(buffer, c);
    }
    const needed = buffer.length;
    let version = start;
    while (version <= 40 && bitLimit(version) < needed) version++;
    if (version === 41) throw new Error("QR data overflow");
    const group = (v: number): number => (v < 10 ? 0 : v < 27 ? 1 : 2);
    if (group(start) === group(version)) return version;
    start = version;
  }
}

function generatorPoly(ecCount: number): number[] {
  let poly = [1];
  for (let i = 0; i < ecCount; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let a = 0; a < poly.length; a++) {
      next[a] = next[a]! ^ poly[a]!;
      next[a + 1] = next[a + 1]! ^ gexp(glog(poly[a]!) + i);
    }
    poly = next;
  }
  return poly;
}

function ecBytes(data: number[], ecCount: number): number[] {
  const gen = generatorPoly(ecCount);
  const work = data.concat(new Array<number>(ecCount).fill(0));
  for (let i = 0; i < data.length; i++) {
    const lead = work[i]!;
    if (lead === 0) continue;
    const ratio = glog(lead);
    for (let j = 0; j < gen.length; j++) {
      work[i + j] = work[i + j]! ^ gexp(glog(gen[j]!) + ratio);
    }
  }
  return work.slice(data.length);
}

function createData(version: number, chunks: Chunk[]): number[] {
  const buffer = new BitBuffer();
  for (const c of chunks) {
    buffer.put(c.mode, 4);
    buffer.put(c.data.length, lengthBits(c.mode, version));
    writeChunk(buffer, c);
  }
  const blocks = rsBlocks(version);
  const limit = bitLimit(version);
  if (buffer.length > limit) throw new Error("QR data overflow");
  const term = Math.min(limit - buffer.length, 4);
  for (let i = 0; i < term; i++) buffer.put(0, 1);
  const delimit = buffer.length % 8;
  if (delimit) for (let i = 0; i < 8 - delimit; i++) buffer.put(0, 1);
  const fill = (limit - buffer.length) >> 3;
  for (let i = 0; i < fill; i++) buffer.put(i % 2 === 0 ? PAD0 : PAD1, 8);

  const bytes = buffer.toBytes();
  const dc: number[][] = [];
  const ec: number[][] = [];
  let offset = 0;
  let maxDc = 0;
  let maxEc = 0;
  for (const b of blocks) {
    const cur = bytes.slice(offset, offset + b.data);
    offset += b.data;
    const eccount = b.total - b.data;
    maxDc = Math.max(maxDc, b.data);
    maxEc = Math.max(maxEc, eccount);
    dc.push(cur);
    ec.push(ecBytes(cur, eccount));
  }
  const out: number[] = [];
  for (let i = 0; i < maxDc; i++) for (const d of dc) if (i < d.length) out.push(d[i]!);
  for (let i = 0; i < maxEc; i++) for (const e of ec) if (i < e.length) out.push(e[i]!);
  return out;
}

function bchDigit(data: number): number {
  let digit = 0;
  while (data !== 0) {
    digit++;
    data >>= 1;
  }
  return digit;
}

function bchTypeInfo(data: number): number {
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ G15_MASK;
}

function bchTypeNumber(data: number): number {
  let d = data << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  return (data << 12) | d;
}

function maskFunc(pattern: number): (i: number, j: number) => boolean {
  switch (pattern) {
    case 0:
      return (i, j) => (i + j) % 2 === 0;
    case 1:
      return (i) => i % 2 === 0;
    case 2:
      return (_i, j) => j % 3 === 0;
    case 3:
      return (i, j) => (i + j) % 3 === 0;
    case 4:
      return (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5:
      return (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6:
      return (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    default:
      return (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
  }
}

function lostPoint(m: boolean[][]): number {
  const n = m.length;
  const at = (r: number, c: number): boolean => m[r]![c]!;
  let lost = 0;

  const container = new Array<number>(n + 1).fill(0);
  for (let row = 0; row < n; row++) {
    let prev = at(row, 0);
    let length = 0;
    for (let col = 0; col < n; col++) {
      if (at(row, col) === prev) length++;
      else {
        if (length >= 5) container[length]!++;
        length = 1;
        prev = at(row, col);
      }
    }
    if (length >= 5) container[length]!++;
  }
  for (let col = 0; col < n; col++) {
    let prev = at(0, col);
    let length = 0;
    for (let row = 0; row < n; row++) {
      if (at(row, col) === prev) length++;
      else {
        if (length >= 5) container[length]!++;
        length = 1;
        prev = at(row, col);
      }
    }
    if (length >= 5) container[length]!++;
  }
  for (let len = 5; len <= n; len++) lost += container[len]! * (len - 2);

  for (let row = 0; row < n - 1; row++) {
    for (let col = 0; col < n - 1; col++) {
      const topRight = at(row, col + 1);
      if (topRight !== at(row + 1, col + 1)) {
        col++;
      } else if (topRight !== at(row, col)) {
        continue;
      } else if (topRight !== at(row + 1, col)) {
        continue;
      } else {
        lost += 3;
      }
    }
  }

  const scan = (get: (k: number, i: number) => boolean): void => {
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n - 10; i++) {
        if (
          !get(k, i + 1) &&
          get(k, i + 4) &&
          !get(k, i + 5) &&
          get(k, i + 6) &&
          !get(k, i + 9) &&
          ((get(k, i) &&
            get(k, i + 2) &&
            get(k, i + 3) &&
            !get(k, i + 7) &&
            !get(k, i + 8) &&
            !get(k, i + 10)) ||
            (!get(k, i) &&
              !get(k, i + 2) &&
              !get(k, i + 3) &&
              get(k, i + 7) &&
              get(k, i + 8) &&
              get(k, i + 10)))
        ) {
          lost += 40;
        }
        if (get(k, i + 10)) i++;
      }
    }
  };
  scan((k, i) => at(k, i));
  scan((k, i) => at(i, k));

  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const percent = dark / (n * n);
  const rating = Math.trunc(Math.abs(percent * 100 - 50) / 5);
  return lost + rating * 10;
}

function blankModules(version: number): Cell[][] {
  const n = version * 4 + 17;
  const modules: Cell[][] = [];
  for (let i = 0; i < n; i++) modules.push(new Array<Cell>(n).fill(null));

  const probe = (row: number, col: number): void => {
    for (let r = -1; r < 8; r++) {
      if (row + r <= -1 || n <= row + r) continue;
      for (let c = -1; c < 8; c++) {
        if (col + c <= -1 || n <= col + c) continue;
        const dark =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        modules[row + r]![col + c] = dark;
      }
    }
  };
  probe(0, 0);
  probe(n - 7, 0);
  probe(0, n - 7);

  const pos = PATTERN_POSITION_TABLE[version - 1]!;
  for (const row of pos) {
    for (const col of pos) {
      if (modules[row]![col] !== null) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          modules[row + r]![col + c] =
            r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
        }
      }
    }
  }

  for (let r = 8; r < n - 8; r++) {
    if (modules[r]![6] !== null) continue;
    modules[r]![6] = r % 2 === 0;
  }
  for (let c = 8; c < n - 8; c++) {
    if (modules[6]![c] !== null) continue;
    modules[6]![c] = c % 2 === 0;
  }
  return modules;
}

function makeImpl(
  version: number,
  data: number[],
  test: boolean,
  mask: number,
  blank: Cell[][],
): Cell[][] {
  const n = version * 4 + 17;
  const modules = blank.map((r) => r.slice());

  const bits = bchTypeInfo((EC_LEVEL_M << 3) | mask);
  for (let i = 0; i < 15; i++) {
    const mod = !test && ((bits >> i) & 1) === 1;
    if (i < 6) modules[i]![8] = mod;
    else if (i < 8) modules[i + 1]![8] = mod;
    else modules[n - 15 + i]![8] = mod;
  }
  for (let i = 0; i < 15; i++) {
    const mod = !test && ((bits >> i) & 1) === 1;
    if (i < 8) modules[8]![n - i - 1] = mod;
    else if (i < 9) modules[8]![15 - i - 1 + 1] = mod;
    else modules[8]![15 - i - 1] = mod;
  }
  modules[n - 8]![8] = !test;

  if (version >= 7) {
    const vbits = bchTypeNumber(version);
    for (let i = 0; i < 18; i++) {
      const mod = !test && ((vbits >> i) & 1) === 1;
      modules[Math.floor(i / 3)]![(i % 3) + n - 8 - 3] = mod;
    }
    for (let i = 0; i < 18; i++) {
      const mod = !test && ((vbits >> i) & 1) === 1;
      modules[(i % 3) + n - 8 - 3]![Math.floor(i / 3)] = mod;
    }
  }

  let inc = -1;
  let row = n - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  const fn = maskFunc(mask);
  for (let col0 = n - 1; col0 > 0; col0 -= 2) {
    const col = col0 <= 6 ? col0 - 1 : col0;
    for (;;) {
      for (const c of [col, col - 1]) {
        if (modules[row]![c] === null) {
          let dark = false;
          if (byteIndex < data.length) dark = ((data[byteIndex]! >> bitIndex) & 1) === 1;
          if (fn(row, c)) dark = !dark;
          modules[row]![c] = dark;
          bitIndex--;
          if (bitIndex === -1) {
            byteIndex++;
            bitIndex = 7;
          }
        }
      }
      row += inc;
      if (row < 0 || n <= row) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
  return modules;
}

export function qrEncode(text: string): QrCode {
  const chunks = optimalChunks(Array.from(utf8Encode(text)));
  const version = bestFit(chunks);
  const data = createData(version, chunks);
  const blank = blankModules(version);
  let best = 0;
  let min = 0;
  for (let i = 0; i < 8; i++) {
    const test = makeImpl(version, data, true, i, blank) as boolean[][];
    const lost = lostPoint(test);
    if (i === 0 || min > lost) {
      min = lost;
      best = i;
    }
  }
  return { version, modules: makeImpl(version, data, false, best, blank) as boolean[][] };
}

export function qrAscii(modules: boolean[][], border = 2, invert = true): string[] {
  const n = modules.length;
  const codes = [" ", "▀", "▄", "█"];
  if (invert) codes.reverse();
  const get = (x: number, y: number): number => {
    if (invert && border && Math.max(x, y) >= n + border) return 1;
    if (Math.min(x, y) < 0 || Math.max(x, y) >= n) return 0;
    return modules[x]![y]! ? 1 : 0;
  };
  const lines: string[] = [];
  for (let r = -border; r < n + border; r += 2) {
    let line = "";
    for (let c = -border; c < n + border; c++) line += codes[get(r, c) + (get(r + 1, c) << 1)]!;
    lines.push(line);
  }
  return lines;
}
