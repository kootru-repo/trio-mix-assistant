import assert from "node:assert/strict";
import dgram from "node:dgram";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ManualClock } from "../src/core/clock.ts";
import { C, channelMapState } from "../src/core/config.ts";
import { ConsoleBase } from "../src/core/console.ts";
import { EmulatedDesk } from "../src/core/emulator.ts";
import { MemNetwork } from "../src/core/memtransport.ts";
import { MeterReceiver } from "../src/core/metersrv.ts";
import { decodePacket } from "../src/core/oscwire.ts";
import { Desk, VetLog, measureSound, soundVerdict, summaryLines, tableLines, vetConsole, vetSequence } from "../src/core/vet.ts";
import type { VetRow } from "../src/core/vet.ts";
import { parseCliArgs } from "../src/host/args.ts";
import { NativeAudioInputFactory } from "../src/host/audiodevice.ts";
import { captureThread } from "../src/host/capturethread.ts";
import { SystemClock } from "../src/host/clock.ts";
import { entryFor } from "../src/host/exe.ts";
import { findLayout } from "../src/host/layout.ts";
import type { Io } from "../src/host/main.ts";
import { NodeUdpFactory } from "../src/host/udp.ts";
import { runVet } from "../src/host/vet.ts";
import { withEmulatorPorts } from "./emulatorports.ts";

interface Rig {
  desk: Desk;
  emu: EmulatedDesk;
  rx: MeterReceiver;
  log: VetLog;
  net: MemNetwork;
  close(): void;
}

async function rig(proof: "emulator" | "real console" = "emulator", answer = true): Promise<Rig> {
  const clock = new ManualClock(100, 1_700_000_000);
  const net = new MemNetwork();
  const log = new VetLog(clock);
  const rx = new MeterReceiver(net, { ip: "127.0.0.1", port: 0 });
  await rx.start();
  const emu = new EmulatedDesk(net, clock, { listenPort: 0, listenHost: "127.0.0.1", appPort: proof === "emulator" ? rx.port : 1 });
  await emu.start();
  const target = { host: "127.0.0.1", port: answer ? emu.listenPort : 1 };
  const desk = new Desk({ transmit: (data) => rx.send(data, target), clock, log, proof });
  rx.onMessage = (addr, args) => desk.receive(addr, args);
  return {
    desk,
    emu,
    rx,
    log,
    net,
    close: () => {
      rx.stop();
      emu.stop();
    },
  };
}

const failed = (rows: VetRow[]): string => rows.filter((r) => r.status === "fail").map((r) => `${r.id}: ${r.detail}`).join("\n");

const source = (name: string): string => readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");

test("the full sequence passes against the emulator and leaves the channel map as it found it", async () => {
  const r = await rig();
  const before = channelMapState();
  const rows: VetRow[] = [];
  try {
    await vetConsole(rows, r.desk, "Console", { channel: 2, main: true, gain: true });
    await vetSequence(rows, r.desk, { externalMove: (ch, db) => r.emu.moveFaderExternally(ch, db) });
  } finally {
    r.close();
  }
  assert.equal(failed(rows), "");
  assert.deepEqual(rows.filter((x) => x.status === "skip").map((x) => x.id), []);
  assert.ok(rows.every((x) => x.proof === "emulator"));
  assert.deepEqual(channelMapState(), before);
});

test("every console method, engine command and job has a row", async () => {
  const r = await rig();
  const rows: VetRow[] = [];
  try {
    await vetConsole(rows, r.desk, "Console", { channel: 2, main: true, gain: true });
    await vetSequence(rows, r.desk, { externalMove: (ch, db) => r.emu.moveFaderExternally(ch, db) });
  } finally {
    r.close();
  }
  const covered = new Set(rows.filter((x) => x.status === "pass").flatMap((x) => x.covers));
  const lifecycle = new Set(["constructor", "close", "cancelRamps", "flushRamps", "record", "send", "bumpRamp", "writeFader", "runRamp", "eqBand"]);
  const methods = Object.getOwnPropertyNames(ConsoleBase.prototype).filter((m) => !lifecycle.has(m));
  assert.ok(methods.length >= 15, methods.join(","));
  for (const m of methods) assert.ok(covered.has(`console:${m}`), `no passing row covers the console method ${m}`);
  const commands = [...source("core/engine/core.ts").matchAll(/if \(t === "([a-z_]+)"\)/g)].map((m) => m[1]!);
  assert.ok(commands.length >= 16, commands.join(","));
  for (const c of commands) assert.ok(covered.has(`command:${c}`), `no passing row covers the engine command ${c}`);
  for (const job of Object.keys(C.DEFAULT_ENABLED)) assert.ok(covered.has(`job:${job}`), `no passing row covers the job ${job}`);
});

