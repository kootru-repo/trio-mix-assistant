import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildArgv, ConfError, parseConf, readConf } from "../src/host/launcher.ts";
import type { Conf } from "../src/host/launcher.ts";

const base = fileURLToPath(new URL("../../", import.meta.url));

function plan(cfg: Conf, rehearse = false) {
  const lines: string[] = [];
  const p = buildArgv(cfg, base, rehearse, (l) => lines.push(l));
  return { ...p, out: lines.join("\n") };
}

const after = (argv: string[], flag: string): string | undefined => {
  const joined = argv.find((a) => a.startsWith(flag + "="));
  return joined !== undefined ? joined.slice(flag.length + 1) : argv[argv.indexOf(flag) + 1];
};

test("the PIN is passed through verbatim", () => {
  assert.equal(after(plan({ MODE: "sim", PIN: "042042" }).argv, "--pin"), "042042");
});

test("a blank PIN passes no PIN flag", () => {
  const { argv } = plan({ MODE: "sim", PIN: "", LAN: "no" });
  assert.ok(!argv.some((a) => a.startsWith("--pin")));
  assert.ok(!argv.includes("--lan"));
});

test("a PIN without HTTPS warns", () => {
  assert.match(plan({ MODE: "sim", PIN: "123456", HTTPS: "no" }).out, /unencrypted/);
});

test("the defaults serve the LAN over HTTPS", () => {
  const p = plan({ PIN: "123456" });
  assert.equal(p.mode, "sim");
  assert.equal(p.port, "8770");
  assert.ok(p.argv.includes("--lan"));
  assert.ok(p.argv.includes("--https"));
});

test("a dashboard kept on this computer is served over plain http, with no certificate", () => {
  const local = plan({ MODE: "sim", LAN: "no", HTTPS: "yes" });
  assert.ok(!local.argv.includes("--https"));
  assert.ok(!local.argv.includes("--lan"));
  assert.ok(plan({ MODE: "sim", LAN: "no", TRUST: "yes" }).argv.includes("--trust"));
  assert.ok(plan({ MODE: "sim", LAN: "yes", PIN: "123456", HTTPS: "yes" }).argv.includes("--https"));
});

test("hardware settings map to flags", () => {
  const p = plan({ MODE: "hardware", CONSOLE_IP: "10.0.0.9", AUDIO_DEVICE: "3", AUTO: "yes", PIN: "123456" });
  assert.equal(p.mode, "hardware");
  assert.ok(p.argv.includes("--hardware"));
  assert.equal(after(p.argv, "--console-ip"), "10.0.0.9");
  assert.equal(after(p.argv, "--audio-device"), "3");
  assert.ok(p.argv.includes("--auto"));
});

test("hardware mode with blank fields tells the operator what is missing", () => {
  const out = plan({ MODE: "hardware", PIN: "123456" }).out;
  assert.match(out, /CONSOLE_IP is blank/);
  assert.match(out, /AUDIO_DEVICE blank/);
});

test("rehearse forces the emulator", () => {
  const p = plan({ MODE: "hardware", CONSOLE_IP: "10.0.0.9", PIN: "123456" }, true);
  assert.equal(p.mode, "emulate");
  assert.ok(p.argv.includes("--emulate"));
  assert.ok(!p.argv.includes("--hardware"));
});

