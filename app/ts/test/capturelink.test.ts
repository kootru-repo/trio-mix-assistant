import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysedBlock } from "../src/core/blockanalysis.ts";
import { BlockAnalyser } from "../src/core/blockanalysis.ts";
import { CaptureError } from "../src/core/capture.ts";
import type { Frame } from "../src/core/capture.ts";
import { RemoteCapture, loopbackPort } from "../src/core/capturelink.ts";
import type { CapturePort, FromCapture, RemoteCaptureOptions, ToCapture } from "../src/core/capturelink.ts";
import { ManualClock } from "../src/core/clock.ts";
import { C } from "../src/core/config.ts";
import { DeviceCapture } from "../src/core/devicecapture.ts";
import type { AudioInputCallback, AudioInputFactory, AudioInputStream } from "../src/core/devicecapture.ts";
import { Engine } from "../src/core/engine/index.ts";
import { TimedAudioFactory } from "../src/core/timedaudio.ts";
import { captureThread } from "../src/host/capturethread.ts";
import { SystemClock, threadStamp } from "../src/host/clock.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const busy = (ms: number): void => {
  const until = performance.now() + ms;
  while (performance.now() < until);
};

const tone = (n: number, amp: number): Float32Array => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 1000 * i) / 48000));

test("the analyser works from the configuration it is given, not from this thread's settings", () => {
  const frame: Frame = new Map([
    [1, tone(C.BLOCK, 0.5)],
    [2, tone(C.BLOCK, 0.5)],
    [3, tone(C.BLOCK, 0.25)],
  ]);
  const out = new BlockAnalyser().analyse(frame, { channels: [2, 3], measCh: 3, phasePairs: [[2, 3]], sampleRate: 48000 });
  assert.deepEqual([...out.feats.keys()], [2, 3]);
  assert.ok(Math.abs(out.feats.get(2)!.rmsDbfs - -9.03) < 0.2);
  assert.deepEqual(
    out.phases.map((p) => [p.a, p.b]),
    [[2, 3]],
  );
  assert.ok(out.phases[0]!.relation.zeroCorr > 0.9);
  const none = new BlockAnalyser().analyse(frame, { channels: [2, 3], measCh: 3, phasePairs: [[2, 3]], sampleRate: 48000 }, undefined, false);
  assert.deepEqual(none.phases, []);
});

class PushFactory implements AudioInputFactory {
  callback: AudioInputCallback | null = null;
  opens = 0;
  closed = 0;
  refuse = false;
  queryDevice() {
    return { name: "Push", max_input_channels: 8, default_samplerate: 48000, hostapi: 0 };
  }
  listDevices() {
    return [this.queryDevice()];
  }
  listHostApis() {
    return [{ name: "fake" }];
  }
  defaultInputIndex(): number | null {
    return 0;
  }
  open(_options: unknown, cb: AudioInputCallback): AudioInputStream {
    if (this.refuse) throw new Error("Invalid device");
    this.opens += 1;
    this.callback = cb;
    return { start: () => undefined, stop: () => undefined, close: () => void this.closed++ };
  }
}

const frameOf = (cols: number, level: number): Float32Array => new Float32Array(C.BLOCK * cols).fill(level);

test("in push mode every arriving block is handed over once, with no timer in between", () => {
  const factory = new PushFactory();
  const clock = new ManualClock(10);
  const cap = new DeviceCapture({ factory, clock, channelMap: new Map([[1, 0], [8, 1]]) });
  const seen: number[] = [];
  cap.subscribeFrames((frame) => seen.push(Math.round(frame.get(8)![0]! * 10)));
  cap.start();
  for (const v of [0.1, 0.2, 0.3]) factory.callback!(frameOf(2, v), false);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(cap.skipped, 0);
  assert.equal(cap.underruns, 0);
});

