import assert from "node:assert/strict";
import test from "node:test";
import { MixAssistant } from "../src/core/assistant/core.ts";
import type { AssistantEvent } from "../src/core/assistant/base.ts";
import type { CalibrationResult } from "../src/core/calibration.ts";
import { ManualClock } from "../src/core/clock.ts";
import { applyChannelMap, autoChannelMap, channelMapState, configWith, defaultConfig, restoreChannelMapState } from "../src/core/config.ts";
import type { Config } from "../src/core/config.ts";
import type { ChannelFeatures, PhaseRelation } from "../src/core/dsp.ts";
import { NEG_INF } from "../src/core/util.ts";
import { RecordingMixer, feat, tuned } from "./jobhelpers.ts";

const testCfg = defaultConfig();

const ON_TEXT =
  "coach mode ON — the assistant advises every automatic move (mix corrections, scene recall, guest mutes) instead of applying it; only your own manual moves act";

const smallConfig = (): Config =>
  configWith({
    CHANNELS: new Map([
      [3, "lead_vox"],
      [5, "stage_mic"],
      [9, "meas_mic"],
    ]),
    LEAD_VOCAL_CH: 3,
    MEAS_MIC_CH: 9,
    STAGE_MIC_CH: 5,
    BALANCE_CHANNELS: [5],
  });

interface Rig {
  a: MixAssistant;
  mixer: RecordingMixer;
  clock: ManualClock;
  events: AssistantEvent[];
  latency: [string, number][];
}

function rig(config: Config = smallConfig()): Rig {
  const mixer = new RecordingMixer();
  const clock = new ManualClock(0, 1_700_000_000);
  const events: AssistantEvent[] = [];
  const latency: [string, number][] = [];
  const a = new MixAssistant(mixer, clock, {
    onEvent: (ev) => events.push(ev),
    onLatency: (kind, s) => latency.push([kind, s]),
    config,
  });
  return { a, mixer, clock, events, latency };
}

function traceRouting(a: MixAssistant): string[] {
  const order: string[] = [];
  a.room.update = (_f: ChannelFeatures, now: number) => order.push(`room@${now}`);
  a.stage.handle = (_f: ChannelFeatures, now: number) => order.push(`stage@${now}`);
  a.feedback.handle = (ch: number) => order.push(`feedback:${ch}`);
  a.clip.handle = (ch: number, _f: ChannelFeatures, now: number) => order.push(`clip:${ch}@${now}`);
  a.ride.handleVocal = (_f: ChannelFeatures, now: number) => order.push(`vocal@${now}`);
  a.unmask.handle = (_f: ChannelFeatures, now: number) => order.push(`unmask@${now}`);
  a.ride.handleBalance = (ch: number, _f: ChannelFeatures, now: number) => order.push(`balance:${ch}@${now}`);
  return order;
}

const keys = (m: Map<number, unknown>): number[] => [...m.keys()];

const rel = (over: Partial<PhaseRelation> = {}): PhaseRelation => ({ zeroCorr: 0, bestCorr: 0, lagSamples: 0, lagMs: 0, ...over });

