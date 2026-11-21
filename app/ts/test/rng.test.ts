import assert from "node:assert/strict";
import test from "node:test";
import { SeededRng } from "../src/core/rng.ts";
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
