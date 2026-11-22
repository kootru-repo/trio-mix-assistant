import assert from "node:assert/strict";
import test from "node:test";
import { SeededRng, seedState } from "../src/core/rng.ts";
import { ZIG_FI, ZIG_KI, ZIG_WI } from "../src/core/ziggurat.ts";
import { closeArray, f64, fixture } from "./helpers.ts";

const fx = fixture<{ seed: string; random: string; normal: string; grid: string }[]>("rng");

test("SeededRng reproduces the recorded stream for every seed", () => {
  for (const c of fx) {
    const seed = BigInt(c.seed);
    const doubles = f64(c.random);
    const a = new SeededRng(seed);
    const got = Array.from({ length: doubles.length }, () => a.next());
    assert.deepEqual(got, [...doubles], `random() seed ${c.seed}`);

    const normals = f64(c.normal);
    const b = new SeededRng(seed);
    const gotN = new Float64Array(normals.length);
    for (let i = 0; i < gotN.length; i++) gotN[i] = b.standardNormal();
    closeArray(gotN, normals, 1e-12, 1e-14, `standard_normal seed ${c.seed}`);

    const grid = f64(c.grid);
    const g = new SeededRng(seed);
    const gotG = new Float64Array(grid.length);
    for (let i = 0; i < gotG.length; i++) gotG[i] = g.standardNormal();
    closeArray(gotG, grid, 1e-12, 1e-14, `grid seed ${c.seed}`);
  }
});

test("the normal stream has the right mean and spread", () => {
  const r = new SeededRng(12345);
  let sum = 0;
  let sq = 0;
  const n = 100000;
  for (let i = 0; i < n; i++) {
    const v = r.standardNormal();
    sum += v;
    sq += v * v;
  }
  assert.ok(Math.abs(sum / n) < 0.02);
  assert.ok(Math.abs(sq / n - 1) < 0.03);
});

const M128 = (1n << 128n) - 1n;
const M64 = (1n << 64n) - 1n;

class ReferencePcg {
  private state: bigint;
  private readonly inc: bigint;

  constructor(seed: bigint) {
    const [s0, s1, i0, i1] = seedState(seed) as [bigint, bigint, bigint, bigint];
    this.inc = ((((i0 << 64n) | i1) << 1n) | 1n) & M128;
    this.state = 0n;
    this.step();
    this.state = (this.state + ((s0 << 64n) | s1)) & M128;
    this.step();
  }

  private step(): void {
    this.state = (this.state * 0x2360ed051fc65da44385df649fccf645n + this.inc) & M128;
  }

  u64(): bigint {
    this.step();
    const s = this.state;
    const x = (s >> 64n) ^ (s & M64);
    const rot = s >> 122n;
    return ((x >> rot) | (x << ((64n - rot) & 63n))) & M64;
  }

  next(): number {
    return Number(this.u64() >> 11n) / 9007199254740992;
  }

  normal(): number {
    for (;;) {
      let r = this.u64();
      const idx = Number(r & 0xffn);
      r >>= 8n;
      const sign = Number(r & 1n);
      const rabs = (r >> 1n) & 0xfffffffffffffn;
      const rabsN = Number(rabs);
      let x = rabsN * ZIG_WI[idx]!;
      if (sign) x = -x;
      if (rabsN < ZIG_KI[idx]!) return x;
      if (idx === 0) {
        for (;;) {
          const xx = -0.2736612373297583 * Math.log1p(-this.next());
          const yy = -Math.log1p(-this.next());
          if (yy + yy > xx * xx) return Number((rabs >> 8n) & 1n) ? -(3.6541528853610088 + xx) : 3.6541528853610088 + xx;
        }
      } else if ((ZIG_FI[idx - 1]! - ZIG_FI[idx]!) * this.next() + ZIG_FI[idx]! < Math.exp(-0.5 * x * x)) {
        return x;
      }
    }
  }
}

test("the limb-arithmetic generator is bit-identical to a plain BigInt reference over 1e5 draws", () => {
  for (const seed of [0n, 1n, 7n, 12345n, 2n ** 70n + 3n]) {
    const fast = new SeededRng(seed);
    const ref = new ReferencePcg(seed);
    for (let i = 0; i < 50000; i++) {
      const a = fast.next();
      const b = ref.next();
      if (a !== b) assert.fail(`seed ${seed} next() draw ${i}: ${a} vs ${b}`);
    }
    for (let i = 0; i < 50000; i++) {
      const a = fast.standardNormal();
      const b = ref.normal();
      if (a !== b) assert.fail(`seed ${seed} standardNormal() draw ${i}: ${a} vs ${b}`);
    }
  }
});
