import assert from "node:assert/strict";
import test from "node:test";
import { CaptureError } from "../src/core/capture.ts";
import { ManualClock } from "../src/core/clock.ts";
import type { Clock } from "../src/core/clock.ts";
import { C, autoChannelMap, channelMapState, restoreChannelMapState } from "../src/core/config.ts";
import {
  DeviceCapture,
  autodetectInputs,
  formatDeviceList,
  listAudioDevices,
  parseChannelMap,
  pickInput,
  rankInputs,
} from "../src/core/devicecapture.ts";
import type {
  AudioDeviceInfo,
  AudioInputCallback,
  AudioInputFactory,
  AudioInputOptions,
  AudioInputStream,
  DeviceCaptureOptions,
} from "../src/core/devicecapture.ts";
import { fixture } from "./helpers.ts";
import { StepClock } from "./stepclock.ts";

class FakeStream implements AudioInputStream {
  started = 0;
  closed = 0;
  start(): void {
    this.started += 1;
  }
  stop(): void {}
  close(): void {
    this.closed += 1;
  }
}

class FakeFactory implements AudioInputFactory {
  info: AudioDeviceInfo | Error = { name: "Fake", max_input_channels: 64, default_samplerate: 48000, hostapi: 0 };
  openError: Error | null = null;
  opens: AudioInputOptions[] = [];
  streams: FakeStream[] = [];
  devices: AudioDeviceInfo[] = [];
  apis = [{ name: "MME" }];
  defaultIndex: number | null = null;
  listError: Error | null = null;

  queryDevice(): AudioDeviceInfo {
    if (this.info instanceof Error) throw this.info;
    return this.info;
  }
  listDevices(): AudioDeviceInfo[] {
    if (this.listError) throw this.listError;
    return this.devices;
  }
  listHostApis(): { name: string }[] {
    return this.apis;
  }
  defaultInputIndex(): number | null {
    return this.defaultIndex;
  }
  open(options: AudioInputOptions, _cb: AudioInputCallback): AudioInputStream {
    if (this.openError) throw this.openError;
    this.opens.push(options);
    const s = new FakeStream();
    this.streams.push(s);
    return s;
  }
}

type Extra = Partial<Omit<DeviceCaptureOptions, "factory" | "clock">>;

const mk = (opts: Extra = {}, clock: Clock = new ManualClock(100)) => {
  const factory = new FakeFactory();
  const manual = clock as ManualClock;
  const cap = new DeviceCapture({ factory, clock, ...opts });
  return { cap, factory, clock: manual };
};

const constFrame = (ncols: number): Float32Array => {
  const out = new Float32Array(C.BLOCK * ncols);
  for (let i = 0; i < C.BLOCK; i++) for (let c = 0; c < ncols; c++) out[i * ncols + c] = c;
  return out;
};

const fullFrame = (ncols: number, v: number): Float32Array => new Float32Array(C.BLOCK * ncols).fill(v);

const allClose = (a: ArrayLike<number>, v: number, tol = 1e-6): boolean => {
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - v) > tol) return false;
  return true;
};

test("channel mapping picks the right device column", () => {
  const { cap } = mk();
  cap.start();
  cap.onAudio(constFrame(cap.ndev));
  const out = cap.block();
  assert.ok(allClose(out.get(1)!, 0));
  assert.ok(allClose(out.get(2)!, 1));
  assert.ok(allClose(out.get(C.MEAS_MIC_CH)!, C.MEAS_MIC_CH - 1));
  assert.equal(out.get(1)!.length, C.BLOCK);
});

test("drops backlog, keeps latest and counts overruns", () => {
  const { cap } = mk();
  cap.start();
  for (let v = 0; v < 40; v++) cap.onAudio(fullFrame(cap.ndev, v));
  const out = cap.block();
  assert.ok(allClose(out.get(1)!, 39));
  assert.ok(cap.overruns > 0);
});

