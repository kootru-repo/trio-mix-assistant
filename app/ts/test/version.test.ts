import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseCliArgs } from "../src/host/args.ts";
import { bannerLines } from "../src/host/banner.ts";
import { appVersion, versionFrom } from "../src/host/version.ts";

const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

test("package.json holds a semantic version", () => {
  assert.match(own.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});

test("running from source reports the package version with no commit", () => {
  assert.deepEqual(appVersion(), { version: own.version, commit: null, label: own.version });
});

test("a built package's version and commit make the label", () => {
  assert.deepEqual(versionFrom('{"version":"1.2.3","commit":"abcdef012345"}'), {
    version: "1.2.3",
    commit: "abcdef012345",
    label: "1.2.3 (abcdef012345)",
  });
  assert.deepEqual(versionFrom('{"version":"1.2.3","commit":null}'), { version: "1.2.3", commit: null, label: "1.2.3" });
});

test("a missing or broken package file reads as unknown rather than failing", () => {
  assert.deepEqual(versionFrom(""), { version: "unknown", commit: null, label: "unknown" });
  assert.deepEqual(versionFrom("{"), { version: "unknown", commit: null, label: "unknown" });
  assert.deepEqual(versionFrom('{"version":7,"commit":3}'), { version: "unknown", commit: null, label: "unknown" });
  assert.deepEqual(versionFrom("[]"), { version: "unknown", commit: null, label: "unknown" });
});

test("--version is accepted on its own", () => {
  assert.equal(parseCliArgs(["--version"]).version, true);
  assert.equal(parseCliArgs([]).version, false);
});

test("the banner shows the version when it is given and keeps the old line without it", () => {
  const args = parseCliArgs([]);
  const base = { args, scheme: "http", ip: null, altIps: [], caPath: "ca.pem", qr: null };
  assert.equal(bannerLines(base)[0], "Trio Mix-Assistant [SIMULATION] -> http://127.0.0.1:8770/");
  assert.equal(
    bannerLines({ ...base, version: "0.2.9 (abcdef012345)" })[0],
    "Trio Mix-Assistant 0.2.9 (abcdef012345) [SIMULATION] -> http://127.0.0.1:8770/",
  );
});