test("in push mode a device is dead when nothing has arrived for a while, and never just because it was stopped", () => {
  const factory = new PushFactory();
  const clock = new ManualClock(10);
  const cap = new DeviceCapture({ factory, clock, channelMap: new Map([[8, 0]]) });
  cap.subscribeFrames(() => undefined);
  assert.equal(cap.dead(), false);
  cap.start();
  clock.advance(cap.DEAD_AFTER_S - 0.1);
  assert.equal(cap.dead(), false);
  clock.advance(0.2);
  assert.equal(cap.dead(), false, "first look: audio may be waiting to be read after a stall");
  clock.advance(cap.DEAD_CONFIRM_S + 0.01);
  assert.equal(cap.dead(), true, "opened but silent on the wire");
  factory.callback!(frameOf(1, 0.1), false);
  assert.equal(cap.dead(), false);
  clock.advance(cap.DEAD_AFTER_S + 2.0);
  assert.equal(cap.dead(), false, "a stall of the whole app is not proof the device is gone");
  factory.callback!(frameOf(1, 0.1), false);
  clock.advance(cap.DEAD_CONFIRM_S + 0.01);
  assert.equal(cap.dead(), false, "the waiting audio arrived");
  clock.advance(cap.DEAD_AFTER_S + 0.1);
  assert.equal(cap.dead(), false);
  clock.advance(cap.DEAD_CONFIRM_S + 0.01);
  assert.equal(cap.dead(), true);
  cap.stop();
  assert.equal(cap.dead(), false);
  factory.refuse = true;
  assert.throws(() => cap.start());
  assert.equal(cap.dead(), true, "a device that would not open must be retried");
});

test("in push mode a room-mic recording is cut from the arriving blocks", async () => {
  const factory = new PushFactory();
  const clock = new ManualClock(10);
  const cap = new DeviceCapture({ factory, clock, channelMap: new Map([[1, 0], [8, 1]]) });
  cap.subscribeFrames(() => undefined);
  cap.start();
  const seconds = (3 * C.BLOCK) / C.SAMPLE_RATE;
  const pending = cap.captureMeas(seconds);
  const one = new Float32Array(C.BLOCK * 2);
  for (let i = 0; i < C.BLOCK; i++) one[i * 2 + 1] = 0.5;
  for (let i = 0; i < 4; i++) factory.callback!(one, false);
  const rec = await pending;
  assert.ok(rec !== null);
  assert.equal(rec.length, 3 * C.BLOCK);
  assert.ok(rec.every((v) => v === 0.5));
  assert.equal(await cap.captureMeas(1.0), null, "nothing arrived, so there is no recording");
});

const realClock = new SystemClock();

const linked = (factory: AudioInputFactory, extra: Partial<RemoteCaptureOptions> = {}): RemoteCapture =>
  new RemoteCapture({ connect: () => loopbackPort(factory, realClock, threadStamp), clock: realClock, stamp: threadStamp, ...extra });

test("blocks cross the link already analysed, using the channel layout sent when the device was opened", async () => {
  const src = linked(new TimedAudioFactory(realClock), { channelMap: new Map([[1, 0], [3, 7]]), measCh: 3 });
  const saved = { channels: C.CHANNELS, meas: C.MEAS_MIC_CH };
  const blocks: AnalysedBlock[] = [];
  const ages: number[] = [];
  src.subscribe((b, age) => {
    blocks.push(b);
    ages.push(age);
  });
  try {
    C.CHANNELS = new Map([
      [1, "lead_vox"],
      [3, "meas_mic"],
    ]);
    C.MEAS_MIC_CH = 3;
    src.start();
    await src.ready();
  } finally {
    C.CHANNELS = saved.channels;
    C.MEAS_MIC_CH = saved.meas;
  }
  for (let i = 0; i < 100 && blocks.length < 10; i++) await sleep(50);
  const st = src.status();
  src.stop();
  await src.settled();
  assert.ok(blocks.length >= 10, String(blocks.length));
  assert.deepEqual([...blocks[0]!.feats.keys()].sort(), [1, 3]);
  assert.ok(blocks.at(-1)!.feats.get(3)!.rmsDbfs > blocks.at(-1)!.feats.get(1)!.rmsDbfs + 6, "the test tone is on the room-mic column");
  assert.ok(ages.every((a) => a >= 0 && a < 0.25));
  assert.equal(st["link"], "open");
  assert.equal(st["name"], "timed audio (emulated)");
  assert.equal(st["channels"], 8);
  assert.equal(src.dead(), false);
  const count = blocks.length;
  await sleep(100);
  assert.equal(blocks.length, count, "nothing is delivered after stop");
});

test("a device that will not open rejects with a capture error and is reported dead so the engine retries", async () => {
  const src = linked(new TimedAudioFactory(realClock, 2));
  src.start();
  await assert.rejects(src.ready(), (e: unknown) => e instanceof CaptureError && /2 input channel\(s\) but this setup needs 8/.test(e.message));
  assert.equal(src.dead(), true);
  assert.match(String(src.status()["lastError"]), /needs 8/);
  assert.equal(await src.restart(), false);
  src.stop();
  await src.settled();
  assert.equal(src.dead(), false);
});

