import assert from "node:assert/strict";
import dgram from "node:dgram";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AnalysedBlock } from "../src/core/blockanalysis.ts";
import { CaptureSourceBase } from "../src/core/capture.ts";
import type { CaptureStatus, Frame } from "../src/core/capture.ts";
import { loopbackPort } from "../src/core/capturelink.ts";
import { ManualClock } from "../src/core/clock.ts";
import { C, channelMapState, restoreChannelMapState } from "../src/core/config.ts";
import { OscConsole } from "../src/core/console.ts";
import type { DatagramSink } from "../src/core/console.ts";
import type {
  AudioDeviceInfo,
  AudioInputCallback,
  AudioInputFactory,
  AudioInputOptions,
  AudioInputStream,
} from "../src/core/devicecapture.ts";
import { LevelWindow, buildReport, evaluate, redact } from "../src/core/diagnostics.ts";
import type { AudioFacts, Check, DiagFacts, DiagHost, DiagReport } from "../src/core/diagnostics.ts";
import { emptyFeatures } from "../src/core/dsp.ts";
import { Engine } from "../src/core/engine/index.ts";
import { MemNetwork } from "../src/core/memtransport.ts";
import { MeterReceiver, SharedPortSink } from "../src/core/metersrv.ts";
import { decodePacket, encodeMessage, encodeMeterBlob, oscBlob } from "../src/core/oscwire.ts";
import { parseCliArgs } from "../src/host/args.ts";
import { NativeAudioInputFactory } from "../src/host/audiodevice.ts";
import { captureThread } from "../src/host/capturethread.ts";
import { SystemClock, threadStamp } from "../src/host/clock.ts";
import { ConsoleProbe, moduleFacts, networkFacts } from "../src/host/diagnose.ts";
import { launch } from "../src/host/launch.ts";
import { findLayout } from "../src/host/layout.ts";
import { run } from "../src/host/main.ts";
import type { Io } from "../src/host/main.ts";
import { NodeUdpFactory } from "../src/host/udp.ts";
import { withEmulatorPorts } from "./emulatorports.ts";

const RATE = C.SAMPLE_RATE / C.BLOCK;

const goodAudio = (over: Partial<AudioFacts> = {}): AudioFacts => ({
  name: "Console USB",
  deviceChannels: 32,
  link: "open",
  dead: false,
  lastError: null,
  windowS: 8,
  blocks: Math.round(RATE * 8),
  expectedPerS: RATE,
  stale: 0,
  overruns: 0,
  channels: [
    { ch: 1, label: "Lead vocal", mapped: true, rmsDb: -30, peakDb: -18 },
    { ch: 8, label: "FOH meas mic", mapped: true, rmsDb: -42, peakDb: -25 },
  ],
  ...over,
});

const facts = (over: Partial<DiagFacts> = {}): DiagFacts => ({
  app: "test build",
  system: "Windows 11 x64",
  platform: "win32",
  home: null,
  mode: "hardware, console at 192.168.1.50",
  audioModule: { ok: true, inputs: 4, error: null },
  audio: goodAudio(),
  audioSkipped: "",
  console: { emulated: false, address: "192.168.1.50", listening: true, listenError: null, windowS: 8, packets: 70, meters: 16 },
  network: { lan: true, url: "https://192.168.1.20:8770/", pin: true, https: true },
  ...over,
});