test("a console that answers nothing is never written to", async () => {
  const r = await rig("real console", false);
  const rows: VetRow[] = [];
  try {
    await vetConsole(rows, r.desk, "Console", { channel: 2, main: true, gain: true });
  } finally {
    r.close();
  }
  assert.equal(rows[0]!.status, "fail");
  assert.ok(rows.slice(1).every((x) => x.status === "skip"), failed(rows));
  const sent = r.log.lines.filter((l) => l.includes("] send ")).map((l) => l.split("] send ")[1]!.trim());
  assert.deepEqual(sent, ["/xinfo"]);
});

test("on a real console nothing is written unless asked, a scene is never recalled, and every value is put back", async () => {
  const r = await rig("real console");
  const rows: VetRow[] = [];
  const before = new Map([...r.emu.params].map(([k, v]) => [k, JSON.stringify(v)]));
  try {
    await vetConsole(rows, r.desk, "Console", { channel: null, main: false, gain: false });
    const writes = r.log.lines.filter((l) => /\] send \/\S+ \S/.test(l) && !l.includes("/batchsubscribe"));
    assert.deepEqual(writes, []);
    assert.deepEqual(rows.filter((x) => x.status === "pass").map((x) => x.id), ["con_identity", "con_meters"]);
    rows.length = 0;
    const seeded = new Map([...r.emu.params].map(([k, v]) => [k, JSON.stringify(v)]));
    await vetConsole(rows, r.desk, "Console", { channel: 3, main: true, gain: true });
    assert.equal(failed(rows), "");
    assert.deepEqual(rows.filter((x) => x.status === "skip").map((x) => x.id), ["con_scene"]);
    assert.equal(r.emu.scene, null);
    for (const [k, v] of seeded) assert.equal(JSON.stringify(r.emu.params.get(k)), v, k);
    assert.ok(before.size > 0);
  } finally {
    r.close();
  }
});

test("a value the console does not hold after a write is reported, and the original is still put back", async () => {
  const r = await rig("real console");
  const rows: VetRow[] = [];
  const original = r.emu.handleAny.bind(r.emu);
  r.emu.handleAny = (client, addr, args) => {
    if (addr === "/ch/02/preamp/invert" && args.length > 0 && args[0]!.t === "i" && args[0]!.v === 1) return;
    original(client, addr, args);
  };
  try {
    await vetConsole(rows, r.desk, "Console", { channel: 2, main: false, gain: false });
  } finally {
    r.close();
  }
  const row = rows.find((x) => x.id === "con_polarity")!;
  assert.equal(row.status, "fail");
  assert.match(row.detail, /wrote 1\.000, read back 0\.000/);
  assert.doesNotMatch(row.detail, /NOT put back/);
});

test("a restore that is lost on the network is sent again until the console holds the old value", async () => {
  const r = await rig("real console");
  const rows: VetRow[] = [];
  const original = r.emu.handleAny.bind(r.emu);
  let dropped = 0;
  r.emu.handleAny = (client, addr, args) => {
    const restore = addr === "/ch/02/mix/on" && args.length > 0 && args[0]!.t === "i" && args[0]!.v === 1;
    if (restore && dropped < 2) {
      dropped += 1;
      return;
    }
    original(client, addr, args);
  };
  try {
    await vetConsole(rows, r.desk, "Console", { channel: 2, main: false, gain: false });
  } finally {
    r.close();
  }
  const row = rows.find((x) => x.id === "con_ch_mute")!;
  assert.equal(row.status, "pass", row.detail);
  assert.equal(dropped, 2);
  assert.equal(r.emu.mute.get(2), false);
  assert.ok(r.log.lines.some((l) => l.includes("restore of /ch/02/mix/on not confirmed (attempt 2 of 4)")));
});

test("the report separates what a real console proved from what only the emulator proved", () => {
  const rows: VetRow[] = [
    { id: "a", area: "Console", title: "Fader", status: "pass", proof: "real console", detail: "ok", covers: [] },
    { id: "b", area: "Console", title: "Mute", status: "pass", proof: "emulator", detail: "ok", covers: [] },
    { id: "c", area: "Sound", title: "Noise", status: "skip", proof: "nothing", detail: "not asked for", covers: [] },
  ];
  const text = [...tableLines(rows), ...summaryLines(rows)].join("\n");
  assert.ok(text.includes("[PASS] Fader  (proved on: real console)"), text);
  assert.ok(text.includes("[SKIP] Noise\n"), text);
  assert.ok(text.includes("Result: 2 passed, 0 failed, 1 skipped."), text);
  assert.ok(text.includes("Passed on a real console: 1. Passed on the built-in emulator only: 1."), text);
});