test("restart, recording and input gain run on the capture side and report back", async () => {
  const factory = new TimedAudioFactory(realClock);
  const src = linked(factory);
  src.subscribe(() => undefined);
  src.start();
  await src.ready();
  const rec = await src.captureMeas(0.2);
  assert.ok(rec instanceof Float32Array && rec.length === Math.trunc(0.2 * C.SAMPLE_RATE));
  assert.equal(await src.restart(), true);
  assert.equal(factory.streams.length, 2);
  const gain = await src.autoGain();
  assert.ok(src.autoDb !== null && src.autoDb > -60, String(src.autoDb));
  assert.equal(gain, src.gainDb);
  src.stop();
  await src.settled();
  assert.equal(await src.captureMeas(0.1), null);
});

class ScriptedPort implements CapturePort {
  sent: ToCapture[] = [];
  closed = 0;
  private handlers: ((m: FromCapture) => void)[] = [];
  private exits: ((reason: string) => void)[] = [];
  post(m: ToCapture): void {
    this.sent.push(m);
  }
  onMessage(h: (m: FromCapture) => void): void {
    this.handlers.push(h);
  }
  onExit(h: (reason: string) => void): void {
    this.exits.push(h);
  }
  close(): void {
    this.closed += 1;
  }
  emit(m: FromCapture): void {
    for (const h of [...this.handlers]) h(m);
  }
  exit(reason: string): void {
    for (const h of [...this.exits]) h(reason);
  }
}

const report = (dead = false) => ({ status: { kind: "audio", dead, silent: false, name: "X", channels: 2 }, gainDb: 0, autoDb: null });
const emptyBlock = (): AnalysedBlock => ({ feats: new Map(), phases: [] });

const scripted = () => {
  const clock = new ManualClock(100);
  const ports: ScriptedPort[] = [];
  let stampMs = 5000;
  const src = new RemoteCapture({
    connect: () => {
      const p = new ScriptedPort();
      ports.push(p);
      return p;
    },
    clock,
    stamp: () => stampMs,
  });
  return { src, clock, ports, setStamp: (ms: number) => (stampMs = ms) };
};

test("blocks that waited too long behind a frozen main thread are counted and dropped, fresh ones carry their age", () => {
  const { src, ports, setStamp } = scripted();
  const got: number[] = [];
  src.subscribe((_b, age) => got.push(age));
  src.start();
  const port = ports[0]!;
  port.emit({ type: "opened", report: report() });
  setStamp(6000);
  port.emit({ type: "block", at: 5100, block: emptyBlock() });
  port.emit({ type: "block", at: 5700, block: emptyBlock() });
  port.emit({ type: "block", at: 5900, block: emptyBlock() });
  assert.deepEqual(got, [0.1]);
  assert.equal(src.stale, 2);
  assert.equal(src.status()["stale"], 2);
});

test("liveness comes from the capture side's own reports, and a silent thread is only called dead after a second look", () => {
  const { src, clock, ports } = scripted();
  src.start();
  assert.equal(src.dead(), false, "still opening");
  const port = ports[0]!;
  port.emit({ type: "opened", report: report() });
  assert.equal(src.dead(), false);
  port.emit({ type: "report", report: report(true) });
  assert.equal(src.dead(), true);
  port.emit({ type: "report", report: report(false) });
  assert.equal(src.dead(), false);
  clock.advance(src.QUIET_S + 1);
  assert.equal(src.dead(), false, "messages may still be waiting to be read after a freeze");
  port.emit({ type: "report", report: report(false) });
  clock.advance(0.5);
  assert.equal(src.dead(), false, "they arrived, so the thread is alive");
  clock.advance(src.QUIET_S + 1);
  assert.equal(src.dead(), false);
  clock.advance(src.CONFIRM_S + 0.01);
  assert.equal(src.dead(), true, "still nothing on the second look");
});

test("a capture thread that dies is reported, pending calls end, and restart starts a new one", async () => {
  const { src, ports } = scripted();
  src.start();
  ports[0]!.emit({ type: "opened", report: report() });
  const pending = src.captureMeas(1.0);
  ports[0]!.exit("exit code 1");
  assert.equal(await pending, null);
  assert.equal(src.dead(), true);
  assert.match(String(src.status()["lastError"]), /audio thread stopped: exit code 1/);
  const again = src.restart();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ports.length, 2);
  assert.equal(ports[1]!.sent[0]!.type, "open");
  ports[1]!.emit({ type: "opened", report: report() });
  assert.equal(await again, true);
  assert.equal(src.dead(), false);
  assert.equal(src.status()["lastError"], null);
});