const byId = (checks: readonly Check[], id: string): Check => {
  const c = checks.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no check ${id}`);
  return c;
};

const statuses = (f: DiagFacts): Record<string, string> => Object.fromEntries(evaluate(f).map((c) => [c.id, c.status]));

test("a working rig passes every check and the report says so", () => {
  const report = buildReport(facts());
  assert.deepEqual(
    report.checks.map((c) => [c.id, c.status]),
    [
      ["module", "pass"],
      ["input", "pass"],
      ["flow", "pass"],
      ["signal", "pass"],
      ["channels", "pass"],
      ["console", "pass"],
      ["network", "pass"],
    ],
  );
  assert.equal(report.result, "pass");
  assert.equal(report.summary, "0 failed, 0 warnings, 7 passed, 0 skipped");
  assert.ok(report.text.startsWith("===== Trio Mix-Assistant checks ====="));
  assert.ok(report.text.includes("Mode: hardware, console at 192.168.1.50"));
  assert.ok(report.text.includes("[PASS] Chosen input opens: 'Console USB', 32 channels, 48000 Hz"));
  assert.ok(report.checks.every((c) => c.fix === null));
});

test("a missing audio module fails and names the downloaded app as the fix", () => {
  const c = byId(evaluate(facts({ audioModule: { ok: false, inputs: 0, error: "module not installed" } })), "module");
  assert.equal(c.status, "fail");
  assert.equal(c.detail, "module not installed");
  assert.match(c.fix ?? "", /single-file app/);
  assert.equal(byId(evaluate(facts({ audioModule: { ok: true, inputs: 0, error: null } })), "module").status, "fail");
});

test("an input that will not open fails with the device's own error, and the checks that depend on it are skipped", () => {
  const f = facts({ audio: goodAudio({ link: "down", lastError: "device has 2 input channels but needs 8", blocks: 0 }) });
  const checks = evaluate(f);
  assert.equal(byId(checks, "input").status, "fail");
  assert.equal(byId(checks, "input").detail, "device has 2 input channels but needs 8");
  assert.deepEqual([byId(checks, "flow").status, byId(checks, "signal").status, byId(checks, "channels").status], ["skip", "skip", "skip"]);
  assert.equal(buildReport(f).result, "fail");
});

test("slow, late or dropped audio is graded: a little is a warning, a lot is a failure", () => {
  const flow = (over: Partial<AudioFacts>): string => byId(evaluate(facts({ audio: goodAudio(over) })), "flow").status;
  assert.equal(flow({ blocks: Math.round(RATE * 8 * 0.99) }), "pass");
  assert.equal(flow({ blocks: Math.round(RATE * 8 * 0.94) }), "warn");
  assert.equal(flow({ blocks: Math.round(RATE * 8 * 0.8) }), "fail");
  assert.equal(flow({ overruns: 1 }), "warn");
  assert.equal(flow({ stale: 2 }), "pass");
  assert.equal(flow({ stale: 30 }), "warn");
  assert.equal(flow({ dead: true }), "fail");
  const c = byId(evaluate(facts({ audio: goodAudio({ blocks: 300, stale: 3 }) })), "flow");
  assert.equal(c.detail, "37.5 of 46.9 blocks per second over 8 s; 3 late, 0 dropped by the driver");
});

test("exact zeros are reported as a blocked microphone with the fix for the system in use", () => {
  const silent = goodAudio({
    channels: [
      { ch: 1, label: "Lead vocal", mapped: true, rmsDb: -240, peakDb: -240 },
      { ch: 8, label: "FOH meas mic", mapped: true, rmsDb: -240, peakDb: -240 },
    ],
  });
  const mac = byId(evaluate(facts({ audio: silent, platform: "darwin" })), "signal");
  assert.equal(mac.status, "fail");
  assert.match(mac.fix ?? "", /System Settings → Privacy & Security → Microphone/);
  const win = byId(evaluate(facts({ audio: silent, platform: "win32" })), "signal");
  assert.match(win.fix ?? "", /Settings → Privacy & security → Microphone/);
  assert.equal(byId(evaluate(facts()), "signal").detail, "loudest peak -18 dBFS");
});

test("a quiet channel or one missing from the map is a warning that lists every channel's level", () => {
  const c = byId(
    evaluate(
      facts({
        audio: goodAudio({
          channels: [
            { ch: 1, label: "Lead vocal", mapped: true, rmsDb: -30, peakDb: -18 },
            { ch: 2, label: "Harmony vox L", mapped: true, rmsDb: -96, peakDb: -90 },
            { ch: 3, label: "Harmony vox R", mapped: false, rmsDb: null, peakDb: null },
          ],
        }),
      }),
    ),
    "channels",
  );
  assert.equal(c.status, "warn");
  assert.equal(c.detail, "1 channel showed no signal; 1 channel missing from the channel map");
  assert.deepEqual(c.rows, [
    "ch 1 Lead vocal: -30 dBFS",
    "ch 2 Harmony vox L: -96 dBFS (no signal)",
    "ch 3 Harmony vox R: not in the channel map",
  ]);
  assert.match(c.fix ?? "", /Make sound on each quiet channel/);
  assert.match(c.fix ?? "", /Add the missing channels/);
});

test("the console check tells a busy port from a console that does not answer", () => {
  const con = (over: Partial<NonNullable<DiagFacts["console"]>>): Check =>
    byId(
      evaluate(
        facts({
          console: {
            emulated: false,
            address: "192.168.1.50",
            listening: true,
            listenError: null,
            windowS: 8,
            packets: 70,
            meters: 16,
            ...over,
          },
        }),
      ),
      "console",
    );
  assert.equal(con({}).detail, "70 meter packets from 192.168.1.50 (16 meters each)");
  const silent = con({ packets: 0 });
  assert.equal(silent.status, "fail");
  assert.equal(silent.detail, "no reply from 192.168.1.50 in 8 s");
  assert.match(silent.fix ?? "", /CONSOLE_IP/);
  const busy = con({ listening: false, listenError: "address in use" });
  assert.equal(busy.status, "fail");
  assert.match(busy.fix ?? "", /Another copy of the app/);
  assert.equal(byId(evaluate(facts({ console: null })), "console").status, "skip");
  assert.match(con({ emulated: true }).detail, /built-in console emulator/);
});

test("tablet access needs a PIN, prefers HTTPS and is skipped when the dashboard is local only", () => {
  const net = (n: DiagFacts["network"]): Check => byId(evaluate(facts({ network: n })), "network");
  assert.equal(net({ lan: false, url: null, pin: false, https: false }).status, "skip");
  assert.equal(net({ lan: true, url: "http://10.0.0.2:8770/", pin: false, https: false }).status, "fail");
  assert.equal(net({ lan: true, url: "http://10.0.0.2:8770/", pin: true, https: false }).status, "warn");
  const ok = net({ lan: true, url: "https://10.0.0.2:8770/", pin: true, https: true });
  assert.equal(ok.status, "pass");
  assert.ok(ok.detail.includes("https://10.0.0.2:8770/"));
  assert.deepEqual(networkFacts(parseCliArgs(["--lan", "--pin", "246810", "--https"]), "10.0.0.2"), {
    lan: true,
    url: "https://10.0.0.2:8770/",
    pin: true,
    https: true,
  });
  assert.equal(networkFacts(parseCliArgs([]), "10.0.0.2").lan, false);
});

test("simulation skips everything that needs real gear", () => {
  const s = statuses(
    facts({ audio: null, audioSkipped: "simulation mode", console: null, network: { lan: false, url: null, pin: false, https: false } }),
  );
  assert.deepEqual(s, { module: "pass", input: "skip", flow: "skip", signal: "skip", channels: "skip", console: "skip", network: "skip" });
});

test("the report never contains the PIN", () => {
  const args = parseCliArgs(["--lan", "--pin", "s3cret-pin", "--https"]);
  const text = buildReport(facts({ network: networkFacts(args, "10.0.0.2") })).text;
  assert.ok(!text.includes("s3cret-pin"));
});

test("the level window keeps the loudest reading per channel", () => {
  const w = new LevelWindow();
  const block = (rms: number, peak: number): AnalysedBlock => ({
    feats: new Map([[1, { ...emptyFeatures(), rmsDbfs: rms, peakDbfs: peak }]]),
    phases: [],
  });
  w.add(block(-40, -30));
  w.add(block(-20, -10));
  w.add(block(-50, -45));
  assert.equal(w.blocks, 3);
  assert.deepEqual(
    w.levels(
      new Map([
        [1, "Lead vocal"],
        [2, "Harmony"],
      ]),
      new Set([1]),
    ),
    [
      { ch: 1, label: "Lead vocal", mapped: true, rmsDb: -20, peakDb: -10 },
      { ch: 2, label: "Harmony", mapped: false, rmsDb: null, peakDb: null },
    ],
  );
});

class FeedingClock extends ManualClock {
  onLongSleep: (() => void) | null = null;

  override sleep(seconds: number): Promise<void> {
    if (seconds >= 1 && this.onLongSleep !== null) this.onLongSleep();
    return super.sleep(seconds);
  }
}

class QuietSource extends CaptureSourceBase {
  block(): Frame {
    return new Map();
  }

  override status(): CaptureStatus {
    return { kind: "audio", name: "Console USB", channels: 32, link: "open", dead: false, stale: 0, overruns: 0, lastError: null };
  }
}

const host = (over: Partial<DiagHost> = {}): DiagHost => ({
  app: "test build",
  system: "Windows 11 x64",
  platform: "win32",
  home: null,
  mode: "hardware, console at 192.168.1.50",
  audioModule: { ok: true, inputs: 4, error: null },
  audioSkipped: null,
  mappedChannels: null,
  consoleEmulated: false,
  network: { lan: false, url: null, pin: false, https: false },
  ...over,
});

const loudBlock = (): AnalysedBlock => ({
  feats: new Map([...C.CHANNELS.keys()].map((ch) => [ch, { ...emptyFeatures(), rmsDbfs: -30, peakDbfs: -20 }])),
  phases: [],
});

const diagOf = (e: Engine): { status: string; report: DiagReport | null } =>
  e.snapshot()["diagnostics"] as { status: string; report: DiagReport | null };

test("the engine's check run measures the running source and console feed and publishes the report", async () => {
  const clock = new FeedingClock(100, 1_700_000_000);
  const e = new Engine({ clock, source: new QuietSource(), sim: false });
  e.diagHost = () => host();
  e.meterRx = { start: () => Promise.resolve(), stop: () => undefined };
  clock.onLongSleep = () => {
    for (let i = 0; i < Math.round(RATE * 8); i++) e.onPushedBlock(loudBlock(), 0);
    for (let i = 0; i < 70; i++) e.setConsoleMeters(new Array<number>(16).fill(0));
  };
  assert.equal(diagOf(e).status, "idle");
  const before = e.assistant.faderDb.get(1);
  await e.runDiagnostics(8);
  const d = diagOf(e);
  assert.equal(d.status, "done");
  const report = d.report;
  assert.ok(report !== null);
  assert.deepEqual(
    report.checks.map((c) => c.status),
    ["pass", "pass", "pass", "pass", "pass", "pass", "skip"],
  );
  assert.equal(byId(report.checks, "console").detail, "70 meter packets from the console (16 meters each)");
  assert.equal(e.assistant.faderDb.get(1), before);
  assert.ok(e.events.some((ev) => ev.msg === "checks finished: 0 failed, 0 warnings, 6 passed, 1 skipped"));
});

test("a check run with no audio arriving fails the flow check, and a second request while one runs is ignored", async () => {
  const clock = new FeedingClock(100, 1_700_000_000);
  const e = new Engine({ clock, source: new QuietSource(), sim: false });
  e.diagHost = () => host();
  let nested: Promise<void> | null = null;
  clock.onLongSleep = () => {
    nested ??= e.runDiagnostics(8);
    assert.equal(diagOf(e).status, "running");
  };
  await e.runDiagnostics(8);
  await nested;
  const report = diagOf(e).report;
  assert.ok(report !== null);
  assert.equal(byId(report.checks, "flow").status, "fail");
  assert.equal(byId(report.checks, "console").status, "fail");
  assert.equal(e.events.filter((ev) => ev.msg.startsWith("checks finished")).length, 1);
});

test("checks are refused during calibration, do nothing without host facts, and skip real gear in simulation", async () => {
  const clock = new FeedingClock(100, 1_700_000_000);
  const e = new Engine({ clock, source: new QuietSource(), sim: false });
  await e.runDiagnostics(8);
  assert.equal(diagOf(e).status, "idle");
  e.diagHost = () => host();
  e.status = "calibrating";
  await e.runDiagnostics(8);
  assert.equal(diagOf(e).report, null);
  assert.ok(e.events.some((ev) => ev.msg.includes("checks cannot run during calibration")));

  const sim = new Engine({ clock: new ManualClock(100, 1_700_000_000), sim: true });
  sim.diagHost = () => host({ mode: "simulation" });
  sim.command({ type: "diagnose" });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const report = diagOf(sim).report;
  assert.ok(report !== null);
  assert.deepEqual(
    report.checks.map((c) => c.status),
    ["pass", "skip", "skip", "skip", "skip", "skip", "skip"],
  );
});

class RecordingSink implements DatagramSink {
  sent: string[] = [];
  closed = false;

  send(data: Uint8Array): void {
    for (const m of decodePacket(data)) this.sent.push(m.address);
  }

  close(): void {
    this.closed = true;
  }
}

const meterPacket = (): Uint8Array => encodeMessage("/meters/1", [oscBlob(encodeMeterBlob([0.1, 0.2, 0.3]))]);

test("the console probe sends only the meter subscription, from the port it listens on, and hears the replies sent back there", async () => {
  const clock = new ManualClock(100, 1_700_000_000);
  const net = new MemNetwork();
  const desk = await net.bind(C.CONSOLE_PORT, "0.0.0.0");
  const seen: { address: string; port: number }[] = [];
  desk.onMessage((data, from) => {
    for (const m of decodePacket(data)) seen.push({ address: m.address, port: from.port });
    desk.send(meterPacket(), from);
  });
  const rx = new MeterReceiver(net, { ip: "0.0.0.0" });
  const fallback = new RecordingSink();
  const con = new OscConsole(new SharedPortSink(rx, { host: "127.0.0.1", port: C.CONSOLE_PORT }, fallback), { clock, ip: "127.0.0.1" });
  const probe = new ConsoleProbe(con, rx, clock);
  await probe.start();
  for (let i = 0; i < 4; i++) await net.settle();
  clock.advance(8);
  const f = probe.facts(false, "127.0.0.1");
  probe.stop();
  assert.deepEqual(seen, [
    { address: "/batchsubscribe", port: C.LOCAL_PORT },
    { address: "/xremote", port: C.LOCAL_PORT },
  ]);
  assert.deepEqual(fallback.sent, []);
  assert.ok(fallback.closed);
  assert.deepEqual([f.listening, f.packets, f.meters, f.windowS], [true, 2, 3, 8]);
});

test("a probe that cannot listen sends nothing, and the console link falls back to a plain socket until it is listening", async () => {
  const clock = new ManualClock(100, 1_700_000_000);
  const blocked = new MemNetwork();
  await blocked.bind(C.LOCAL_PORT, "0.0.0.0");
  const rx = new MeterReceiver(blocked, { ip: "0.0.0.0" });
  const fallback = new RecordingSink();
  const con = new OscConsole(new SharedPortSink(rx, { host: "127.0.0.1", port: C.CONSOLE_PORT }, fallback), { clock, ip: "127.0.0.1" });
  const busy = new ConsoleProbe(con, rx, clock);
  await busy.start();
  assert.equal(busy.facts(false, "127.0.0.1").listening, false);
  assert.deepEqual(fallback.sent, []);
  con.subscribeMeters();
  assert.deepEqual(fallback.sent, ["/batchsubscribe", "/xremote"]);
  busy.stop();
});

function testIo(lines: string[], seconds: number): Io {
  return {
    out: (l) => lines.push(l),
    clock: new SystemClock(),
    audio: () => NativeAudioInputFactory.create(),
    factory: null,
    connect: captureThread,
    udp: new NodeUdpFactory(),
    waitForStop: () => Promise.resolve(),
    layout: findLayout(),
    diagnoseSeconds: seconds,
  };
}

test("--diagnose in simulation prints the report and exits cleanly without starting the dashboard", async () => {
  const lines: string[] = [];
  const code = await run(["--diagnose"], testIo(lines, 0.2));
  const text = lines.join("\n");
  assert.ok(text.includes("===== Trio Mix-Assistant checks ====="), text);
  assert.ok(text.includes("Mode: simulation"), text);
  assert.ok(/Result: \d+ failed/.test(text), text);
  assert.ok(!text.includes("Dashboard"), text);
  const moduleFailed = text.includes("[FAIL] Audio module loads");
  assert.equal(code, moduleFailed ? 1 : 0);
});

test("--diagnose against the built-in emulator hears the console feed", () =>
  withEmulatorPorts(async () => {
    const lines: string[] = [];
    await run(["--diagnose", "--emulate", "--lan", "--pin", "246810", "--https"], testIo(lines, 1.5));
    const text = lines.join("\n");
    assert.ok(text.includes("Mode: emulated console"), text);
    assert.ok(/\[PASS\] Console answers: \d+ meter packets from the built-in console emulator/.test(text), text);
    assert.ok(text.includes("[PASS] Tablet access"), text);
    assert.ok(!text.includes("246810"), text);
  }));

async function againstFakeConsole(answers: boolean): Promise<{ text: string; heard: { address: string; port: number }[] }> {
  const heard: { address: string; port: number }[] = [];
  const desk = dgram.createSocket("udp4");
  desk.on("message", (data, from) => {
    for (const m of decodePacket(new Uint8Array(data))) heard.push({ address: m.address, port: from.port });
    if (answers) for (let i = 0; i < 5; i++) desk.send(meterPacket(), from.port, from.address);
  });
  await new Promise<void>((resolve, reject) => {
    desk.once("error", reject);
    desk.bind(C.CONSOLE_PORT, "127.0.0.1", () => resolve());
  });
  const lines: string[] = [];
  try {
    await run(["--diagnose", "--hardware", "--console-ip", "127.0.0.1"], testIo(lines, 1.0));
  } finally {
    await new Promise<void>((resolve) => desk.close(() => resolve()));
  }
  return { text: lines.join("\n"), heard };
}

test("--diagnose hears a console that replies to the sending port, as a real one does, and sends it nothing but the subscription", () =>
  withEmulatorPorts(async () => {
    const { text, heard } = await againstFakeConsole(true);
    assert.ok(/\[PASS\] Console answers: \d+ meter packets from 127\.0\.0\.1 \(3 meters each\)/.test(text), text);
    assert.ok(text.includes("[SKIP] Chosen input opens: no audio input is selected"), text);
    assert.deepEqual([...new Set(heard.map((h) => h.address))].sort(), ["/batchsubscribe", "/xremote"]);
    assert.deepEqual([...new Set(heard.map((h) => h.port))], [C.LOCAL_PORT]);
  }));

test("--diagnose reports a console that does not answer", () =>
  withEmulatorPorts(async () => {
    const { text, heard } = await againstFakeConsole(false);
    assert.ok(text.includes("[FAIL] Console answers: no reply from 127.0.0.1"), text);
    assert.ok(heard.length > 0);
  }));

test("the launcher runs the checks for the show.conf setup instead of starting the show", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trio-diag-"));
  try {
    writeFileSync(join(dir, "show.conf"), "MODE=sim\nLAN=no\n");
    const lines: string[] = [];
    const io = testIo(lines, 0.2);
    let opened = false;
    await launch(["--diagnose"], { ...io, layout: { ...io.layout, appDir: dir } }, () => {
      opened = true;
    });
    const text = lines.join("\n");
    assert.ok(text.includes("===== Trio Mix-Assistant checks ====="), text);
    assert.ok(!text.includes("Press Ctrl+C"), text);
    assert.equal(opened, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the home folder is taken out of every line of the report", () => {
  const home = "C:\\Users\\someone";
  const report = buildReport(
    facts({
      home,
      audioModule: {
        ok: false,
        inputs: 0,
        error: "could not load C:\\Users\\someone\\AppData\\Local\\TrioMixAssistant\\runtime\\x\\naudiodon.node",
      },
      audio: goodAudio({ link: "down", lastError: "open failed at C:/Users/someone/dev" }),
    }),
  );
  assert.ok(!report.text.includes("someone"), report.text);
  assert.ok(report.text.includes("~\\AppData\\Local\\TrioMixAssistant"), report.text);
  assert.ok(report.checks.every((c) => !c.detail.includes("someone")));
  assert.equal(redact("/Users/someone/x and /Users/someone/y", "/Users/someone"), "~/x and ~/y");
  assert.equal(redact("unchanged", null), "unchanged");
});

interface FakeInput {
  name: string;
  inputs: number;
  level: number;
}

class PacedFactory implements AudioInputFactory {
  private readonly fakes: FakeInput[];

  constructor(fakes: FakeInput[]) {
    this.fakes = fakes;
  }

  listDevices(): AudioDeviceInfo[] {
    return this.fakes.map((f) => ({ name: f.name, max_input_channels: f.inputs, default_samplerate: 48000, hostapi: 0 }));
  }

  listHostApis(): { name: string }[] {
    return [{ name: "Test audio" }];
  }

  defaultInputIndex(): number | null {
    return 0;
  }

  queryDevice(device: number | string | null): AudioDeviceInfo {
    const d = this.listDevices()[Number(device)];
    if (d === undefined) throw new Error(`could not query audio device ${String(device)}`);
    return d;
  }

  open(options: AudioInputOptions, cb: AudioInputCallback): AudioInputStream {
    const fake = this.fakes[Number(options.device)]!;
    let timer: ReturnType<typeof setInterval> | null = null;
    let sent = 0;
    let t0 = 0;
    const feed = (): void => {
      const due = Math.floor(((performance.now() - t0) / 1000) * (C.SAMPLE_RATE / C.BLOCK));
      for (; sent < due; sent++) cb(new Float32Array(C.BLOCK * options.channels).fill(fake.level), false);
    };
    return {
      start: () => {
        t0 = performance.now();
        timer = setInterval(feed, 5);
      },
      stop: () => undefined,
      close: () => {
        if (timer !== null) clearInterval(timer);
      },
    };
  }
}

async function diagnoseInputs(fakes: FakeInput[], argv: string[]): Promise<{ code: number; text: string }> {
  const saved = channelMapState();
  const factory = new PacedFactory(fakes);
  const lines: string[] = [];
  const io = testIo(lines, 1.5);
  try {
    const code = await run(argv, {
      ...io,
      audio: () => Promise.resolve(factory),
      connect: () => loopbackPort(factory, io.clock, threadStamp),
    });
    return { code, text: lines.join("\n") };
  } finally {
    restoreChannelMapState(saved);
  }
}

test("--diagnose --audio-device checks one small input on its own and passes when audio flows", async () => {
  const { code, text } = await diagnoseInputs(
    [
      { name: "Speakers", inputs: 0, level: 0 },
      { name: "USB mic", inputs: 2, level: 0.05 },
    ],
    ["--diagnose", "--audio-device", "1"],
  );
  assert.ok(text.includes("the channel map is fitted to its 2 inputs"), text);
  assert.ok(text.includes("[PASS] Audio module loads: loaded, 1 input found"), text);
  assert.ok(text.includes("[PASS] Chosen input opens: 'USB mic', 2 channels, 48000 Hz"), text);
  assert.ok(/\[(PASS|WARN)\] Audio is arriving/.test(text), text);
  assert.ok(text.includes("[PASS] Signal is not digital silence: loudest peak -26 dBFS"), text);
  assert.ok(text.includes("[PASS] Each channel shows a level: all 2 channels carry signal"), text);
  assert.equal(code, 0, text);
});

test("--diagnose reports an input that delivers only zeros as blocked, and exits with 1", async () => {
  const { code, text } = await diagnoseInputs([{ name: "Muted mic", inputs: 2, level: 0 }], ["--diagnose", "--audio-device", "0"]);
  assert.ok(text.includes("[PASS] Chosen input opens"), text);
  assert.ok(text.includes("[FAIL] Signal is not digital silence: every sample is exactly zero"), text);
  assert.ok(/Fix: .*microphone/i.test(text), text);
  assert.equal(code, 1, text);
});

test("--diagnose reports an input that does not exist or is too small for the show", async () => {
  const gone = await diagnoseInputs([{ name: "USB mic", inputs: 2, level: 0.05 }], ["--diagnose", "--audio-device", "7"]);
  assert.ok(gone.text.includes("[FAIL] Chosen input opens"), gone.text);
  assert.ok(gone.text.includes("[SKIP] Audio is arriving"), gone.text);
  assert.equal(gone.code, 1);
  const small = await withEmulatorPorts(() =>
    diagnoseInputs([{ name: "USB mic", inputs: 2, level: 0.05 }], ["--diagnose", "--emulate", "--audio-device", "0"]),
  );
  assert.ok(/\[FAIL\] Chosen input opens: .*has 2 input channel\(s\) but this setup needs 8/.test(small.text), small.text);
  assert.ok(small.text.includes("To test a small input on its own"), small.text);
  assert.equal(small.code, 1);
});

test("only devices with inputs are counted, and a module that will not list devices is reported", () => {
  const factory = new PacedFactory([
    { name: "Speakers", inputs: 0, level: 0 },
    { name: "Mic", inputs: 1, level: 0 },
  ]);
  assert.deepEqual(moduleFacts(factory), { ok: true, inputs: 1, error: null });
  assert.deepEqual(moduleFacts(null), { ok: false, inputs: 0, error: "the audio module was not loaded" });
  const broken: AudioInputFactory = Object.assign(Object.create(factory) as AudioInputFactory, {
    listDevices: (): AudioDeviceInfo[] => {
      throw new Error("module not installed");
    },
  });
  assert.deepEqual(moduleFacts(broken), { ok: false, inputs: 0, error: "module not installed" });
});
