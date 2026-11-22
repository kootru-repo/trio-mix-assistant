import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { qrAscii, qrEncode } from "../src/core/qr.ts";

interface Case {
  text: string;
  version: number;
  modules: string[];
  ascii: string;
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/qr.json", import.meta.url), "utf8"),
) as { cases: Case[] };

const rows = (m: boolean[][]): string[] => m.map((r) => r.map((v) => (v ? "1" : "0")).join(""));

test("matrix matches the recorded reference for every input", () => {
  assert.ok(fixture.cases.length >= 30);
  for (const c of fixture.cases) {
    const qr = qrEncode(c.text);
    assert.equal(qr.version, c.version, c.text);
    assert.deepEqual(rows(qr.modules), c.modules, c.text);
  }
});

test("inverted ASCII rendering matches the recorded text exactly", () => {
  for (const c of fixture.cases) {
    const lines = qrAscii(qrEncode(c.text).modules, 2, true);
    assert.equal(lines.join("\n") + "\n", c.ascii, c.text);
  }
});

test("matrix is square with finder patterns and the fixed timing row", () => {
  for (const c of fixture.cases) {
    const { version, modules } = qrEncode(c.text);
    const n = 17 + 4 * version;
    assert.equal(modules.length, n);
    for (const r of modules) assert.equal(r.length, n);
    const finder = (r0: number, c0: number): void => {
      for (let r = 0; r < 7; r++) {
        for (let k = 0; k < 7; k++) {
          const edge = r === 0 || r === 6 || k === 0 || k === 6;
          const core = r >= 2 && r <= 4 && k >= 2 && k <= 4;
          assert.equal(modules[r0 + r]![c0 + k], edge || core);
        }
      }
    };
    finder(0, 0);
    finder(0, n - 7);
    finder(n - 7, 0);
    for (let i = 8; i < n - 8; i++) assert.equal(modules[6]![i], i % 2 === 0);
  }
});