test("underrun returns silence", () => {
  const { cap } = mk();
  cap.start();
  const out = cap.block();
  assert.ok(allClose(out.get(1)!, 0));
  assert.ok(cap.underruns > 0);
});

test("underrun repeats the last frame before going silent", () => {
  const { cap } = mk();
  cap.start();
  cap.onAudio(fullFrame(cap.ndev, 0.5));
  assert.ok(allClose(cap.block().get(1)!, 0.5));
  assert.ok(allClose(cap.block().get(1)!, 0.5));
  assert.equal(cap.dead(), false);
});

test("captureMeas collects the meas channel", async () => {
  const { cap } = mk();
  cap.start();
  for (let i = 0; i < 3; i++) cap.onAudio(constFrame(cap.ndev));
  const rec = await cap.captureMeas(0.05);
  assert.ok(rec);
  assert.ok(allClose(rec, C.MEAS_MIC_CH - 1));
  assert.equal(rec.length, Math.trunc(0.05 * C.SAMPLE_RATE));
});

test("captureMeas gives up at the deadline with no audio", async () => {
  const { cap, clock } = mk();
  cap.start();
  const t0 = clock.monotonic();
  assert.equal(await cap.captureMeas(0.05), null);
  assert.ok(clock.monotonic() - t0 >= 0.05 + 3.0);
});

test("captureMeas returns null when the meas channel is unmapped", async () => {
  const { cap } = mk({ channelMap: new Map([[1, 0]]) });
  cap.start();
  assert.equal(await cap.captureMeas(0.05), null);
});

test("captureMeas waits for audio that arrives later", async () => {
  const clock = new StepClock(10);
  const { cap } = mk({}, clock);
  cap.start();
  const p = cap.captureMeas(0.05);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(clock.waiting, 1);
  for (let i = 0; i < 4; i++) cap.onAudio(constFrame(cap.ndev));
  await clock.advance(1);
  const rec = await p;
  assert.ok(rec);
  assert.equal(rec.length, 2400);
});

test("dead stream emits silence, not a frozen frame", () => {
  const { cap } = mk();
  cap.start();
  cap.onAudio(fullFrame(cap.ndev, 0.5));
  assert.ok(allClose(cap.block().get(1)!, 0.5));
  let out = cap.block();
  for (let i = 0; i < cap.SILENCE_AFTER + 2; i++) out = cap.block();
  assert.ok(allClose(out.get(1)!, 0));
  assert.equal(cap.dead(), true);
  assert.equal(cap.status()["dead"], true);
});

test("sustained silence is flagged", () => {
  const { cap, clock } = mk();
  cap.start();
  cap.onAudio(new Float32Array(C.BLOCK * cap.ndev));
  cap.block();
  assert.equal(cap.silent(), false);
  clock.advance(cap.SILENCE_HOLD_S + 1);
  assert.equal(cap.silent(), true);
  assert.equal(cap.status()["silent"], true);
});

test("signal clears silence", () => {
  const { cap, clock } = mk();
  cap.start();
  cap.onAudio(new Float32Array(C.BLOCK * cap.ndev));
  cap.block();
  clock.advance(10);
  assert.equal(cap.silent(), true);
  cap.onAudio(fullFrame(cap.ndev, 0.3));
  cap.block();
  assert.equal(cap.silent(), false);
});

test("dead supersedes silent", () => {
  const { cap } = mk();
  cap.start();
  for (let i = 0; i < cap.SILENCE_AFTER + 2; i++) cap.block();
  assert.equal(cap.dead(), true);
  assert.equal(cap.silent(), false);
});

test("a high xrun rate is flagged as overload", () => {
  const { cap, clock } = mk();
  cap.start();
  assert.equal(cap.overload(), false);
  clock.advance(3.0);
  cap.overruns = 100;
  assert.equal(cap.overload(), true);
  assert.equal(cap.status()["overload"], true);
  clock.advance(3.0);
  assert.equal(cap.overload(), false);
});

