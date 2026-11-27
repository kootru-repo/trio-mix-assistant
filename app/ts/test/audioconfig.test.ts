import assert from "node:assert/strict";
import test from "node:test";
import { BlockAnalyser, analysisConfig, currentAnalysisConfig } from "../src/core/blockanalysis.ts";
import { SimCapture, simRoomCapture } from "../src/core/capture.ts";
import { CaptureHost, RemoteCapture } from "../src/core/capturelink.ts";
import type { FromCapture } from "../src/core/capturelink.ts";
import { ManualClock } from "../src/core/clock.ts";
import { C, configWith, defaultTuning } from "../src/core/config.ts";
import type { Config } from "../src/core/config.ts";
import { SimConsole } from "../src/core/console.ts";
import { DeviceCapture } from "../src/core/devicecapture.ts";
import { RollingRingDetector, analyseBlock, findResonantPeaks, findRingBin, octaveBandLevels, phaseRelation } from "../src/core/dsp.ts";
import { SeededRng } from "../src/core/rng.ts";
import { TimedAudioFactory, TimedAudioStream } from "../src/core/timedaudio.ts";
import { SystemClock } from "../src/host/clock.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const tone = (n: number, hz: number, sr: number, amp = 0.5): Float32Array => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr);
  return out;
};

const untouched = (run: () => void | Promise<void>): Promise<void> => {
  const before = structuredClone(C);
  return Promise.resolve(run()).then(() => assert.deepEqual(C, before, "the shared settings are not changed"));
};

const tuned = (over: Partial<Config>, feedback: Partial<Config["feedback"]> = {}, phase: Partial<Config["phase"]> = {}): Config => {
  const t = defaultTuning();
  return configWith({ ...over, feedback: { ...t.feedback, ...feedback }, phase: { ...t.phase, ...phase } });
};

test("dsp takes its ring threshold, FFT size, lag limit and octave bands as parameters", () =>
  untouched(() => {
    const db = new Float64Array(64).fill(-60);
    db[20] = -45;
    assert.equal(findRingBin(db), 20, "15 dB over the floor rings at the default 12 dB threshold");
    assert.equal(findRingBin(db, 20), null, "but not at an injected 20 dB threshold");
    const ring = tone(1024, 2500, 48000);
    assert.notEqual(analyseBlock(ring, 48000).fbFreq, null);
    assert.equal(analyseBlock(ring, 48000, { ringDb: 500 }).fbFreq, null);
    const det = new RollingRingDetector(512, 24000, 500);
    assert.equal(det.fftSize, 512);
    assert.equal(det.sampleRate, 24000);
    assert.deepEqual(det.update(ring), [null, 0], "the injected threshold is used");
    const [hz] = det.update(ring, 12);
    assert.ok(hz !== null && Math.abs(hz - 1250) < 30, `the injected sample rate sets the frequency: ${hz}`);
    const rng = new SeededRng(4);
    const a = Float32Array.from({ length: 2048 }, () => rng.standardNormal());
    const b = new Float32Array(2048);
    b.set(a.subarray(0, 2048 - 96), 96);
    assert.equal(phaseRelation(a, b, 48000).lagSamples, -96);
    assert.ok(Math.abs(phaseRelation(a, b, 48000, 1).lagSamples) <= 48, "an injected 1 ms lag limit caps the search");
    const noise = simRoomCapture(new SeededRng(3));
    assert.deepEqual([...octaveBandLevels(noise, 48000, [250, 2500]).keys()], [250, 2500]);
    const cal = { ...defaultTuning().calibration, peakThreshDb: 1000 };
    assert.deepEqual(findResonantPeaks(noise, 48000, null, cal).corrections, []);
    assert.ok(findResonantPeaks(noise, 48000).corrections.length > 0);
  }));

test("analysisConfig reads the given config, and the analyser uses its sample rate, ring threshold and lag limit", () =>
  untouched(() => {
    const cfg = tuned(
      {
        CHANNELS: new Map([
          [2, "lead_vox"],
          [5, "meas_mic"],
        ]),
        MEAS_MIC_CH: 5,
        PHASE_PAIRS: [[2, 5]],
        SAMPLE_RATE: 24000,
      },
      { ringDb: 7, detectFft: 2048 },
      { maxLagMs: 1.5 },
    );
    const got = analysisConfig(cfg);
    assert.deepEqual(got, {
      channels: [2, 5],
      measCh: 5,
      phasePairs: [[2, 5]],
      sampleRate: 24000,
      ringDb: 7,
      detectFft: 2048,
      maxLagMs: 1.5,
    });
    assert.deepEqual(currentAnalysisConfig(), analysisConfig(C));
    const ring = tone(4096, 2500, 48000);
    const fast = new BlockAnalyser().analyse(new Map([[5, ring]]), { ...got, sampleRate: 48000 });
    const slow = new BlockAnalyser().analyse(new Map([[5, ring]]), got);
    const f48 = fast.feats.get(5)!.fbFreq;
    const f24 = slow.feats.get(5)!.fbFreq;
    assert.ok(f48 !== null && Math.abs(f48 - 2500) < 30, String(f48));
    assert.ok(f24 !== null && Math.abs(f24 - 1250) < 30, `the ring detector follows the analysis sample rate: ${f24}`);
    const deaf = new BlockAnalyser().analyse(new Map([[5, ring]]), { ...got, ringDb: 500 });
    assert.equal(deaf.feats.get(5)!.fbFreq, null);
    const fallback = new BlockAnalyser(tuned({}, { ringDb: 500 })).analyse(new Map([[5, ring]]), {
      channels: [5],
      measCh: 5,
      phasePairs: [],
      sampleRate: 48000,
    });
    assert.equal(fallback.feats.get(5)!.fbFreq, null, "missing analysis fields come from the analyser's config");
  }));

