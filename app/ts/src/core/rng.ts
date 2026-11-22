import { ZIG_FI, ZIG_KI, ZIG_WI } from "./ziggurat.ts";

export interface Rng {
  next(): number;
  standardNormal(): number;
}

const M32 = 0xffffffffn;
const M128 = (1n << 128n) - 1n;
const PCG_MULT = 0x2360ed051fc65da44385df649fccf645n;

const INIT_A = 0x43b0d7e5;
const MULT_A = 0x931e8875;
const INIT_B = 0x8b51f9dd;
const MULT_B = 0x58f38ded;
const MIX_MULT_L = 0xca01f9dd;
const MIX_MULT_R = 0x4973f715;

const mul32 = (a: number, b: number): number => Math.imul(a, b) >>> 0;

function hashmix(value: number, hc: { v: number }): number {
  let x = (value ^ hc.v) >>> 0;
  hc.v = mul32(hc.v, MULT_A);
  x = mul32(x, hc.v);
  return (x ^ (x >>> 16)) >>> 0;
}

function mix(x: number, y: number): number {
  const r = (mul32(MIX_MULT_L, x) - mul32(MIX_MULT_R, y)) >>> 0;
  return (r ^ (r >>> 16)) >>> 0;
}

function entropyWords(seed: bigint): number[] {
  if (seed === 0n) return [0];
  const words: number[] = [];
  let s = seed;
  while (s > 0n) {
    words.push(Number(s & M32));
    s >>= 32n;
  }
  return words;
}

export function seedState(seed: bigint): bigint[] {
  const entropy = entropyWords(seed);
  const pool = [0, 0, 0, 0];
  const hc = { v: INIT_A };
  for (let i = 0; i < 4; i++) pool[i] = hashmix(i < entropy.length ? entropy[i]! : 0, hc);
  for (let src = 0; src < 4; src++) {
    for (let dst = 0; dst < 4; dst++) {
      if (src !== dst) pool[dst] = mix(pool[dst]!, hashmix(pool[src]!, hc));
    }
  }
  for (let src = 4; src < entropy.length; src++) {
    for (let dst = 0; dst < 4; dst++) pool[dst] = mix(pool[dst]!, hashmix(entropy[src]!, hc));
  }
  const words: number[] = [];
  const hb = { v: INIT_B };
  for (let i = 0; i < 8; i++) {
    let d = (pool[i % 4]! ^ hb.v) >>> 0;
    hb.v = mul32(hb.v, MULT_B);
    d = mul32(d, hb.v);
    words.push((d ^ (d >>> 16)) >>> 0);
  }
  const out: bigint[] = [];
  for (let k = 0; k < 4; k++) out.push(BigInt(words[2 * k]!) | (BigInt(words[2 * k + 1]!) << 32n));
  return out;
}

const MULT_LIMBS = limbs(PCG_MULT);

function limbs(x: bigint): Uint32Array {
  const out = new Uint32Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((x >> BigInt(16 * i)) & 0xffffn);
  return out;
}

class Pcg64 {
  private readonly s = new Uint32Array(8);
  private readonly t = new Uint32Array(8);
  private readonly inc: Uint32Array;
  hi = 0;
  lo = 0;

  constructor(seed: bigint) {
    const [s0, s1, i0, i1] = seedState(seed) as [bigint, bigint, bigint, bigint];
    const initstate = (s0 << 64n) | s1;
    const initseq = (i0 << 64n) | i1;
    const inc = ((initseq << 1n) | 1n) & M128;
    let state = inc;
    state = (state + initstate) & M128;
    state = (state * PCG_MULT + inc) & M128;
    this.inc = limbs(inc);
    this.s.set(limbs(state));
  }

  private step(): void {
    const s = this.s;
    const t = this.t;
    const inc = this.inc;
    let carry = 0;
    for (let k = 0; k < 8; k++) {
      let acc = carry + inc[k]!;
      for (let i = 0; i <= k; i++) acc += s[i]! * MULT_LIMBS[k - i]!;
      t[k] = acc % 65536;
      carry = Math.floor(acc / 65536);
    }
    s.set(t);
  }

  next64(): void {
    this.step();
    const s = this.s;
    const lo0 = (s[0]! | (s[1]! << 16)) >>> 0;
    const lo1 = (s[2]! | (s[3]! << 16)) >>> 0;
    const hi0 = (s[4]! | (s[5]! << 16)) >>> 0;
    const hi1 = (s[6]! | (s[7]! << 16)) >>> 0;
    const xl = (lo0 ^ hi0) >>> 0;
    const xh = (lo1 ^ hi1) >>> 0;
    const rot = s[7]! >>> 10;
    if (rot === 0) {
      this.hi = xh;
      this.lo = xl;
    } else if (rot < 32) {
      this.lo = ((xl >>> rot) | (xh << (32 - rot))) >>> 0;
      this.hi = ((xh >>> rot) | (xl << (32 - rot))) >>> 0;
    } else if (rot === 32) {
      this.lo = xh;
      this.hi = xl;
    } else {
      const r = rot - 32;
      this.lo = ((xh >>> r) | (xl << (32 - r))) >>> 0;
      this.hi = ((xl >>> r) | (xh << (32 - r))) >>> 0;
    }
  }
}

const NOR_R = 3.6541528853610088;
const NOR_INV_R = 0.2736612373297583;
const TWO_NEG_53 = 1 / 9007199254740992;

export class SeededRng implements Rng {
  private readonly bits: Pcg64;

  constructor(seed: number | bigint = 7) {
    this.bits = new Pcg64(BigInt(seed));
  }

  next(): number {
    this.bits.next64();
    return (this.bits.hi * 2097152 + (this.bits.lo >>> 11)) * TWO_NEG_53;
  }

  standardNormal(): number {
    const b = this.bits;
    for (;;) {
      b.next64();
      const hi = b.hi;
      const lo = b.lo;
      const idx = lo & 0xff;
      const lo8 = ((lo >>> 8) | ((hi & 0xff) << 24)) >>> 0;
      const hi8 = hi >>> 8;
      const sign = lo8 & 1;
      const low = ((lo8 >>> 1) | ((hi8 & 1) << 31)) >>> 0;
      const rabsN = ((hi8 >>> 1) & 0xfffff) * 4294967296 + low;
      let x = rabsN * ZIG_WI[idx]!;
      if (sign) x = -x;
      if (rabsN < ZIG_KI[idx]!) return x;
      if (idx === 0) {
        for (;;) {
          const xx = -NOR_INV_R * Math.log1p(-this.next());
          const yy = -Math.log1p(-this.next());
          if (yy + yy > xx * xx) return (low >>> 8) & 1 ? -(NOR_R + xx) : NOR_R + xx;
        }
      } else if ((ZIG_FI[idx - 1]! - ZIG_FI[idx]!) * this.next() + ZIG_FI[idx]! < Math.exp(-0.5 * x * x)) {
        return x;
      }
    }
  }
}
