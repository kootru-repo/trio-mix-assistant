import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function fixture<T = any>(name: string): T {
  const path = fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export const recording = process.env["RECORD_FIXTURES"] === "1";

export function saveFixture(name: string, data: unknown): void {
  writeFileSync(fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url)), JSON.stringify(data));
}

export function f32(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4).slice();
}

export function f64(b64: string): Float64Array {
  const buf = Buffer.from(b64, "base64");
  return new Float64Array(buf.buffer, buf.byteOffset, buf.length / 8).slice();
}

export function close(actual: number | null, expected: number | null, rel = 1e-4, abs = 1e-6, label = ""): void {
  if (expected === null || actual === null) {
    assert.equal(actual, expected, label);
    return;
  }
  const tol = Math.max(abs, Math.abs(expected) * rel);
  assert.ok(Math.abs(actual - expected) <= tol, `${label} expected ${expected}, got ${actual} (tol ${tol})`);
}

export function closeArray(actual: ArrayLike<number>, expected: ArrayLike<number>, rel = 1e-4, abs = 1e-6, label = ""): void {
  assert.equal(actual.length, expected.length, `${label} length`);
  let worst = 0;
  let at = -1;
  for (let i = 0; i < expected.length; i++) {
    const tol = Math.max(abs, Math.abs(expected[i]!) * rel);
    const d = Math.abs(actual[i]! - expected[i]!) / tol;
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  assert.ok(worst <= 1, `${label} index ${at}: expected ${expected[at]}, got ${actual[at]}`);
}