test("SimCapture and the simulated room use the injected block size, sample rate, channels and room mic", () =>
  untouched(() => {
    const cfg = configWith({ BLOCK: 256, SAMPLE_RATE: 24000, CHANNELS: new Map([[3, "lead_vox"]]), MEAS_MIC_CH: 12 });
    const frame = new SimCapture(new SimConsole(), 7, null, cfg).block();
    assert.deepEqual(
      [...frame.keys()].sort((a, b) => a - b),
      [3, 12],
    );
    assert.ok([...frame.values()].every((x) => x.length === 256));
    const room = simRoomCapture(new SeededRng(1), cfg);
    assert.equal(room.length, cfg.calibration.durationS * 24000);
  }));

test("timed audio takes its sample rate, block and room-mic column from the injected config", () =>
  untouched(() => {
    const cfg = configWith({ SAMPLE_RATE: 44100, BLOCK: 128, MEAS_MIC_CH: 2 });
    const factory = new TimedAudioFactory(new SystemClock(), 64, cfg);
    assert.equal(factory.queryDevice().default_samplerate, 44100);
    const stream = new TimedAudioStream(() => undefined, 3, new SystemClock(), { cfg });
    assert.equal(stream.sampleRate, 44100);
    assert.equal(stream.blockSize, 128);
    const frame = stream.defaultContent(59);
    const col = (c: number): number => Math.max(...Array.from({ length: 128 }, (_, k) => Math.abs(frame[k * 3 + c]!)));
    assert.ok(col(1) > 0.3 && col(0) < 0.05 && col(2) < 0.05, `${col(0)} ${col(1)} ${col(2)}`);
  }));

test("DeviceCapture falls back to the injected config for rate, block, room mic and channel map", () =>
  untouched(() => {
    const cfg = configWith({
      SAMPLE_RATE: 44100,
      BLOCK: 512,
      MEAS_MIC_CH: 4,
      CHANNELS: new Map([
        [4, "meas_mic"],
        [2, "lead_vox"],
      ]),
    });
    const cap = new DeviceCapture({ factory: new TimedAudioFactory(new SystemClock()), clock: new ManualClock(0), cfg });
    assert.equal(cap.samplerate, 44100);
    assert.equal(cap.blocksize, 512);
    assert.equal(cap.measCh, 4);
    assert.deepEqual(
      [...cap.channelMap],
      [
        [2, 1],
        [4, 3],
      ],
    );
  }));

test("RemoteCapture builds what it sends the audio thread from its injected config", () =>
  untouched(() => {
    const cfg = tuned(
      {
        SAMPLE_RATE: 44100,
        BLOCK: 256,
        MEAS_MIC_CH: 3,
        CHANNELS: new Map([
          [1, "lead_vox"],
          [3, "meas_mic"],
        ]),
      },
      { ringDb: 9 },
    );
    const rc = new RemoteCapture({
      connect: () => {
        throw new Error("not used");
      },
      clock: new ManualClock(),
      stamp: () => 0,
      cfg,
    });
    const sent = rc.config();
    assert.deepEqual(sent.channelMap, [
      [1, 0],
      [3, 2],
    ]);
    assert.equal(sent.measCh, 3);
    assert.equal(sent.sampleRate, 44100);
    assert.equal(sent.block, 256);
    assert.deepEqual(sent.analysis, analysisConfig(cfg));
  }));

test("the capture host opens timed audio with its own config and never writes the shared settings", () =>
  untouched(async () => {
    const cfg = configWith({
      MEAS_MIC_CH: 2,
      CHANNELS: new Map([
        [1, "lead_vox"],
        [2, "meas_mic"],
      ]),
    });
    const clock = new SystemClock();
    const got: FromCapture[] = [];
    const host = new CaptureHost(
      new TimedAudioFactory(clock, 64, cfg),
      clock,
      (m) => got.push(m),
      () => Date.now(),
      cfg,
    );
    const analysis = analysisConfig(cfg);
    host.handle({
      type: "open",
      config: {
        device: null,
        outputDevice: null,
        channelMap: [
          [1, 0],
          [2, 1],
        ],
        measCh: 2,
        gainDb: 0,
        sampleRate: 48000,
        block: 1024,
        analysis,
        tuning: [],
      },
    });
    for (let i = 0; i < 100 && got.filter((m) => m.type === "block").length < 40; i++) await sleep(20);
    host.shutdown();
    const blocks = got.flatMap((m) => (m.type === "block" ? [m.block] : []));
    assert.ok(got.some((m) => m.type === "opened"));
    assert.ok(blocks.length >= 40, String(blocks.length));
    const last = blocks.at(-1)!;
    assert.ok(last.feats.get(2)!.rmsDbfs > last.feats.get(1)!.rmsDbfs + 6, "the test tone is on the injected room-mic column");
  }));
