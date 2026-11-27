import assert from "node:assert/strict";
import test from "node:test";
import { Calibrator } from "../src/core/calibration.ts";
import type { CalibrationResult } from "../src/core/calibration.ts";
import { C, configWith, defaultConfig } from "../src/core/config.ts";
import type { Config } from "../src/core/config.ts";
import { SimConsole } from "../src/core/console.ts";

class BusEqRecorder extends SimConsole {
  calls: [number, number, number, number][] = [];
  override setBusEq(band: number, hz: number, gainDb: number, q: number = 4.0): void {
    this.calls.push([band, hz, gainDb, q]);
  }
}

const snapshot = (cfg: Config): string =>
  JSON.stringify({
    sr: cfg.SAMPLE_RATE,
    bands: cfg.BUS_EQ_BANDS,
    flatHz: cfg.EQ_FLAT_FREQ,
    flatQ: cfg.EQ_FLAT_Q,
    calibration: cfg.calibration,
  });

const injected = (): Config =>
  configWith({
    SAMPLE_RATE: 96000,
    BUS_EQ_BANDS: 2,
    EQ_FLAT_FREQ: 500,
    EQ_FLAT_Q: 1.5,
    calibration: Object.freeze({ ...defaultConfig().calibration, roomBands: 1, roomQ: 9, predipCount: 1, predipDb: -1, predipQ: 7 }),
  });

const result: CalibrationResult = {
  baseline: new Map(),
  corrections: [
    [100, -3],
    [200, -2],
  ],
  watchlist: [
    [100, 5],
    [300, 4.5],
    [400, 4.2],
  ],
};

test("the calibrator plans with the injected calibration settings", () => {
  const before = snapshot(C);
  const steps = new Calibrator(new SimConsole(), injected()).plan(result);
  assert.deepEqual(steps, [
    { band: 1, hz: 100, gain: -3, q: 9, kind: "room" },
    { band: 2, hz: 300, gain: -1, q: 7, kind: "predip", excess: 4.5 },
  ]);
  const defaults = new Calibrator(new SimConsole()).plan(result);
  assert.equal(defaults.length, 4);
  assert.equal(defaults[0]!.q, C.calibration.roomQ);
  assert.equal(snapshot(C), before);
});

test("the calibrator flattens the injected number of bus EQ bands at the injected flat point", () => {
  const before = snapshot(C);
  const con = new BusEqRecorder();
  const log: string[] = [];
  const used = new Calibrator(con, injected()).apply(result, (m) => log.push(m));
  assert.deepEqual(con.calls, [
    [1, 500, 0, 1.5],
    [2, 500, 0, 1.5],
    [1, 100, -3, 9],
    [2, 300, -1, 7],
  ]);
  assert.deepEqual([...used], [1, 2]);
  assert.equal(log.length, 2);
  assert.equal(snapshot(C), before);
});

test("the calibrator analyses at the injected sample rate", () => {
  const before = snapshot(C);
  const n = 48000;
  const tone = Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 48000));
  const loudest = (r: CalibrationResult): number => [...r.baseline.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  assert.equal(loudest(new Calibrator(new SimConsole()).analyze(tone)), 1000);
  assert.equal(loudest(new Calibrator(new SimConsole(), injected()).analyze(tone)), 2000);
  assert.ok(new Calibrator(new SimConsole()).analyze(tone).corrections.length > 0);
  const deaf = configWith({ calibration: Object.freeze({ ...defaultConfig().calibration, peakThreshDb: 1000 }) });
  assert.deepEqual(new Calibrator(new SimConsole(), deaf).analyze(tone).corrections, []);
  const fewBands = configWith({
    calibration: Object.freeze({ ...defaultConfig().calibration, octaveBands: Object.freeze([500, 1000, 2000]) }),
  });
  assert.deepEqual([...new Calibrator(new SimConsole(), fewBands).analyze(tone).baseline.keys()], [500, 1000, 2000]);
  assert.equal(snapshot(C), before);
});