test("optional settings are mapped and a relative template resolves against the app folder", () => {
  const p = plan({
    MODE: "hardware",
    CONSOLE_IP: "1.2.3.4",
    TEMPLATE: "set.json",
    VENUE: "Bar",
    INPUT_GAIN: "20",
    OUTPUT_DEVICE: "PA",
    ABLESET_PORT: "39051",
    ADVISOR: "yes",
    PORT: "9000",
    PIN: "123456",
  });
  assert.equal(after(p.argv, "--template"), join(base, "set.json"));
  assert.equal(after(p.argv, "--venue"), "Bar");
  assert.equal(after(p.argv, "--input-gain"), "20");
  assert.equal(after(p.argv, "--output-device"), "PA");
  assert.equal(after(p.argv, "--ableset-port"), "39051");
  assert.ok(!p.argv.some((a) => a.startsWith("--advisor")));
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

test("a mistyped mode or yes/no value is an error, not a silent default", () => {
  assert.throws(() => plan({ MODE: "hardwre" }), ConfError);
  assert.throws(() => plan({ MODE: "sim", HTTPS: "ture" }), ConfError);
  assert.throws(() => plan({ MODE: "sim", LAN: "maybe" }), ConfError);
  assert.doesNotThrow(() => plan({ MODE: "SIM", HTTPS: "No", LAN: "OFF", ADVISOR: "" }));
});

test("quotes around a value are removed", () => {
  const cfg = parseConf(['PIN="1234"', "VENUE='The Bar'", "PORT = 9000", ""].join("\n"));
  assert.deepEqual(cfg, { PIN: "1234", VENUE: "The Bar", PORT: "9000" });
});

test("values that begin with a dash survive the hand-off to the command line", async () => {
  const { parseCliArgs } = await import("../src/host/args.ts");
  const p = plan({ MODE: "sim", PIN: "-123456", VENUE: "-x" });
  const a = parseCliArgs(p.argv);
  assert.equal(a.pin, "-123456");
  assert.equal(a.venue, "-x");
});

test("LAN with no PIN is refused unless the open dashboard is explicitly allowed", () => {
  assert.throws(() => plan({ MODE: "sim", PIN: "" }), ConfError);
  const open = plan({ MODE: "sim", PIN: "", ALLOW_OPEN: "yes" });
  assert.ok(open.argv.includes("--insecure-open"));
  assert.match(open.out, /anyone on this network/);
  assert.doesNotThrow(() => plan({ MODE: "sim", PIN: "", LAN: "no" }));
});

test("valued settings use the joined form so a leading dash cannot be mistaken for a flag", () => {
  const p = plan({ MODE: "hardware", CONSOLE_IP: "10.0.0.9", AUDIO_DEVICE: "-1", INPUT_GAIN: "-5", PIN: "123456" });
  assert.ok(p.argv.includes("--input-gain=-5"));
  assert.ok(p.argv.includes("--audio-device=-1"));
});

test("an unquoted value ends at a space followed by a hash", () => {
  assert.deepEqual(parseConf("PIN=abc123  # my pin\nPORT=9000"), { PIN: "abc123", PORT: "9000" });
  assert.deepEqual(parseConf('PIN="a #b"'), { PIN: "a #b" });
});

test("TRUST=yes turns on the trusted certificate mode", () => {
  const p = plan({ MODE: "sim", PIN: "123456", TRUST: "yes" });
  assert.ok(p.argv.includes("--trust"));
  assert.ok(!p.argv.includes("--https"));
});

test("a bare --vet takes the console and the test options from show.conf", async () => {
  const { vetArgv } = await import("../src/host/launcher.ts");
  const { parseCliArgs } = await import("../src/host/args.ts");
  const cfg: Conf = {
    MODE: "hardware",
    CONSOLE_IP: "10.0.0.9",
    AUDIO_DEVICE: "3",
    LAN: "no",
    VET_CHANNEL: "12",
    VET_GAIN: "yes",
    VET_MAIN: "yes",
    VET_SOUND: "yes",
  };
  const argv = vetArgv(cfg, plan(cfg), () => undefined);
  const a = parseCliArgs(argv);
  assert.ok(a.vet && a.hardware);
  assert.equal(a.consoleIp, "10.0.0.9");
  assert.equal(a.vetChannel, 12);
  assert.ok(a.vetGain && a.vetMain && a.vetSound && !a.vetPhone);
  assert.equal(a.audioDevice, "3");
  const notes: string[] = [];
  const sim: Conf = { MODE: "emulate", LAN: "no", VET_CHANNEL: "5" };
  const simArgs = parseCliArgs(vetArgv(sim, plan(sim), (l) => notes.push(l)));
  assert.ok(simArgs.vet && !simArgs.emulate && !simArgs.hardware && simArgs.vetChannel === null);
  assert.match(notes.join(" "), /only with MODE=hardware/);
  const bad: Conf = { MODE: "hardware", LAN: "no", VET_CHANNEL: "99" };
  assert.throws(() => vetArgv(bad, plan(bad), () => undefined), ConfError);
  const shipped = readConf(join(base, "show.conf"));
  const none = parseCliArgs(vetArgv(shipped, plan(shipped), () => undefined));
  assert.ok(none.vet && !none.vetSound && !none.vetPhone && none.vetChannel === null);
});

test("SESSION_DB reaches the command line and the old advisor keys are ignored", async () => {
  const { parseCliArgs } = await import("../src/host/args.ts");
  const off = parseCliArgs(plan({ MODE: "sim", LAN: "no", SESSION_DB: "OFF", ADVISOR_INTERVAL: "45" }).argv);
  assert.equal(off.sessionDb, "off");
  assert.ok(!plan({ MODE: "sim", LAN: "no", ADVISOR_INTERVAL: "45" }).argv.some((a) => a.startsWith("--advisor")));
  const rel = parseCliArgs(plan({ MODE: "sim", LAN: "no", SESSION_DB: "logs/show.db" }).argv);
  assert.equal(rel.sessionDb, join(base, "logs/show.db"));
  const none = parseCliArgs(plan({ MODE: "sim", LAN: "no" }).argv);
  assert.equal(none.sessionDb, null);
});
