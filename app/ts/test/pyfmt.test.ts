import assert from "node:assert/strict";
import test from "node:test";
import { fixed, percent, pyRound, pyRoundTo, signed } from "../src/core/pyfmt.ts";
import { fixture } from "./helpers.ts";

test("number formatting matches Python's format and round, including exact ties", () => {
  for (const r of fixture<any[]>("fmt")) {
    const x = r.x as number;
    assert.equal(fixed(x, 0), r.f0, `${x} .0f`);
    assert.equal(fixed(x, 1), r.f1, `${x} .1f`);
    assert.equal(fixed(x, 2), r.f2, `${x} .2f`);
    assert.equal(fixed(x, 3), r.f3, `${x} .3f`);
    assert.equal(signed(x, 1), r.s1, `${x} +.1f`);
    assert.equal(signed(x, 0), r.s0, `${x} +.0f`);
    assert.equal(percent(x, 0), r.p0, `${x} .0%`);
    assert.equal(percent(x, 1), r.p1, `${x} .1%`);
    assert.equal(pyRound(x), r.r0, `${x} round`);
    assert.equal(pyRoundTo(x, 1), r.r1, `${x} round 1`);
    assert.equal(pyRoundTo(x, 2), r.r2, `${x} round 2`);
  }
});

test("non-finite numbers format like Python", () => {
  assert.equal(fixed(Number.NaN, 1), "nan");
  assert.equal(fixed(Number.POSITIVE_INFINITY, 1), "inf");
  assert.equal(fixed(Number.NEGATIVE_INFINITY, 1), "-inf");
});
