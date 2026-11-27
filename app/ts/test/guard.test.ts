import assert from "node:assert/strict";
import test from "node:test";
import { scan } from "../tools/guard.ts";

const j = (...parts: string[]): string => parts.join("");

test("each project rule is caught on its own line", () => {
  const bad = [
    j("  /", "/ a note"),
    j("/", "* a block */"),
    j("const x = y as ", "unknown as Z;"),
    j("// @", "ts-ignore").slice(3),
    j("@ts", "-expect-error"),
    j("@ts", "-nocheck"),
    j("biome", "-ignore lint/x: reason"),
    j("eslint", "-disable-next-line"),
    j("test", '.only("x", () => {});'),
    j("it", '.skip("x", () => {});'),
    j("describe", '.todo("x");'),
    j('test("x", { skip', ": true }, () => {});"),
  ];
  for (const line of bad) assert.equal(scan("f.ts", line).length, 1, line);
});

test("ordinary code passes, including words that only look like the banned ones", () => {
  const good = [
    'const TAG = { pass: "PASS", fail: "FAIL", skip: "SKIP" };',
    'const url = "https://example.com/a";',
    "const v = x as unknown;",
    'if (a) test("x", () => {});',
    "const re = /a\\/b/;",
  ];
  for (const line of good) assert.deepEqual(scan("f.ts", line), [], line);
});

test("an import of the shared config C or a read of C fails, on one line or wrapped over several", () => {
  const shared = j("C", ".");
  const bad = [
    j("import { ", "C } from ", '"../src/core/config.ts";'),
    j("import { ", "C, defaultConfig } from ", '"./config.ts";'),
    j("import { applyChannelMap, ", "C } from ", '"../core/config.ts";'),
    j("import {\n  applyChannelMap,\n  ", "C,\n  defaultConfig,\n} from ", '"../../core/config.ts";'),
    j("import type { ", "C } from ", '"./config";'),
    `const n = ${shared}CHANNELS.size;`,
    `foo(${shared}feedback.ringDb);`,
    `  return [...${shared}FX_BUSES.keys()];`,
  ];
  for (const text of bad) assert.equal(scan("f.ts", text).length, 1, text);
  const wrapped = scan("f.ts", ["ok();", j("import {\n  ", "C,\n} from ", '"./config.ts";')].join("\n"));
  assert.equal(wrapped[0]?.line, 2);
});

test("injected configs and look-alikes of C pass", () => {
  const good = [
    'import { defaultConfig, configWith } from "../src/core/config.ts";',
    'import type { Config, ChannelMapSpec } from "./config.ts";',
    'import { C } from "./other.ts";',
    "const n = cfg.CHANNELS.size;",
    "const v = this.cfg.feedback.ringDb;",
    "const x = ABC.d + obj.C.e + $C.f;",
    'const path = "C:/Users/x";',
    'lines.push("Press Ctrl+C to stop.");',
  ];
  for (const text of good) assert.deepEqual(scan("f.ts", text), [], text);
});

test("findings report the file, the line number and the trimmed text", () => {
  const found = scan("a.ts", ["ok();", j("  /", "/ note")].join("\n"));
  assert.deepEqual(found, [
    { file: "a.ts", line: 2, rule: "a comment line (the project keeps code free of comments)", text: j("/", "/ note") },
  ]);
});