test("xrun reports from the stream count as overruns", () => {
  const { cap } = mk();
  cap.onAudio(fullFrame(cap.ndev, 0.1), true);
  cap.onAudio(new Float32Array(0), true);
  assert.equal(cap.overruns, 2);
});

test("too few channels raises a clear error", () => {
  const { cap, factory } = mk({ device: 0 });
  factory.info = { name: "Tiny 2in", max_input_channels: 2 };
  assert.throws(
    () => cap.makeInputStream(),
    (e: unknown) =>
      e instanceof CaptureError &&
      e.message ===
        "audio device 'Tiny 2in' has 2 input channel(s) but this setup needs 8 " +
          "(console returns + meas mic). Pick a fuller device or aggregate.",
  );
});

test("device not found raises a clear error", () => {
  const { cap, factory } = mk({ device: 999 });
  factory.info = new Error("no such device");
  assert.throws(
    () => cap.makeInputStream(),
    (e: unknown) =>
      e instanceof CaptureError &&
      e.message ===
        "audio device 999 could not be opened (Error: no such device). Run --list-devices and check --audio-device.",
  );
});

test("open failure raises a clear error", () => {
  const { cap, factory } = mk({ device: "Mic" });
  factory.openError = new Error("busy");
  assert.throws(
    () => cap.start(),
    (e: unknown) =>
      e instanceof CaptureError &&
      e.message ===
        "could not open audio device 'Mic' at 48000 Hz (Error: busy). " +
          "It may be in use by another app, or not support 48000 Hz.",
  );
});

test("start opens the stream once with the mapped channel count", () => {
  const { cap, factory } = mk();
  cap.start();
  cap.start();
  assert.equal(factory.opens.length, 1);
  assert.deepEqual(factory.opens[0], { device: null, channels: 8, sampleRate: 48000, blockSize: C.BLOCK });
  assert.equal(cap.status()["name"], "Fake");
  assert.equal(cap.status()["device"], "default");
});

test("stop closes the stream and restart revives a dead one", async () => {
  const { cap, factory } = mk();
  cap.start();
  for (let i = 0; i < cap.SILENCE_AFTER + 2; i++) cap.block();
  assert.equal(cap.dead(), true);
  assert.equal(await cap.restart(), true);
  assert.equal(cap.dead(), false);
  assert.equal(factory.streams.length, 2);
  assert.equal(factory.streams[0]!.closed, 1);
  cap.stop();
  assert.equal(factory.streams[1]!.closed, 1);
});

test("restart reports failure when the device cannot be re-opened", async () => {
  const { cap, factory } = mk();
  cap.start();
  factory.openError = new Error("gone");
  assert.equal(await cap.restart(), false);
});

test("output device is wired and pink noise goes to the sink", async () => {
  const played: [number, unknown][] = [];
  const sink = {
    play: (s: Float32Array, sr: number, dev: unknown) => {
      played.push([s.length + sr, dev]);
    },
  };
  const { cap } = mk({ device: 0, outputDevice: 3, outputSink: sink });
  assert.equal(cap.outputDevice, 3);
  assert.equal(await cap.emitPinkNoise(new Float32Array(10)), true);
  assert.deepEqual(played, [[48010, 3]]);
  assert.equal(await mk().cap.emitPinkNoise(new Float32Array(10)), false);
  const bad = mk({
    outputSink: {
      play: () => {
        throw new Error("x");
      },
    },
  });
  assert.equal(await bad.cap.emitPinkNoise(new Float32Array(1)), false);
});

test("input gain boosts capture", () => {
  const { cap } = mk({ gainDb: 20.0 });
  cap.start();
  cap.onAudio(fullFrame(cap.ndev, 0.05));
  assert.ok(Math.abs(cap.block().get(1)![0]! - 0.5) < 1e-3);
  const plain = mk().cap;
  plain.start();
  plain.onAudio(fullFrame(plain.ndev, 0.05));
  assert.ok(Math.abs(plain.block().get(1)![0]! - 0.05) < 1e-3);
});