test("the sound check needs the noise to be heard above the room", async () => {
  const tone = (amp: number): Float32Array => Float32Array.from({ length: 4800 }, (_v, i) => amp * Math.sin(i / 5));
  const src = (ambient: number, during: number, played = true) => {
    let n = 0;
    return {
      captureMeas: () => Promise.resolve(tone(n++ === 0 ? ambient : during)),
      emitPinkNoise: () => Promise.resolve(played),
    };
  };
  assert.match(soundVerdict(await measureSound(src(0.0005, 0.1), new Float32Array(8), 1)), /heard -23 dBFS during the noise, 46 dB above/);
  await assert.rejects(async () => soundVerdict(await measureSound(src(0.0005, 0.1, false), new Float32Array(8), 1)), /could not be played/);
  await assert.rejects(async () => soundVerdict(await measureSound(src(0.0005, 0.001), new Float32Array(8), 1)), /heard only/);
  await assert.rejects(async () => soundVerdict(await measureSound(src(0.09, 0.1), new Float32Array(8), 1)), /rose only/);
});

function vetIo(lines: string[], appDir: string): Io {
  return {
    out: (l) => lines.push(l),
    clock: new SystemClock(),
    audio: () => NativeAudioInputFactory.create(),
    factory: null,
    connect: captureThread,
    udp: new NodeUdpFactory(),
    waitForStop: () => new Promise(() => undefined),
    layout: { ...findLayout(), appDir },
  };
}