test("an assistant uses the config it is given, by reference", () => {
  const a = new MixAssistant(new RecordingMixer(), new ManualClock(), { config: testCfg });
  assert.equal(a.cfg, testCfg);
  assert.equal(a.onEvent, null);
  assert.equal(a.onLatency, null);
  assert.deepEqual(keys(a.faderDb), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("an assistant with no handlers drops events and latency quietly", () => {
  const a = new MixAssistant(new RecordingMixer(), new ManualClock(), { config: testCfg });
  a.emit("system", "hello", 1);
  a.noteLatency("clip");
  a.setCoachMode(true);
  assert.equal(a.coachMode, true);
});

test("an injected config is used by reference and every per-channel map holds exactly its channels", () => {
  const chansBefore = testCfg.CHANNELS;
  const labelsBefore = testCfg.ROLE_LABELS;
  const stateBefore = channelMapState(testCfg);
  const cfg = smallConfig();
  const { a } = rig(cfg);
  assert.equal(a.cfg, cfg);
  assert.equal(a.state.enabled !== cfg.DEFAULT_ENABLED, true);
  const maps: Map<number, unknown>[] = [
    a.faderDb,
    a.gainDb,
    a.nominalGain,
    a.lastMoveT,
    a.manualHoldUntil,
    a.fbStreak,
    a.fbLastLevel,
    a.usedNotchBand,
    a.feedback.fbLastFreq,
    a.inEma,
    a.ride.lastRideT,
    a.clip.lastClipT,
    a.clip.lastRecoverT,
    a.polarity,
  ];
  for (const m of maps) assert.deepEqual(keys(m), [3, 5, 9]);
  assert.equal(testCfg.CHANNELS, chansBefore);
  assert.equal(testCfg.ROLE_LABELS, labelsBefore);
  assert.deepEqual(channelMapState(testCfg), stateBefore);
});

test("the measurement mic updates the room model and then feedback and nothing else", () => {
  const { a } = rig();
  const order = traceRouting(a);
  a.onFeatures(9, feat(), 1);
  assert.deepEqual(order, ["room@1", "feedback:9"]);
});

test("the stage mic goes only to the stage job even when it is also a balance channel", () => {
  const { a } = rig();
  const order = traceRouting(a);
  a.onFeatures(5, feat(), 2);
  assert.deepEqual(order, ["stage@2"]);
});

test("the lead vocal goes to feedback, clip, vocal ride and unmask in that order", () => {
  const { a } = rig();
  const order = traceRouting(a);
  a.onFeatures(3, feat(), 3);
  assert.deepEqual(order, ["feedback:3", "clip:3@3", "vocal@3", "unmask@3"]);
});

test("a plain channel goes to feedback and clip only when there is no stage mic", () => {
  const { a } = rig(configWith());
  const order = traceRouting(a);
  a.onFeatures(2, feat(), 4);
  assert.deepEqual(order, ["feedback:2", "clip:2@4"]);
});

test("a balance channel goes to feedback, clip and then balance", () => {
  const { a } = rig(configWith());
  const order = traceRouting(a);
  a.onFeatures(7, feat(), 5);
  assert.deepEqual(order, ["feedback:7", "clip:7@5", "balance:7@5"]);
});

test("a lead vocal that is also a balance channel is ridden as vocal and as balance", () => {
  const { a } = rig(configWith({ BALANCE_CHANNELS: [1] }));
  const order = traceRouting(a);
  a.onFeatures(1, feat(), 6);
  assert.deepEqual(order, ["feedback:1", "clip:1@6", "vocal@6", "unmask@6", "balance:1@6"]);
});

test("when the measurement mic is also the lead vocal it is only treated as the measurement mic", () => {
  const cfg = configWith();
  autoChannelMap(1, cfg);
  const { a } = rig(cfg);
  const order = traceRouting(a);
  a.onFeatures(1, feat(), 7);
  assert.deepEqual(order, ["room@7", "feedback:1"]);
});

test("routing by an injected config has real effects on the configured channels only", () => {
  const { a, mixer, events, latency } = rig();
  a.onFeatures(9, feat({ rmsDbfs: -30, peakDbfs: 0 }), 0);
  assert.ok(Math.abs(a.roomLevelDb - -85) < 1e-9);
  assert.equal(a.fbLastLevel.get(9), -30);
  a.onFeatures(5, feat({ rmsDbfs: -40, peakDbfs: 0 }), 0);
  assert.equal(a.stageBaseline, -40);
  assert.equal(a.fbLastLevel.get(5), -90);
  assert.deepEqual(mixer.calls, []);
  a.onFeatures(3, feat({ peakDbfs: 0 }), 0);
  assert.deepEqual(mixer.calls, [{ op: "gain", ch: 3, currentDb: 20, deltaDb: -2 }]);
  assert.deepEqual(events, [{ time: "22:13:20", kind: "clip", ch: 3, role: "lead_vox", msg: "lead_vox near clip → preamp -2 dB → 18 dB" }]);
  assert.deepEqual(latency, [["clip", 0]]);
});

test("the lead vocal of an injected config is ridden and feeds the unmask level", () => {
  const { a, mixer } = rig();
  a.enabled["vocal_ride"] = true;
  a.enabled["unmask"] = true;
  a.onFeatures(3, feat({ rmsDbfs: -30 }), 0);
  assert.deepEqual(mixer.calls, [{ op: "ramp", ch: 3, startDb: 0, endDb: 1 }]);
  assert.equal(a.faderDb.get(3), 1);
  assert.equal(a.voxLevelEma, -30);
  assert.equal(a.cfg.DEFAULT_ENABLED["vocal_ride"], false);
  assert.equal(a.cfg.DEFAULT_ENABLED["unmask"], false);
});

test("a balance channel with a captured target is ridden toward it", () => {
  const { a, mixer, events } = rig(configWith());
  a.enabled["balance"] = true;
  a.captureBalance(new Map([[5, -20]]));
  assert.deepEqual([...a.balanceTargets], [[5, -20]]);
  assert.equal(a.balanceTargets, a.ride.balanceTargets);
  assert.equal(events[0]?.msg, "captured balance targets: bass_di -20.0");
  a.onFeatures(5, feat({ rmsDbfs: -30 }), 0);
  assert.deepEqual(mixer.calls, [{ op: "ramp", ch: 5, startDb: 0, endDb: 1 }]);
});

test("a channel outside the injected config is rejected as unknown", () => {
  const { a } = rig();
  assert.throws(() => a.onFeatures(1, feat(), 0), { message: "unknown channel 1" });
});

test("two assistants with different configs in one test do not interfere", () => {
  const one = rig();
  const two = rig(configWith());
  one.a.onFeatures(5, feat({ rmsDbfs: -40, peakDbfs: 0 }), 0);
  two.a.onFeatures(5, feat({ rmsDbfs: -40, peakDbfs: 0 }), 0);
  assert.equal(one.a.stageBaseline, -40);
  assert.equal(two.a.stageBaseline, null);
  assert.deepEqual(one.mixer.calls, []);
  assert.deepEqual(two.mixer.calls, [{ op: "gain", ch: 5, currentDb: 20, deltaDb: -2 }]);
  assert.deepEqual(
    two.events.map((e) => e.role),
    ["bass_di"],
  );
  assert.equal(one.events.length, 0);
  one.a.leadTarget = -2;
  assert.equal(two.a.leadTarget, -6);
  one.a.setCoachMode(true);
  assert.equal(two.a.coachMode, false);
  assert.throws(() => two.a.onFeatures(9, feat(), 0), { message: "unknown channel 9" });
  assert.throws(() => one.a.onFeatures(8, feat(), 0), { message: "unknown channel 8" });
  assert.deepEqual(keys(one.a.gainDb), [3, 5, 9]);
  assert.deepEqual(keys(two.a.gainDb), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("emit sends the clock time, kind, channel, role and message", () => {
  const { a, clock, events } = rig();
  clock.advance(61);
  a.emit("system", "hi", 9);
  a.emit("system", "none");
  a.emit("system", "unknown", 4);
  assert.deepEqual(events, [
    { time: "22:14:21", kind: "system", ch: 9, role: "meas_mic", msg: "hi" },
    { time: "22:14:21", kind: "system", ch: null, role: null, msg: "none" },
    { time: "22:14:21", kind: "system", ch: 4, role: null, msg: "unknown" },
  ]);
});

test("noteLatency reports the seconds since the block started", () => {
  const { a, clock, latency } = rig();
  clock.advance(4);
  a.blockT0 = 1.5;
  a.noteLatency("feedback");
  clock.highResolution = () => 7;
  a.noteLatency("clip");
  assert.deepEqual(latency, [
    ["feedback", 2.5],
    ["clip", 5.5],
  ]);
});

test("the coach inside the facade uses the injected config and clock", () => {
  const cfg = configWith({ ...smallConfig(), ...tuned("coach", { ttlS: 2 }) });
  const { a, clock } = rig(cfg);
  assert.equal(a.coach.cfg, cfg);
  assert.equal(a.coach.clock, clock);
  a.recommend("clip", 5, "x");
  assert.equal(a.coachRecs.get("clip|5")?.role, "stage_mic");
  assert.equal(a.coachSnapshot(2).length, 1);
  assert.equal(a.coachSnapshot(2.5).length, 0);
});

test("the job context passes emit, recommend, latency and coaching through to the facade", () => {
  const { a, events, latency } = rig();
  const ctx = a.feedback.ctx;
  assert.equal(ctx.cfg, a.cfg);
  assert.equal(ctx.mixer, a.con);
  assert.equal(ctx.state, a.state);
  assert.equal(ctx.coaching(), false);
  a.setCoachMode(true);
  assert.equal(ctx.coaching(), true);
  ctx.emit("note", "plain");
  ctx.emit("note", "chan", 3);
  ctx.recommend("tip", 5, "short");
  ctx.recommend("tip", 9, "long", true, { x: 1 });
  ctx.noteLatency("k");
  assert.deepEqual(events.slice(1), [
    { time: "22:13:20", kind: "note", ch: null, role: null, msg: "plain" },
    { time: "22:13:20", kind: "note", ch: 3, role: "lead_vox", msg: "chan" },
    { time: "22:13:20", kind: "coach", ch: 5, role: "stage_mic", msg: "short" },
    { time: "22:13:20", kind: "coach", ch: 9, role: "meas_mic", msg: "long" },
  ]);
  assert.equal(a.coachRecs.get("tip|5")?.persist, false);
  assert.deepEqual(Object.keys(a.coachRecs.get("tip|5") ?? {}).length, 8);
  assert.equal(a.coachRecs.get("tip|9")?.persist, true);
  assert.equal(a.coachRecs.get("tip|9")?.["x"], 1);
  assert.deepEqual(latency, [["k", 0]]);
  ctx.recommend("tip", 5, "keyed", false, {}, "tip|own");
  assert.equal(a.coachRecs.get("tip|own")?.text, "keyed");
  assert.equal(a.coachRecs.get("tip|5")?.text, "short");
});

test("in coach mode a clip on the lead vocal is advised instead of applied", () => {
  const { a, mixer, events } = rig();
  a.setCoachMode(true);
  a.onFeatures(3, feat({ peakDbfs: 0 }), 0);
  assert.deepEqual(mixer.calls, []);
  assert.equal(a.coachRecs.get("clip|3")?.text, "lead_vox near clip → trim its preamp/gain -2 dB.");
  assert.equal(events.at(-1)?.kind, "coach");
});

test("setCoachMode does nothing when the mode is unchanged", () => {
  const { a, events, mixer } = rig();
  a.unmask.duckApplied.set(3, -2);
  a.setCoachMode(false);
  assert.deepEqual(events, []);
  assert.deepEqual(mixer.calls, []);
  assert.equal(a.unmask.duckApplied.size, 1);
  a.setCoachMode(true);
  a.recommend("clip", 3, "keep");
  a.setCoachMode(true);
  assert.equal(events.length, 2);
  assert.equal(a.coachRecs.size, 1);
});

test("turning coach mode on releases the unmask dips and announces it", () => {
  const { a, events, mixer } = rig();
  a.unmask.duckApplied.set(5, -2);
  a.unmask.duckGain = -2;
  a.recommend("clip", 3, "keep");
  a.setCoachMode(true);
  assert.equal(a.coachMode, true);
  assert.deepEqual(mixer.calls, [{ op: "eqBand", ch: 5, band: 4, hz: 3000, gainDb: 0, q: 1.2, on: true }]);
  assert.equal(a.duckApplied.size, 0);
  assert.equal(a.duckGain, 0);
  assert.equal(a.coachRecs.size, 1);
  assert.deepEqual(events.at(-1), { time: "22:13:20", kind: "system", ch: null, role: null, msg: ON_TEXT });
});

test("turning coach mode off clears the advice and announces it", () => {
  const { a, events, mixer } = rig();
  a.setCoachMode(true);
  a.recommend("clip", 3, "a");
  a.unmask.duckApplied.set(5, -2);
  a.setCoachMode(false);
  assert.equal(a.coachMode, false);
  assert.equal(a.coachRecs.size, 0);
  assert.equal(a.coach.coachLastText.size, 0);
  assert.deepEqual(mixer.calls, []);
  assert.deepEqual(events.at(-1), { time: "22:13:20", kind: "system", ch: null, role: null, msg: "coach mode off" });
});

test("setCalibration stores the result and hands its watch list to feedback", () => {
  const { a } = rig();
  const calib: CalibrationResult = {
    baseline: new Map(),
    corrections: [[250, -3]],
    watchlist: [
      [2000, 5],
      [4000, 4],
    ],
  };
  a.setCalibration(calib);
  assert.equal(a.calib, calib);
  assert.deepEqual(a.feedback.watchFreqs, [2000, 4000]);
  a.setCalibration(null);
  assert.equal(a.calib, null);
  assert.deepEqual(a.feedback.watchFreqs, []);
});

test("noteManual holds a channel for the configured manual hold by default", () => {
  const { a } = rig();
  a.noteManual(3, 10);
  assert.equal(a.manualHoldUntil.get(3), 15);
  a.noteManual(5, 10, 1.5);
  assert.equal(a.manualHoldUntil.get(5), 11.5);
  const other = rig(configWith({ ...smallConfig(), ...tuned("manual", { holdS: 2 }) }));
  other.a.noteManual(9, 10);
  assert.equal(other.a.manualHoldUntil.get(9), 12);
});

test("noteManual ignores a channel outside the config", () => {
  const { a } = rig();
  a.noteManual(99, 0);
  a.noteManual(1, 0, 3);
  assert.deepEqual(
    [...a.manualHoldUntil],
    [
      [3, NEG_INF],
      [5, NEG_INF],
      [9, NEG_INF],
    ],
  );
});

test("a manual hold stops the vocal ride on that channel", () => {
  const { a, mixer } = rig();
  a.enabled["vocal_ride"] = true;
  a.noteManual(3, 0);
  a.onFeatures(3, feat({ rmsDbfs: -30 }), 1);
  assert.deepEqual(mixer.calls, []);
});

test("recommend, coachSnapshot and coachCalibration delegate to the coach", () => {
  const { a, clock } = rig();
  a.recommend("clip", 3, "a");
  a.recommend("phase", 5, "b", true, { pair: [5, 9] });
  assert.equal(a.coachRecs, a.coach.coachRecs);
  assert.deepEqual(a.coachRecs.get("phase|5")?.["pair"], [5, 9]);
  clock.advance(9);
  assert.deepEqual(
    a.coachSnapshot(0).map((r) => r.text),
    ["b", "a"],
  );
  assert.deepEqual(
    a.coachSnapshot().map((r) => r.text),
    ["b"],
  );
  a.coachCalibration([]);
  assert.equal(a.coachRecs.get("calibration|")?.text, "Room measured — no problem peaks; leave the main bus flat.");
  a.coachCalibration([{ band: 2, hz: 500, gain: -2, q: 6, kind: "predip" }]);
  assert.equal(a.coachRecs.get("calibration|")?.text, "Room calibration → set MAIN-BUS PEQ: band 2 500 Hz -2.0 dB (Q 6) pre-dip.");
});

test("handlePhase and captureBalance pass their arguments to the owning job", () => {
  const { a } = rig();
  const seen: unknown[] = [];
  a.phase.handle = (x: number, y: number, r: PhaseRelation, now: number) => seen.push(["phase", x, y, r.zeroCorr, now]);
  a.ride.captureBalance = (levels: Map<number, number>) => seen.push(["balance", [...levels]]);
  a.handlePhase(3, 9, rel({ zeroCorr: 0.5 }), 7);
  a.captureBalance(new Map([[5, -12]]));
  assert.deepEqual(seen, [
    ["phase", 3, 9, 0.5, 7],
    ["balance", [[5, -12]]],
  ]);
});

test("phase advice in coach mode is kept per pair and only a reading on that pair forgets it", () => {
  const { a } = rig();
  a.enabled["phase"] = true;
  a.setCoachMode(true);
  a.handlePhase(3, 5, rel({ zeroCorr: 0.9, bestCorr: 0.9, lagMs: 1 }), 0);
  assert.equal(a.phaseStatus.get("3,5")?.status, "comb");
  assert.deepEqual([...a.coachRecs.keys()], ["phase|3,5"]);
  assert.equal(a.coachRecs.get("phase|3,5")?.ch, 3);
  assert.deepEqual(a.coachRecs.get("phase|3,5")?.["pair"], [3, 5]);
  a.handlePhase(3, 9, rel(), 0);
  assert.equal(a.phaseStatus.get("3,9")?.status, "unrelated");
  assert.equal(a.phaseStatus.get("3,5")?.status, "comb");
  assert.equal(a.coachRecs.has("phase|3,5"), true);
  assert.equal(a.coach.coachLastText.has("phase|3,5"), true);
  for (let i = 0; i < 40; i++) a.handlePhase(3, 5, rel(), i);
  assert.equal(a.phaseStatus.get("3,5")?.status, "unrelated");
  assert.equal(a.coachRecs.has("phase|3,5"), false);
  assert.equal(a.coach.coachLastText.has("phase|3,5"), false);
});

test("resetNotches, releaseUnmask and allocBusBand act through the owning jobs", () => {
  const { a, mixer, events } = rig();
  a.usedNotchBand.set(3, 2);
  a.fbBusBands = [1];
  a.usedBusNotchBand = 1;
  a.resetNotches();
  assert.deepEqual(mixer.calls, [
    { op: "clearEq", ch: 3 },
    { op: "busEq", band: 1, hz: 1000, gainDb: 0, q: 2 },
  ]);
  assert.equal(events.at(-1)?.msg, "cleared 2 parked notch(es)");
  assert.deepEqual(a.fbBusBands, []);
  assert.equal(a.usedBusNotchBand, 0);
  mixer.calls = [];
  a.unmask.duckApplied.set(9, -1);
  a.releaseUnmask();
  assert.deepEqual(mixer.calls, [{ op: "eqBand", ch: 9, band: 4, hz: 3000, gainDb: 0, q: 1.2, on: true }]);
  assert.equal(a.allocBusBand(), 1);
  a.calBusBands = new Set([1, 2]);
  assert.equal(a.allocBusBand(), 3);
});

test("the map and object getters return the owning job's live objects", () => {
  const { a } = rig();
  assert.equal(a.coachRecs, a.coach.coachRecs);
  assert.equal(a.enabled, a.state.enabled);
  assert.equal(a.faderDb, a.state.faderDb);
  assert.equal(a.gainDb, a.state.gainDb);
  assert.equal(a.nominalGain, a.state.nominalGain);
  assert.equal(a.lastMoveT, a.state.lastMoveT);
  assert.equal(a.manualHoldUntil, a.state.manualHoldUntil);
  assert.equal(a.inEma, a.ride.inEma);
  assert.equal(a.balanceTargets, a.ride.balanceTargets);
  assert.equal(a.fbStreak, a.feedback.fbStreak);
  assert.equal(a.fbLastLevel, a.feedback.fbLastLevel);
  assert.equal(a.usedNotchBand, a.feedback.usedNotchBand);
  assert.equal(a.polarity, a.phase.polarity);
  assert.equal(a.phaseStatus, a.phase.phaseStatus);
  assert.equal(a.duckApplied, a.unmask.duckApplied);
  assert.equal(a.lastMoveT.get(3), NEG_INF);
});

test("the value getters read the current value from the owning job", () => {
  const { a } = rig();
  assert.equal(a.roomConfidence, 1);
  a.state.roomConfidence = 0.4;
  assert.equal(a.roomConfidence, 0.4);
  assert.equal(a.roomLevelDb, -90);
  a.room.roomLevelDb = -20;
  assert.equal(a.roomLevelDb, -20);
  assert.equal(a.roomContrastDb, 0);
  a.room.roomContrastDb = 7;
  assert.equal(a.roomContrastDb, 7);
  assert.equal(a.stageBaseline, null);
  a.stage.stageBaseline = -33;
  assert.equal(a.stageBaseline, -33);
  assert.equal(a.duckGain, 0);
  a.unmask.duckGain = -1.5;
  assert.equal(a.duckGain, -1.5);
  assert.equal(a.voxLevelEma, null);
  a.unmask.voxLevelEma = -25;
  assert.equal(a.voxLevelEma, -25);
  assert.equal(a.coachMode, false);
  a.coach.coachMode = true;
  assert.equal(a.coachMode, true);
});

test("leadTarget writes through to the ride job and reads back from it", () => {
  const { a } = rig();
  assert.equal(a.leadTarget, -6);
  a.leadTarget = -3;
  assert.equal(a.ride.leadTarget, -3);
  a.ride.leadTarget = -9;
  assert.equal(a.leadTarget, -9);
});

test("usedBusNotchBand writes through to the feedback job and reads back from it", () => {
  const { a } = rig();
  a.usedBusNotchBand = 4;
  assert.equal(a.feedback.usedBusNotchBand, 4);
  a.feedback.usedBusNotchBand = 2;
  assert.equal(a.usedBusNotchBand, 2);
});

test("fbBusBands writes through to the feedback job and reads back from it", () => {
  const { a } = rig();
  const bands = [2, 5];
  a.fbBusBands = bands;
  assert.equal(a.feedback.fbBusBands, bands);
  const other = [6];
  a.feedback.fbBusBands = other;
  assert.equal(a.fbBusBands, other);
});

test("calBusBands writes through to the feedback job and reads back from it", () => {
  const { a } = rig();
  const bands = new Set([1, 3]);
  a.calBusBands = bands;
  assert.equal(a.feedback.calBusBands, bands);
  const other = new Set([2]);
  a.feedback.calBusBands = other;
  assert.equal(a.calBusBands, other);
});

test("venueWatchFreqs writes through to the feedback job and reads back from it", () => {
  const { a } = rig();
  const freqs = [800, 3150];
  a.venueWatchFreqs = freqs;
  assert.equal(a.feedback.venueWatchFreqs, freqs);
  assert.equal(a.feedback.isNearWatch(805), true);
  const other = [100];
  a.feedback.venueWatchFreqs = other;
  assert.equal(a.venueWatchFreqs, other);
});

test("defaultConfig builds a fresh config each time equal to the documented defaults", () => {
  const one = defaultConfig();
  const two = defaultConfig();
  assert.notEqual(one, two);
  assert.notEqual(one, testCfg);
  assert.notEqual(one.CHANNELS, two.CHANNELS);
  assert.notEqual(one.CHANNELS, testCfg.CHANNELS);
  assert.deepEqual(one, two);
  assert.equal(one.LEAD_VOCAL_CH, 1);
  assert.equal(one.MEAS_MIC_CH, 8);
  assert.equal(one.STAGE_MIC_CH, null);
  assert.deepEqual(one.BALANCE_CHANNELS, [5, 7]);
  assert.equal(one.coach.ttlS, 8);
  assert.equal(one.manual.holdS, 5);
});

test("configWith overrides only the given fields on a fresh default config", () => {
  const cfg = configWith({ LEAD_VOCAL_CH: 2, STAGE_MIC_CH: 6 });
  assert.equal(cfg.LEAD_VOCAL_CH, 2);
  assert.equal(cfg.STAGE_MIC_CH, 6);
  assert.equal(cfg.MEAS_MIC_CH, 8);
  assert.notEqual(cfg.CHANNELS, testCfg.CHANNELS);
  assert.deepEqual(configWith(), defaultConfig());
});

test("applyChannelMap with a full spec changes only the target config", () => {
  const chansBefore = testCfg.CHANNELS;
  const labelsBefore = testCfg.ROLE_LABELS;
  const t = configWith();
  applyChannelMap(
    {
      map: { "3": "lead_vox", "5": "guest_SAX", "9": "meas_mic", "11": "2nd_gtr" },
      labels: { lead_vox: "Singer" },
      lead: 3.7,
      meas_mic: 9,
      balance: [5.9],
      guest: [5],
      stereo_links: [[3, 5.2]],
      stage_mic: 11.4,
      phase_pairs: [[3, 9]],
    },
    t,
  );
  assert.deepEqual(
    [...t.CHANNELS],
    [
      [3, "lead_vox"],
      [5, "guest_SAX"],
      [9, "meas_mic"],
      [11, "2nd_gtr"],
    ],
  );
  assert.deepEqual(
    [...t.ROLE_LABELS],
    [
      ["lead_vox", "Singer"],
      ["guest_SAX", "Guest Sax"],
      ["meas_mic", "FOH meas mic"],
      ["2nd_gtr", "2nd Gtr"],
    ],
  );
  assert.equal(t.LEAD_VOCAL_CH, 3);
  assert.equal(t.MEAS_MIC_CH, 9);
  assert.deepEqual(t.BALANCE_CHANNELS, [5]);
  assert.deepEqual(t.GUEST_CHANNELS, [5]);
  assert.deepEqual(t.STEREO_LINKS, [[3, 5]]);
  assert.equal(t.STAGE_MIC_CH, 11);
  assert.deepEqual(t.PHASE_PAIRS, [[3, 9]]);
  assert.equal(testCfg.CHANNELS, chansBefore);
  assert.equal(testCfg.ROLE_LABELS, labelsBefore);
});

test("applyChannelMap falls back to the lowest and highest channels when lead and meas are not mapped", () => {
  const t = configWith();
  applyChannelMap({ map: { "6": "a", "4": "b" } }, t);
  assert.equal(t.LEAD_VOCAL_CH, 4);
  assert.equal(t.MEAS_MIC_CH, 6);
});

test("applyChannelMap with an empty map throws and leaves the target config unchanged", () => {
  const t = configWith();
  const chans = t.CHANNELS;
  const labels = t.ROLE_LABELS;
  const saved = channelMapState(t);
  assert.throws(() => applyChannelMap({ map: {}, lead: 2, balance: [3], stage_mic: 4 }, t), {
    message: "the channel map has no channels",
  });
  assert.equal(t.CHANNELS, chans);
  assert.equal(t.ROLE_LABELS, labels);
  assert.deepEqual(channelMapState(t), saved);
  assert.deepEqual(t, configWith());
});

test("applyChannelMap with no fields keeps every value but copies the maps", () => {
  const t = configWith({ STAGE_MIC_CH: 6, GUEST_CHANNELS: [2], STEREO_LINKS: [[2, 3]], PHASE_PAIRS: [[1, 2]] });
  const chans = t.CHANNELS;
  const balance = t.BALANCE_CHANNELS;
  applyChannelMap({}, t);
  assert.notEqual(t.CHANNELS, chans);
  assert.deepEqual(t.CHANNELS, chans);
  assert.equal(t.ROLE_LABELS.get("cajon"), "Cajón / perc");
  assert.equal(t.LEAD_VOCAL_CH, 1);
  assert.equal(t.MEAS_MIC_CH, 8);
  assert.equal(t.BALANCE_CHANNELS, balance);
  assert.deepEqual(t.GUEST_CHANNELS, [2]);
  assert.deepEqual(t.STEREO_LINKS, [[2, 3]]);
  assert.equal(t.STAGE_MIC_CH, 6);
  assert.deepEqual(t.PHASE_PAIRS, [[1, 2]]);
});

test("applyChannelMap with null fields clears the lists and the stage mic but keeps lead and meas", () => {
  const t = configWith({ STAGE_MIC_CH: 6, GUEST_CHANNELS: [2] });
  applyChannelMap(
    {
      map: null,
      labels: null,
      lead: null,
      meas_mic: null,
      balance: null,
      guest: null,
      stereo_links: null,
      stage_mic: null,
      phase_pairs: null,
    },
    t,
  );
  assert.equal(t.CHANNELS.size, 8);
  assert.equal(t.LEAD_VOCAL_CH, 1);
  assert.equal(t.MEAS_MIC_CH, 8);
  assert.deepEqual(t.BALANCE_CHANNELS, []);
  assert.deepEqual(t.GUEST_CHANNELS, []);
  assert.deepEqual(t.STEREO_LINKS, []);
  assert.equal(t.STAGE_MIC_CH, null);
  assert.deepEqual(t.PHASE_PAIRS, []);
});

test("autoChannelMap maps inputs to numbered roles with the last as the measurement mic", () => {
  const t = configWith({ STAGE_MIC_CH: 2 });
  const spec = autoChannelMap(3, t);
  assert.deepEqual(spec, {
    map: { "1": "in_1", "2": "in_2", "3": "meas_mic" },
    lead: 1,
    meas_mic: 3,
    balance: [],
    guest: [],
    stereo_links: [],
    stage_mic: null,
    phase_pairs: [],
  });
  assert.deepEqual(
    [...t.CHANNELS],
    [
      [1, "in_1"],
      [2, "in_2"],
      [3, "meas_mic"],
    ],
  );
  assert.deepEqual(
    [...t.ROLE_LABELS],
    [
      ["in_1", "In 1"],
      ["in_2", "In 2"],
      ["meas_mic", "FOH meas mic"],
    ],
  );
  assert.equal(t.LEAD_VOCAL_CH, 1);
  assert.equal(t.MEAS_MIC_CH, 3);
  assert.equal(t.STAGE_MIC_CH, null);
  assert.deepEqual(t.BALANCE_CHANNELS, []);
});

test("autoChannelMap with one input or fewer makes a single measurement mic that is also the lead", () => {
  for (const n of [1, 0, -4, 1.9]) {
    const t = configWith();
    const spec = autoChannelMap(n, t);
    assert.deepEqual(spec.map, { "1": "meas_mic" });
    assert.equal(spec.lead, 1);
    assert.equal(spec.meas_mic, 1);
    assert.deepEqual([...t.CHANNELS], [[1, "meas_mic"]]);
    assert.equal(t.LEAD_VOCAL_CH, 1);
    assert.equal(t.MEAS_MIC_CH, 1);
  }
});

test("autoChannelMap truncates a fractional input count", () => {
  const t = configWith();
  autoChannelMap(2.9, t);
  assert.deepEqual(
    [...t.CHANNELS],
    [
      [1, "in_1"],
      [2, "meas_mic"],
    ],
  );
});

test("channelMapState copies the maps and lists of the source config", () => {
  const src = configWith({ ...smallConfig(), GUEST_CHANNELS: [5], STEREO_LINKS: [[3, 5]], PHASE_PAIRS: [[3, 9]] });
  const s = channelMapState(src);
  assert.deepEqual([...s.channels], [...src.CHANNELS]);
  assert.notEqual(s.channels, src.CHANNELS);
  assert.notEqual(s.roleLabels, src.ROLE_LABELS);
  assert.equal(s.lead, 3);
  assert.equal(s.meas, 9);
  assert.equal(s.stage, 5);
  assert.deepEqual(s.balance, [5]);
  assert.deepEqual(s.guest, [5]);
  assert.deepEqual(s.stereoLinks, [[3, 5]]);
  assert.deepEqual(s.phasePairs, [[3, 9]]);
  assert.notEqual(s.balance, src.BALANCE_CHANNELS);
  assert.notEqual(s.guest, src.GUEST_CHANNELS);
  assert.notEqual(s.stereoLinks, src.STEREO_LINKS);
  assert.notEqual(s.stereoLinks[0], src.STEREO_LINKS[0]);
  assert.notEqual(s.phasePairs, src.PHASE_PAIRS);
  assert.notEqual(s.phasePairs[0], src.PHASE_PAIRS[0]);
});

test("restoreChannelMapState writes a saved map into the target config only", () => {
  const chansBefore = testCfg.CHANNELS;
  const s = channelMapState(configWith({ ...smallConfig(), GUEST_CHANNELS: [5], STEREO_LINKS: [[3, 5]], PHASE_PAIRS: [[3, 9]] }));
  const t = configWith();
  restoreChannelMapState(s, t);
  assert.deepEqual(
    [...t.CHANNELS],
    [
      [3, "lead_vox"],
      [5, "stage_mic"],
      [9, "meas_mic"],
    ],
  );
  assert.notEqual(t.CHANNELS, s.channels);
  assert.notEqual(t.ROLE_LABELS, s.roleLabels);
  assert.equal(t.LEAD_VOCAL_CH, 3);
  assert.equal(t.MEAS_MIC_CH, 9);
  assert.equal(t.STAGE_MIC_CH, 5);
  assert.deepEqual(t.BALANCE_CHANNELS, [5]);
  assert.deepEqual(t.GUEST_CHANNELS, [5]);
  assert.deepEqual(t.STEREO_LINKS, [[3, 5]]);
  assert.deepEqual(t.PHASE_PAIRS, [[3, 9]]);
  assert.notEqual(t.BALANCE_CHANNELS, s.balance);
  assert.notEqual(t.GUEST_CHANNELS, s.guest);
  assert.notEqual(t.STEREO_LINKS, s.stereoLinks);
  assert.notEqual(t.STEREO_LINKS[0], s.stereoLinks[0]);
  assert.notEqual(t.PHASE_PAIRS, s.phasePairs);
  assert.notEqual(t.PHASE_PAIRS[0], s.phasePairs[0]);
  assert.deepEqual(channelMapState(t), s);
  assert.equal(testCfg.CHANNELS, chansBefore);
});

test("the channel map helpers act on the target they are given, and a restore puts it back", () => {
  const saved = channelMapState(testCfg);
  try {
    assert.deepEqual([...saved.channels], [...testCfg.CHANNELS]);
    applyChannelMap({ lead: 2 }, testCfg);
    assert.equal(testCfg.LEAD_VOCAL_CH, 2);
    autoChannelMap(2, testCfg);
    assert.deepEqual(
      [...testCfg.CHANNELS],
      [
        [1, "in_1"],
        [2, "meas_mic"],
      ],
    );
  } finally {
    restoreChannelMapState(saved, testCfg);
  }
  assert.deepEqual(channelMapState(testCfg), saved);
});