test("a custom channel map reaches capture", () => {
  const { cap } = mk({ device: 0, channelMap: parseChannelMap("1:0,8:9") });
  assert.deepEqual(
    [...cap.channelMap],
    [
      [1, 0],
      [8, 9],
    ],
  );
  assert.equal(cap.ndev, 10);
});

test("meas channel follows the active auto map", async () => {
  const snap = channelMapState();
  try {
    autoChannelMap(1);
    const { cap } = mk();
    assert.equal(cap.measCh, 1);
    assert.ok(cap.channelMap.has(cap.measCh));
    cap.start();
    for (let i = 0; i < 4; i++) cap.onAudio(fullFrame(cap.ndev, 0.2));
    const rec = await cap.captureMeas(0.05);
    assert.ok(rec);
    assert.ok(allClose(rec, 0.2));
  } finally {
    restoreChannelMapState(snap);
  }
});

test("auto map with n inputs makes the last the meas mic", () => {
  const snap = channelMapState();
  try {
    autoChannelMap(1);
    assert.deepEqual([...C.CHANNELS], [[1, "meas_mic"]]);
    assert.equal(C.MEAS_MIC_CH, 1);
    assert.equal(C.BALANCE_CHANNELS.length, 0);
    autoChannelMap(4);
    assert.equal(C.CHANNELS.size, 4);
    assert.equal(C.CHANNELS.get(4), "meas_mic");
    assert.equal(C.MEAS_MIC_CH, 4);
  } finally {
    restoreChannelMapState(snap);
  }
});

test("autoGain boosts a quiet mic toward the target", async () => {
  const { cap } = mk();
  cap.start();
  for (let i = 0; i < 32; i++) cap.onAudio(fullFrame(cap.ndev, 0.01));
  const g = await cap.autoGain(-20.0, 0.08);
  assert.ok(g > 12.0 && g < 28.0, String(g));
});

test("autoGain returns 0 when no audio arrives", async () => {
  const { cap } = mk();
  cap.start();
  assert.equal(await cap.autoGain(-20.0, 0.08), 0.0);
  assert.equal(cap.autoDb, null);
});

test("pick prefers native rate and modern API", () => {
  const apis = [{ name: "MME" }, { name: "Windows DirectSound" }, { name: "Windows WASAPI" }];
  const devs = [
    { name: "Mic (Q9U)", max_input_channels: 1, default_samplerate: 44100, hostapi: 0 },
    { name: "Speakers", max_input_channels: 0, default_samplerate: 48000, hostapi: 0 },
    { name: "Mic (Q9U)", max_input_channels: 1, default_samplerate: 44100, hostapi: 1 },
    { name: "Mic (Q9U)", max_input_channels: 1, default_samplerate: 48000, hostapi: 2 },
  ];
  const pick = pickInput(devs, apis, "Mic (Q9U)", 48000);
  assert.equal(pick?.index, 3);
  assert.equal(pick?.samplerate, 48000);
  assert.equal(pick?.channels, 1);
});

test("pick is null when there are no inputs", () => {
  const devs = [{ name: "Spk", max_input_channels: 0, default_samplerate: 48000, hostapi: 0 }];
  assert.equal(pickInput(devs, [{ name: "MME" }], null), null);
});

test("external mic beats the built-in array even as default", () => {
  const apis = [{ name: "Windows WASAPI" }];
  const devs = [
    { name: "Microphone Array (Realtek(R) Audio)", max_input_channels: 2, default_samplerate: 48000, hostapi: 0 },
    { name: "Microphone (Samson Q9U)", max_input_channels: 1, default_samplerate: 48000, hostapi: 0 },
  ];
  assert.ok(pickInput(devs, apis, "Microphone Array (Realtek(R) Audio)", 48000)!.name!.includes("Q9U"));
});