test("--vet passes on this computer, covers every dashboard address and writes a log with no PIN in it", async () => {
  const home = mkdtempSync(join(tmpdir(), "vet-home-"));
  const lines: string[] = [];
  try {
    writeFileSync(join(home, "show.conf"), "MODE=sim\nLAN=no\nPIN=secret-show-pin\n");
    const io = vetIo(lines, home);
    io.factory = await io.audio();
    const out = await runVet(parseCliArgs(["--vet"]), io, { openSource: null, lanIp: () => Promise.resolve(null) });
    const text = lines.join("\n");
    const hasModule = out.rows.find((x) => x.id === "sys_audio_module")!.status === "pass";
    assert.equal(failed(out.rows.filter((x) => hasModule || x.id !== "sys_audio_module")), "", text);
    assert.equal(out.code, hasModule ? 0 : 1);
    const covered = new Set(out.rows.filter((x) => x.status === "pass").flatMap((x) => x.covers));
    const routes = new Set([...source("host/server.ts").matchAll(/"(\/[a-z_./]*[a-z])"/g)].map((m) => m[1]!));
    assert.ok(routes.size >= 18, [...routes].join(","));
    for (const r of routes) assert.ok(covered.has(`route:${r}`), `no passing row covers the dashboard address ${r}`);
    assert.ok(text.includes("A real console was not tested"), text);
    assert.ok(text.includes("Check these by hand"), text);
    assert.ok(out.logPath !== null && out.logPath.startsWith(home));
    const log = readFileSync(out.logPath!, "utf8");
    assert.ok(log.includes("send /ch/02/mix/fader"), "the log has no sent values");
    assert.ok(log.includes("recv /ch/02/mix/fader"), "the log has no received values");
    assert.ok(!log.includes("secret-show-pin"));
    assert.ok(!/"pin"/.test(log));
    assert.deepEqual(readdirSync(home).filter((n) => !n.startsWith("vet-")).sort(), ["show.conf"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--vet reports a broken show.conf instead of stopping", async () => {
  const home = mkdtempSync(join(tmpdir(), "vet-home-"));
  const lines: string[] = [];
  try {
    writeFileSync(join(home, "show.conf"), "MODE=hardwre\n");
    const io = vetIo(lines, home);
    const out = await runVet(parseCliArgs(["--vet"]), io, { openSource: null, lanIp: () => Promise.resolve(null) });
    const row = out.rows.find((x) => x.id === "conf_show")!;
    assert.equal(row.status, "fail");
    assert.match(row.detail, /MODE in show\.conf must be/);
    assert.equal(out.code, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the options that change a real console cannot be given by accident", () => {
  assert.throws(() => parseCliArgs(["--vet-channel", "3"]), /need --vet/);
  assert.throws(() => parseCliArgs(["--vet", "--vet-channel", "3"]), /need --hardware/);
  assert.throws(() => parseCliArgs(["--vet", "--vet-main"]), /need --hardware/);
  assert.throws(() => parseCliArgs(["--vet", "--hardware", "--vet-gain"]), /needs --vet-channel/);
  assert.throws(() => parseCliArgs(["--vet", "--hardware", "--vet-channel", "0"]), /outside 1\.\.32/);
  assert.throws(() => parseCliArgs(["--vet", "--emulate"]), /leave out --emulate/);
  assert.throws(() => parseCliArgs(["--vet", "--diagnose"]), /cannot be combined/);
  const a = parseCliArgs(["--vet", "--hardware", "--console-ip", "10.0.0.9", "--vet-channel", "3", "--vet-gain"]);
  assert.equal(a.vetChannel, 3);
  assert.ok(a.vetGain && !a.vetMain);
  assert.equal(entryFor(["--vet"]), "run");
});

test("the sound and phone layers run only when asked, and say what they need", async () => {
  const home = mkdtempSync(join(tmpdir(), "vet-home-"));
  const lines: string[] = [];
  try {
    const io = vetIo(lines, home);
    let calls = 0;
    let stopped = false;
    const audio = {
      start: () => undefined,
      ready: () => Promise.resolve(),
      stop: () => {
        stopped = true;
      },
      settled: () => Promise.resolve(),
      captureMeas: () => {
        const amp = calls++ === 0 ? 0.0005 : 0.1;
        return Promise.resolve(Float32Array.from({ length: 48000 }, (_v, i) => amp * Math.sin(i / 5)));
      },
      emitPinkNoise: () => Promise.resolve(true),
    };
    const args = parseCliArgs(["--vet", "--vet-sound", "--vet-phone", "--audio-device", "0"]);
    const out = await runVet(args, io, { openSource: () => audio, lanIp: () => Promise.resolve(null) });
    const snd = out.rows.find((x) => x.id === "sound_noise")!;
    assert.equal(snd.status, "pass", snd.detail);
    assert.match(snd.detail, /nothing was applied/);
    assert.ok(stopped);
    assert.ok(lines.some((l) => l.includes("SOUND: pink noise plays")), lines.join("\n"));
    const ph = out.rows.find((x) => x.id === "phone_login")!;
    assert.equal(ph.status, "skip");
    assert.match(ph.detail, /--lan --pin/);
    const none = await runVet(parseCliArgs(["--vet", "--vet-sound"]), vetIo([], home), { openSource: null, lanIp: () => Promise.resolve(null) });
    assert.equal(none.rows.find((x) => x.id === "sound_noise")!.status, "skip");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the phone layer fails plainly when no phone signs in", async () => {
  const home = mkdtempSync(join(tmpdir(), "vet-home-"));
  try {
    const args = parseCliArgs(["--vet", "--vet-phone", "--lan", "--pin", "123456", "--port", "48771"]);
    const out = await runVet(args, vetIo([], home), { openSource: null, lanIp: () => Promise.resolve("192.0.2.10"), phoneSeconds: 0.3 });
    const ph = out.rows.find((x) => x.id === "phone_login")!;
    assert.equal(ph.status, "fail");
    assert.match(ph.detail, /no phone signed in within 0\.3 seconds/);
    assert.ok(!readFileSync(out.logPath!, "utf8").includes("123456"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--vet sends nothing to the port a running app listens on", () =>
  withEmulatorPorts(async () => {
    const home = mkdtempSync(join(tmpdir(), "vet-home-"));
    const strays: string[] = [];
    const app = dgram.createSocket("udp4");
    app.on("message", (data) => {
      for (const m of decodePacket(new Uint8Array(data))) strays.push(m.address);
    });
    await new Promise<void>((resolve, reject) => {
      app.once("error", reject);
      app.bind(C.LOCAL_PORT, "127.0.0.1", () => resolve());
    });
    try {
      const out = await runVet(parseCliArgs(["--vet"]), vetIo([], home), { openSource: null, lanIp: () => Promise.resolve(null) });
      assert.ok(out.rows.some((x) => x.id === "show_console_move" && x.status === "pass"));
      assert.deepEqual(strays, []);
    } finally {
      await new Promise<void>((resolve) => app.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  }));
