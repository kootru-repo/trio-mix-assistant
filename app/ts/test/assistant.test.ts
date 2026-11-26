import assert from "node:assert/strict";
import test from "node:test";
import { Calibrator } from "../src/core/calibration.ts";
import type { CalibrationResult } from "../src/core/calibration.ts";
import { ManualClock } from "../src/core/clock.ts";
import { applyChannelMap, autoChannelMap, C, channelMapState, restoreChannelMapState } from "../src/core/config.ts";
import type { ChannelMapSpec } from "../src/core/config.ts";
import { SimConsole } from "../src/core/console.ts";
import type { ChannelFeatures } from "../src/core/dsp.ts";
import { MixAssistant } from "../src/core/assistant/index.ts";
import type { AssistantEvent } from "../src/core/assistant/index.ts";
import { fixture } from "./helpers.ts";

interface Scenario {
  name: string;
  config: ChannelMapSpec | null;
  ops: any[];
  events: AssistantEvent[];
  snapshots: any[];
  errors: string[];
  state: any;
}

const scenarios = fixture<Scenario[]>("assistant");

function sameValue(actual: unknown, expected: unknown, path: string): void {
  if (typeof expected === "number" && typeof actual === "number") {
    const tol = Math.max(1e-9, Math.abs(expected) * 1e-9);
    assert.ok(Math.abs(actual - expected) <= tol, `${path}: expected ${expected}, got ${actual}`);
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected an array`);
    assert.equal(actual.length, expected.length, `${path}: length`);
    expected.forEach((e, i) => sameValue(actual[i], e, `${path}[${i}]`));
  } else if (expected !== null && typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object", `${path}: expected an object`);
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    assert.deepEqual(Object.keys(a).sort(), Object.keys(e).sort(), `${path}: keys`);
    for (const k of Object.keys(e)) sameValue(a[k], e[k], `${path}.${k}`);
  } else {
    assert.equal(actual, expected, path);
  }
}

const obj = <T>(m: Map<number, T>): Record<string, T> => Object.fromEntries([...m].map(([k, v]) => [String(k), v]));

class Replay {
  clock = new ManualClock(0, 1_700_000_000);
  con = new SimConsole();
  events: AssistantEvent[] = [];
  a: MixAssistant;
  snapshots: unknown[] = [];
  errors: string[] = [];
  private saved = channelMapState();

  constructor(cfg: ChannelMapSpec | null) {
    if (cfg) applyChannelMap(cfg);
    this.a = new MixAssistant(this.con, this.clock, { onEvent: (e) => this.events.push(e) });
  }

  close(): void {
    restoreChannelMapState(this.saved);
  }

  private sync(now: number | undefined): void {
    if (now !== undefined && now > this.clock.monotonic()) this.clock.advance(now - this.clock.monotonic());
  }

  private result(op: any, kind: "calib" | "plan") {
    const res: CalibrationResult = {
      baseline: new Map(),
      corrections: op.corrections.map((x: number[]) => [x[0]!, x[1]!]),
      watchlist: op.watch.map((x: number[]) => [x[0]!, x[1]!]),
    };
    return kind === "calib" ? res : new Calibrator(this.con).plan(res);
  }

  run(op: any): void {
    this.sync(op.now);
    const a = this.a;
    switch (op.op) {
      case "feat": {
        const f: ChannelFeatures = {
          rmsDbfs: op.rms,
          peakDbfs: op.peak,
          fbFreq: op.fb,
          contrastDb: op.contrast,
          harmonicity: op.harm,
          spectrum: new Float64Array(0),
        };
        a.onFeatures(op.ch, f, op.now);
        break;
      }
      case "phase":
        a.handlePhase(op.a, op.b, { zeroCorr: op.zero, bestCorr: op.best, lagSamples: 0, lagMs: op.lag_ms }, op.now);
        break;
      case "coach":
        a.setCoachMode(op.on);
        break;
      case "enable":
        a.enabled[op.job] = op.on;
        break;
      case "capture_balance":
        a.captureBalance(new Map(Object.entries(op.levels).map(([k, v]) => [Number(k), v as number])));
        break;
      case "manual":
        a.noteManual(op.ch, op.now);
        break;
      case "lead_target":
        a.leadTarget = op.v;
        break;
      case "calib":
        a.setCalibration(this.result(op, "calib") as CalibrationResult);
        break;
      case "calib_plan":
        a.coachCalibration(this.result(op, "plan") as ReturnType<Calibrator["plan"]>);
        break;
      case "cal_bus_bands":
        a.calBusBands = new Set(op.bands);
        break;
      case "reset_notches":
        a.resetNotches();
        break;
      case "release_unmask":
        a.releaseUnmask();
        break;
      case "coach_snapshot":
        this.snapshots.push(a.coachSnapshot(op.now));
        break;
      default:
        throw new Error(op.op);
    }
  }

  state() {
    const a = this.a;
    const c = this.con;
    return {
      enabled: a.enabled,
      fader_db: obj(a.faderDb),
      gain_db: obj(a.gainDb),
      used_notch_band: obj(a.usedNotchBand),
      fb_bus_bands: a.fbBusBands,
      used_bus_notch_band: a.usedBusNotchBand,
      in_ema: obj(a.inEma),
      balance_targets: obj(a.balanceTargets),
      polarity: obj(a.polarity),
      phase_status: Object.fromEntries(a.phaseStatus),
      duck_gain: a.duckGain,
      duck_applied: obj(a.duckApplied),
      vox_level_ema: a.voxLevelEma,
      room: [a.roomLevelDb, a.roomContrastDb, a.roomConfidence],
      stage_baseline: a.stageBaseline,
      lead_target: a.leadTarget,
      coach_recs: [...a.coachRecs.values()]
        .map((r) => [r.kind, r.ch])
        .sort((x, y) => (x[0]! < y[0]! ? -1 : x[0]! > y[0]! ? 1 : (x[1] as number ?? -1) - ((y[1] as number) ?? -1))),
      wire: c.wireLog.map(([addr, ...args]) => [addr, ...args.map((g) => g.v)]),
      console: {
        fader_db: obj(c.faderDb),
        gain_db: obj(c.gainDb),
        notches: Object.fromEntries(
          [...c.notches].map(([k, v]) => [String(k), v.map((n) => ({ band: n.band, hz: n.hz, gain_db: n.gainDb, q: n.q }))]),
        ),
        bus_eq: Object.fromEntries([...c.busEq].map(([k, v]) => [String(k), { hz: v.hz, gain_db: v.gainDb, q: v.q }])),
        eq_bands: Object.fromEntries(
          [...c.eqBands].map(([k, v]) => [
            String(k),
            Object.fromEntries([...v].map(([b, d]) => [String(b), { hz: d.hz, gain_db: d.gainDb, q: d.q, on: d.on }])),
          ]),
        ),
        polarity: obj(c.polarity),
      },
    };
  }
}

for (const sc of scenarios) {
  test(`assistant scenario "${sc.name}" makes the same decisions as the stored reference`, () => {
    const r = new Replay(sc.config);
    try {
      for (const op of sc.ops) {
        try {
          r.run(op);
        } catch (e) {
          const m = /unknown channel (\d+)/.exec(String((e as Error).message));
          if (!m) throw e;
          r.errors.push(`UnknownChannel:${m[1]}`);
        }
      }
      assert.deepEqual(r.errors, sc.errors);
      sameValue(r.events, sc.events, "events");
      sameValue(r.snapshots, sc.snapshots, "coach snapshots");
      sameValue(r.state(), sc.state, "state");
    } finally {
      r.close();
    }
  });
}

test("the scenarios exercise every job", () => {
  const kinds = new Set(scenarios.flatMap((s) => s.events.map((e) => e.kind)));
  for (const k of ["feedback", "clip", "vocal", "balance", "phase", "unmask", "coach", "system"]) {
    assert.ok(kinds.has(k), `no ${k} events recorded`);
  }
});

function fresh(): { a: MixAssistant; con: SimConsole; clock: ManualClock; events: AssistantEvent[] } {
  const clock = new ManualClock(0, 1_700_000_000);
  const con = new SimConsole();
  const events: AssistantEvent[] = [];
  const a = new MixAssistant(con, clock, { onEvent: (e) => events.push(e) });
  return { a, con, clock, events };
}

const feat = (over: Partial<ChannelFeatures>): ChannelFeatures => ({
  rmsDbfs: -30,
  peakDbfs: -20,
  fbFreq: null,
  contrastDb: 0,
  harmonicity: 0,
  spectrum: new Float64Array(0),
  ...over,
});

test("a ride never starts from a believed fader outside the authority range", () => {
  const { a, con } = fresh();
  a.enabled["vocal_ride"] = true;
  a.faderDb.set(1, -40);
  for (let i = 0; i < 20; i++) a.onFeatures(1, feat({ rmsDbfs: -10 }), 10 + i);
  assert.equal(con.wireLog.length, 0);
  assert.equal(a.faderDb.get(1), -40);
  const coach = fresh();
  coach.a.setCoachMode(true);
  coach.a.enabled["vocal_ride"] = true;
  coach.a.faderDb.set(1, 30);
  for (let i = 0; i < 20; i++) coach.a.onFeatures(1, feat({ rmsDbfs: -60 }), 10 + i);
  assert.equal(coach.a.coachRecs.size, 0);
});

test("a clip trim waits out its cooldown instead of firing on every block", () => {
  const { a, con } = fresh();
  const hot = feat({ peakDbfs: -0.2 });
  for (let i = 0; i < 6; i++) a.onFeatures(2, hot, 5 + i * 0.021);
  assert.equal(con.wireLog.filter(([addr]) => addr.startsWith("/headamp")).length, 1);
  assert.equal(a.gainDb.get(2), 18);
  a.onFeatures(2, hot, 5.3);
  assert.equal(a.gainDb.get(2), 16);
});

test("with every main-bus band claimed a room feedback notch overwrites nothing", () => {
  const { a, con, events } = fresh();
  a.calBusBands = new Set([1, 2, 3, 4, 5, 6]);
  for (let i = 0; i < 12; i++) a.onFeatures(8, feat({ rmsDbfs: -40 + i, fbFreq: 1000, contrastDb: 30 }), 10 + i * 0.02);
  assert.equal(con.wireLog.length, 0);
  assert.ok(events.some((e) => e.msg.includes("no free main-bus band")));
  assert.equal(a.allocBusBand(), -1);
});

test("a steady constant tone with no harmonics is deliberately not notched", () => {
  const { a, con } = fresh();
  for (let i = 0; i < 200; i++) a.onFeatures(4, feat({ rmsDbfs: -30, fbFreq: 880, contrastDb: 30 }), 10 + i * 0.021);
  assert.equal(con.notchFreqs(4).length, 0);
});

test("a channel map that drops the lead or measurement channel falls back to a channel that exists", () => {
  const saved = channelMapState();
  try {
    applyChannelMap({ map: { "3": "a", "5": "b", "9": "c" } });
    assert.equal(C.LEAD_VOCAL_CH, 3);
    assert.equal(C.MEAS_MIC_CH, 9);
    const auto = autoChannelMap(4);
    assert.equal(auto.lead, 1);
    assert.equal(auto.meas_mic, 4);
    assert.equal(C.LEAD_VOCAL_CH, 1);
    assert.equal(C.MEAS_MIC_CH, 4);
  } finally {
    restoreChannelMapState(saved);
  }
});