test("built-in is used when it is the only input", () => {
  const devs = [{ name: "Microphone Array (Realtek)", max_input_channels: 2, default_samplerate: 48000, hostapi: 0 }];
  assert.notEqual(pickInput(devs, [{ name: "Windows WASAPI" }], null), null);
});

test("ASIO beats WASAPI for the same interface", () => {
  const apis = [{ name: "Windows WASAPI" }, { name: "ASIO" }];
  const devs = [
    { name: "X-USB", max_input_channels: 32, default_samplerate: 48000, hostapi: 0 },
    { name: "X-USB", max_input_channels: 32, default_samplerate: 48000, hostapi: 1 },
  ];
  assert.equal(pickInput(devs, apis, null, 48000)?.hostapi, "ASIO");
});

test("device list shows host API and only inputs", () => {
  const apis = [{ name: "MME" }, { name: "Windows WASAPI" }];
  const devs = [
    { name: "X-USB", max_input_channels: 32, default_samplerate: 48000, hostapi: 1 },
    { name: "Speakers", max_input_channels: 0, default_samplerate: 48000, hostapi: 0 },
    { name: "Q9U", max_input_channels: 1, default_samplerate: 44100, hostapi: 0 },
  ];
  const out = formatDeviceList(devs, apis);
  assert.ok(out.includes("[0] X-USB  (32 in, 48000 Hz, Windows WASAPI)"));
  assert.ok(out.includes("[2] Q9U  (1 in, 44100 Hz, MME)"));
  assert.ok(!out.includes("Speakers"));
  assert.ok(formatDeviceList([], []).includes("(none found)"));
});

test("listAudioDevices and autodetectInputs use the factory", () => {
  const f = new FakeFactory();
  f.apis = [{ name: "Windows WASAPI" }];
  f.devices = [
    { name: "A", max_input_channels: 2, default_samplerate: 48000, hostapi: 0 },
    { name: "B", max_input_channels: 1, default_samplerate: 48000, hostapi: 0 },
  ];
  f.defaultIndex = 1;
  assert.equal(
    listAudioDevices(f),
    "Input devices:\n  [0] A  (2 in, 48000 Hz, Windows WASAPI)\n  [1] B  (1 in, 48000 Hz, Windows WASAPI)",
  );
  assert.deepEqual(
    autodetectInputs(f, 48000).map((r) => r.index),
    [1, 0],
  );
  f.listError = new Error("no portaudio");
  assert.equal(listAudioDevices(f), "could not list audio devices: no portaudio");
  assert.deepEqual(autodetectInputs(f), []);
});

test("channel map parsing", () => {
  assert.deepEqual(
    [...parseChannelMap("1:0,2:1,8:9")],
    [
      [1, 0],
      [2, 1],
      [8, 9],
    ],
  );
  assert.deepEqual(
    [...parseChannelMap(" 1:0 , 2:1 ,")],
    [
      [1, 0],
      [2, 1],
    ],
  );
  for (const bad of ["", "8", "8:x", "0:0", "8:-1", "  "]) {
    assert.throws(() => parseChannelMap(bad), { name: "InvalidValueError" }, JSON.stringify(bad));
  }
});

test("ranking, picking, formatting and parsing match the recorded fixture", () => {
  const fx = fixture<any>("devices");
  assert.equal(fx.sample_rate, C.SAMPLE_RATE);
  for (const row of fx.lists) {
    assert.deepEqual(rankInputs(row.devs, row.apis, row.default, row.prefer), row.ranked);
    assert.deepEqual(pickInput(row.devs, row.apis, row.default, row.prefer), row.picked);
    assert.equal(formatDeviceList(row.devs, row.apis), row.formatted);
  }
  for (const m of fx.maps) {
    if ("ok" in m) {
      assert.deepEqual([...parseChannelMap(m.spec)], m.ok, JSON.stringify(m.spec));
    } else {
      assert.throws(() => parseChannelMap(m.spec), { name: "InvalidValueError", message: m.error }, JSON.stringify(m.spec));
    }
  }
});