test("stop asks the capture side to release the device and ends the thread once it has", async () => {
  const { src, ports } = scripted();
  src.start();
  const port = ports[0]!;
  port.emit({ type: "opened", report: report() });
  src.stop();
  assert.deepEqual(port.sent.map((m) => m.type), ["open", "close"]);
  port.emit({ type: "closed" });
  await src.settled();
  assert.equal(port.closed, 1);
  port.emit({ type: "block", at: 0, block: emptyBlock() });
  assert.equal(src.stale, 0, "messages from a dropped thread are ignored");
});

class PushSource {
  handler: ((block: AnalysedBlock, ageS: number) => void) | null = null;
  pulls = 0;
  subscribe(h: (block: AnalysedBlock, ageS: number) => void): void {
    this.handler = h;
  }
  start(): void {}
  stop(): void {}
  block(): Frame {
    this.pulls += 1;
    return new Map();
  }
  captureMeas(): Promise<null> {
    return Promise.resolve(null);
  }
  emitPinkNoise(): Promise<boolean> {
    return Promise.resolve(true);
  }
  dead(): boolean {
    return false;
  }
  silent(): boolean {
    return false;
  }
  restart(): Promise<boolean> {
    return Promise.resolve(false);
  }
  status() {
    return { kind: "audio" };
  }
}

test("with a pushing source the engine analyses nothing on its timer and handles each block when it arrives", async () => {
  const clock = new ManualClock(50);
  const source = new PushSource();
  const engine = new Engine({ clock, source, sim: true });
  const times: number[] = [];
  const onFeatures = engine.assistant.onFeatures.bind(engine.assistant);
  engine.assistant.onFeatures = (ch, feat, now) => {
    times.push(now);
    onFeatures(ch, feat, now);
  };
  await engine.start();
  assert.ok(source.handler !== null);
  engine.step(clock.monotonic(), clock.monotonic());
  assert.equal(source.pulls, 0);
  const lead = C.LEAD_VOCAL_CH;
  const block = new BlockAnalyser().analyse(new Map([[lead, tone(C.BLOCK, 0.2)]]), { channels: [lead], measCh: C.MEAS_MIC_CH, phasePairs: [], sampleRate: C.SAMPLE_RATE });
  const now = clock.monotonic();
  source.handler(block, 0.1);
  assert.equal(times.length, 1);
  assert.ok(Math.abs(times[0]! - (now - 0.1)) < 1e-9, "the block is handled at the time it was captured");
  engine.status = "calibrating";
  source.handler(block, 0);
  assert.equal(times.length, 1, "blocks are not analysed during calibration");
  engine.status = "live";
  await engine.stop();
  source.handler(block, 0);
  assert.equal(times.length, 1);
});

test("a real audio thread keeps capturing while the main thread is frozen, and the engine does not restart it", async () => {
  const source = new RemoteCapture({ connect: () => captureThread("timed"), clock: realClock, stamp: threadStamp });
  const engine = new Engine({ clock: realClock, source, sim: true, tick: C.BLOCK / C.SAMPLE_RATE });
  let handled = 0;
  const onPushed = engine.onPushedBlock.bind(engine);
  engine.onPushedBlock = (block, age) => {
    handled += 1;
    onPushed(block, age);
  };
  await engine.start();
  try {
    assert.equal(source.status()["link"], "open");
    for (let i = 0; i < 200 && handled <= 15; i++) await sleep(50);
    const before = handled;
    const countBefore = handled + source.stale;
    const t0 = performance.now();
    assert.ok(before > 15, `blocks before the freeze: ${before}`);
    busy(1000);
    for (let i = 0; i < 200 && handled <= before + 15; i++) await sleep(50);
    const seconds = (performance.now() - t0) / 1000;
    const produced = handled + source.stale - countBefore;
    const expected = seconds * (C.SAMPLE_RATE / C.BLOCK);
    assert.ok(source.stale > 20, `blocks captured during the freeze must arrive afterwards (stale ${source.stale})`);
    assert.ok(produced > expected * 0.7 && produced < expected * 1.15, `captured ${produced}, expected about ${expected.toFixed(0)}`);
    assert.ok(handled > before + 15, "fresh blocks are handled again after the freeze");
    assert.equal(source.dead(), false);
    const trouble = engine.events.filter((e) => /recover|could not restart|capture off/.test(e.msg)).map((e) => e.msg);
    assert.deepEqual(trouble, []);
  } finally {
    await engine.stop();
  }
});
