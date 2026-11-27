import assert from "node:assert/strict";
import test from "node:test";
import { modeName, parseCliArgs, parseDevice, UsageError } from "../src/host/args.ts";
import { bannerLines, emulatorLines } from "../src/host/banner.ts";
import { pickLanIp } from "../src/host/netinfo.ts";
import { fixture } from "./helpers.ts";

const caPath = "<app>/.certs/ca.pem";
const unix = (text: string): string => text.split("\r\n").join("\n").split("\\").join("/");

interface BannerFx {
  cases: { argv: string[]; scheme: string; ip: string | null; alts: string[]; text: string }[];
  emulator: { ip: string | null; trace: boolean; text: string }[];
}

const fx = fixture<BannerFx>("banner");

test("the startup banner matches the recorded text for every argument combination", () => {
  for (const c of fx.cases) {
    const args = parseCliArgs(c.argv);
    const url = `${c.scheme}://${c.ip}:${args.port}/`;
    const lines = bannerLines({ args, scheme: c.scheme, ip: c.ip, altIps: c.alts, caPath, qr: [`[QR ${url}]`] });
    assert.equal(lines.join("\n") + "\n", unix(c.text), `${c.argv.join(" ")} ${c.scheme} ${c.ip}`);
  }
});

test("the emulator hint matches the recorded text, and shows a usable address when none is known", () => {
  for (const c of fx.emulator) {
    const text = emulatorLines(c.ip, 10023, c.trace).join("\n") + "\n";
    assert.equal(text, c.text.replace(/\r\n/g, "\n"));
  }
});

test("defaults match the recorded parser", () => {
  const a = parseCliArgs([]);
  assert.deepEqual([a.host, a.port, a.inputGain, a.venue, a.pin, a.template, a.sessionDb], ["127.0.0.1", 8770, 0, "", null, null, null]);
  assert.ok(!a.lan && !a.https && !a.hardware && !a.emulate && !a.trust && !a.auto);
});

test("--lan binds every interface and --trust implies --https", () => {
  assert.equal(parseCliArgs(["--lan"]).host, "0.0.0.0");
  assert.equal(parseCliArgs(["--trust"]).https, true);
});

test("values are parsed and invalid ones are usage errors", () => {
  const a = parseCliArgs(["--port", "9001", "--input-gain", "12.5", "--ableset-port", "39051", "--audio-device", "3", "--venue", "Bar"]);
  assert.equal(a.port, 9001);
  assert.equal(a.inputGain, 12.5);
  assert.equal(a.ablesetPort, 39051);
  assert.equal(a.venue, "Bar");
  assert.equal(parseDevice(a.audioDevice), 3);
  assert.equal(parseDevice("Scarlett 2i2"), "Scarlett 2i2");
  assert.equal(parseDevice(null), null);
  assert.throws(() => parseCliArgs(["--port", "abc"]), UsageError);
  assert.throws(() => parseCliArgs(["--input-gain", "x"]), UsageError);
  assert.throws(() => parseCliArgs(["--nonsense"]), UsageError);
  assert.throws(() => parseCliArgs(["stray"]), UsageError);
});

test("mode names", () => {
  assert.equal(modeName({ emulate: true, hardware: true }), "emulated");
  assert.equal(modeName({ emulate: false, hardware: true }), "hardware");
  assert.equal(modeName({ emulate: false, hardware: false }), "simulation");
});

test("ports and gain are range-checked", () => {
  for (const bad of [
    ["--port", "0"],
    ["--port", "99999"],
    ["--ableset-port", "70000"],
    ["--input-gain", "Infinity"],
    ["--input-gain", "0x10"],
  ]) {
    assert.throws(() => parseCliArgs(bad), UsageError, bad.join(" "));
  }
  assert.equal(parseCliArgs(["--port", "1"]).port, 1);
});

test("an empty --pin means no PIN", () => {
  assert.equal(parseCliArgs(["--pin="]).pin, "");
});

test("the address shown for phones is never a wildcard, and falls back to a local address with no route out", () => {
  assert.equal(pickLanIp("192.168.1.23", ["10.0.0.7"]), "192.168.1.23");
  assert.equal(pickLanIp("0.0.0.0", ["127.0.0.1", "169.254.3.4", "192.168.1.50"]), "192.168.1.50");
  assert.equal(pickLanIp(null, ["10.0.0.7"]), "10.0.0.7");
  assert.equal(pickLanIp("0.0.0.0", []), null);
  assert.equal(pickLanIp(null, ["127.0.0.1"]), null);
});
