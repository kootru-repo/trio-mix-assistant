import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildArgv, readConf } from "../src/host/launcher.ts";
import type { Conf } from "../src/host/launcher.ts";

const base = fileURLToPath(new URL("../../", import.meta.url));

function plan(cfg: Conf, rehearse = false) {
  const lines: string[] = [];
  const p = buildArgv(cfg, base, rehearse, (l) => lines.push(l));
  return { ...p, out: lines.join("\n") };
}

const after = (argv: string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1];

test("the PIN is passed through verbatim", () => {
  assert.equal(after(plan({ MODE: "sim", PIN: "0420" }).argv, "--pin"), "0420");
});

test("a blank PIN passes no PIN flag", () => {
  const { argv } = plan({ MODE: "sim", PIN: "" });
  assert.ok(!argv.includes("--pin"));
  assert.ok(argv.includes("--lan"));
});

test("a PIN without HTTPS warns", () => {
  assert.match(plan({ MODE: "sim", PIN: "1234", HTTPS: "no" }).out, /unencrypted/);
});

test("the defaults serve the LAN over HTTPS", () => {
  const p = plan({});
  assert.equal(p.mode, "sim");
  assert.equal(p.port, "8770");
  assert.ok(p.argv.includes("--lan"));
  assert.ok(p.argv.includes("--https"));
});

test("hardware settings map to flags", () => {
  const p = plan({ MODE: "hardware", CONSOLE_IP: "10.0.0.9", AUDIO_DEVICE: "3", AUTO: "yes" });
  assert.equal(p.mode, "hardware");
  assert.ok(p.argv.includes("--hardware"));
  assert.equal(after(p.argv, "--console-ip"), "10.0.0.9");
  assert.equal(after(p.argv, "--audio-device"), "3");
  assert.ok(p.argv.includes("--auto"));
});

test("hardware mode with blank fields tells the operator what is missing", () => {
  const out = plan({ MODE: "hardware" }).out;
  assert.match(out, /CONSOLE_IP is blank/);
  assert.match(out, /AUDIO_DEVICE blank/);
});

test("rehearse forces the emulator", () => {
  const p = plan({ MODE: "hardware", CONSOLE_IP: "10.0.0.9" }, true);
  assert.equal(p.mode, "emulate");
  assert.ok(p.argv.includes("--emulate"));
  assert.ok(!p.argv.includes("--hardware"));
});

test("optional settings are mapped and a relative template resolves against the app folder", () => {
  const p = plan({ MODE: "hardware", CONSOLE_IP: "1.2.3.4", TEMPLATE: "set.json", VENUE: "Bar", INPUT_GAIN: "20", OUTPUT_DEVICE: "PA", ABLESET_PORT: "39051", ADVISOR: "yes", PORT: "9000" });
  assert.equal(after(p.argv, "--template"), join(base, "set.json"));
  assert.equal(after(p.argv, "--venue"), "Bar");
  assert.equal(after(p.argv, "--input-gain"), "20");
  assert.equal(after(p.argv, "--output-device"), "PA");
  assert.equal(after(p.argv, "--ableset-port"), "39051");
  assert.ok(p.argv.includes("--advisor"));
  assert.equal(p.port, "9000");
});

test("readConf ignores comments and blank lines and upper-cases keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "conf-"));
  try {
    const path = join(dir, "show.conf");
    writeFileSync(path, "# note\n\nmode = emulate\nPIN=0420\nnonsense\n");
    assert.deepEqual(readConf(path), { MODE: "emulate", PIN: "0420" });
    assert.deepEqual(readConf(join(dir, "missing.conf")), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the shipped show.conf has a blank PIN key", () => {
  assert.equal(readConf(join(base, "show.conf"))["PIN"], "");
});
