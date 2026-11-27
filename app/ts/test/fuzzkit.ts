import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { SeededRng } from "../src/core/rng.ts";

export const CASES = Math.max(1, Number(process.env["FUZZ_CASES"] ?? 2000) || 2000);
const SEED = Number(process.env["FUZZ_SEED"] ?? 20261127) || 20261127;
const CORPUS = join(import.meta.dirname, "corpus");

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export class Gen {
  private readonly r: SeededRng;

  constructor(seed: number) {
    this.r = new SeededRng(seed);
  }

  int(n: number): number {
    return Math.floor(this.r.next() * n);
  }

  chance(p: number): boolean {
    return this.r.next() < p;
  }

  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }

  float(): number {
    if (this.chance(0.3)) return this.pick([Number.NaN, Infinity, -Infinity, -0, 0, 1, -1, 1e308, -1e308, 5e-324, 0.5, 2, 4000, -4000]);
    return (this.r.next() - 0.5) * 10 ** this.int(8);
  }

  bytes(max: number): number[] {
    return Array.from({ length: this.int(max + 1) }, () => this.int(256));
  }

  text(max: number): string {
    const pool = [
      "a",
      "Z",
      "0",
      "9",
      " ",
      "=",
      "#",
      "/",
      ":",
      ".",
      "-",
      "_",
      "\n",
      "\r",
      "\t",
      '"',
      "'",
      "{",
      "}",
      "[",
      "]",
      "\\",
      "é",
      "\u{1F3B5}",
      "\u0000",
    ];
    return Array.from({ length: this.int(max + 1) }, () => this.pick(pool)).join("");
  }

  json(depth: number): Json {
    const k = this.int(depth > 0 ? 7 : 4);
    if (k === 0) return null;
    if (k === 1) return this.chance(0.5);
    if (k === 2) return this.chance(0.5) ? this.int(70) - 5 : this.float();
    if (k === 3) return this.text(12);
    if (k === 4 || k === 5) return Array.from({ length: this.int(4) }, () => this.json(depth - 1));
    const o: { [k: string]: Json } = {};
    for (let i = this.int(5); i > 0; i--) o[this.chance(0.5) ? this.text(6) : String(this.int(40) - 4)] = this.json(depth - 1);
    return o;
  }
}

const enc = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === "number" && !Number.isFinite(x) ? { $num: String(x) } : x));

const dec = (text: string): unknown =>
  JSON.parse(text, (_k, x: unknown) => {
    if (typeof x === "object" && x !== null && !Array.isArray(x) && Object.keys(x).length === 1 && "$num" in x)
      return Number((x as { $num: string }).$num);
    return x;
  });

function shrinks(v: unknown): unknown[] {
  if (typeof v === "string") return v.length ? [v.slice(0, Math.floor(v.length / 2)), v.slice(1), v.slice(0, -1)] : [];
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    if (v.length) out.push(v.slice(0, Math.floor(v.length / 2)), v.slice(1), v.slice(0, -1));
    v.forEach((x, i) => {
      for (const s of shrinks(x).slice(0, 2)) out.push([...v.slice(0, i), s, ...v.slice(i + 1)]);
    });
    return out;
  }
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return Object.keys(o).map((k) => Object.fromEntries(Object.entries(o).filter(([key]) => key !== k)));
  }
  if (typeof v === "number" && v !== 0 && Number.isFinite(v)) return [0, Math.trunc(v / 2)];
  return [];
}

function fails(check: (v: unknown) => void, v: unknown): string | null {
  try {
    check(v);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function property(name: string, gen: (g: Gen) => unknown, check: (v: unknown) => void): void {
  const dir = join(CORPUS, name);
  let stored: string[] = [];
  try {
    stored = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    stored = [];
  }
  for (const f of stored) {
    const why = fails(check, dec(readFileSync(join(dir, f), "utf8")));
    if (why !== null) throw new Error(`${name}: corpus case ${f} fails again: ${why}`);
  }
  for (let i = 0; i < CASES; i++) {
    const v = gen(new Gen(SEED + i));
    let why = fails(check, v);
    if (why === null) continue;
    let small = v;
    for (let round = 0; round < 200; round++) {
      const next = shrinks(small).find((s) => fails(check, s) !== null);
      if (next === undefined) break;
      small = next;
      why = fails(check, small);
    }
    const text = enc(small);
    mkdirSync(dir, { recursive: true });
    const file = `${createHash("sha256").update(text).digest("hex").slice(0, 12)}.json`;
    writeFileSync(join(dir, file), text + "\n");
    throw new Error(`${name}: case ${i} (seed ${SEED + i}) fails: ${why}\n  smallest input, saved as corpus/${name}/${file}: ${text}`);
  }
}
