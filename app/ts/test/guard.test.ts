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

test("findings report the file, the line number and the trimmed text", () => {
  const found = scan("a.ts", ["ok();", j("  /", "/ note")].join("\n"));
  assert.deepEqual(found, [
    { file: "a.ts", line: 2, rule: "a comment line (the project keeps code free of comments)", text: j("/", "/ note") },
  ]);
});
