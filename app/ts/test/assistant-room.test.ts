import assert from "node:assert/strict";
import test from "node:test";
import { configWith } from "../src/core/config.ts";
import { RoomModel, StageJob, roomConfidence } from "../src/core/assistant/room.ts";
import { feat, globalSnapshot, harness, tuned } from "./jobhelpers.ts";

const isolated = (name: string, fn: () => void): void => {
  test(name, () => {
    const before = globalSnapshot();
    fn();
    assert.equal(globalSnapshot(), before);
  });
};

const near = (actual: number, expected: number): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
};

const lowMsg = (pct: string): string => `room-mic SNR low (conf ${pct}) — feedback detection is being more conservative`;

test("the default room and feedback tuning matches the documented values", () => {
  const cfg = configWith();
  assert.deepEqual({ ...cfg.room }, { ema: 1 / 12, quietDb: -45, loudDb: -15, loudMin: 0.3, flatMin: 0.5, lowConf: 0.5, lowConfWarnS: 30 });
  assert.deepEqual({ ...cfg.stage }, { riseDb: 4, baselineEma: 0.001, warnIntervalS: 30 });
  assert.equal(cfg.feedback.ringDb, 12);
  assert.equal(cfg.MEAS_MIC_CH, 8);
  assert.equal(cfg.STAGE_MIC_CH, null);
});

test("room confidence is full when the room is at or below the quiet level and the spectrum rings", () => {
  const cfg = configWith();
  assert.equal(roomConfidence(cfg, -45, 12), 1);
  assert.equal(roomConfidence(cfg, -60, 12), 1);
  assert.equal(roomConfidence(cfg, -45, 30), 1);
});

test("room confidence falls to the loud floor at and above the loud level", () => {
  const cfg = configWith();
  assert.equal(roomConfidence(cfg, -15, 12), 0.3);
  assert.equal(roomConfidence(cfg, -5, 12), 0.3);
});

test("room confidence falls linearly between the quiet and loud levels", () => {
  const cfg = configWith();
  assert.equal(roomConfidence(cfg, -30, 12), 0.65);
  assert.equal(roomConfidence(cfg, -40, 12), 0.883);
  assert.equal(roomConfidence(cfg, -20, 12), 0.417);
});

test("room confidence scales with contrast below the ring threshold down to the flatness floor", () => {
  const cfg = configWith();
  assert.equal(roomConfidence(cfg, -50, 9), 0.75);
  assert.equal(roomConfidence(cfg, -50, 6), 0.5);
  assert.equal(roomConfidence(cfg, -50, 3), 0.5);
  assert.equal(roomConfidence(cfg, -50, 0), 0.5);
  assert.equal(roomConfidence(cfg, -50, -10), 0.5);
  assert.equal(roomConfidence(cfg, -50, 11.999), 1);
});

test("room confidence multiplies the loudness and flatness factors", () => {
  const cfg = configWith();
  assert.equal(roomConfidence(cfg, -30, 9), 0.488);
  assert.equal(roomConfidence(cfg, -15, 3), 0.15);
});

isolated("room confidence honours an injected tuning without touching the global config", () => {
  const cfg = configWith({
    ...tuned("room", { quietDb: -60, loudDb: -20, loudMin: 0.2, flatMin: 0.1 }),
    ...tuned("feedback", { ringDb: 20 }),
  });
  assert.equal(roomConfidence(cfg, -40, 20), 0.6);
  assert.equal(roomConfidence(cfg, -40, 1), 0.06);
  assert.equal(roomConfidence(cfg, -40, 10), 0.3);
  assert.equal(roomConfidence(cfg, -20, 20), 0.2);
  assert.equal(roomConfidence(cfg, -60, 20), 1);
});

test("a new room model starts at minus ninety dB with no contrast and leaves state at full confidence", () => {
  const h = harness();
  const room = new RoomModel(h.ctx);
  assert.equal(room.roomLevelDb, -90);
  assert.equal(room.roomContrastDb, 0);
  assert.equal(room.lastLowconfWarn, -1e9);
  assert.equal(h.state.roomConfidence, 1);
  assert.equal(room.ctx, h.ctx);
});

test("the room model smooths level and contrast with the default room ema and stores the confidence", () => {
  const h = harness();
  const room = new RoomModel(h.ctx);
  room.update(feat({ rmsDbfs: -30, contrastDb: 12 }), 0);
  near(room.roomLevelDb, -85);
  near(room.roomContrastDb, 1);
  assert.equal(h.state.roomConfidence, 0.5);
  room.update(feat({ rmsDbfs: -30, contrastDb: 12 }), 1);
  near(room.roomLevelDb, (11 / 12) * -85 + (1 / 12) * -30);
  near(room.roomContrastDb, (11 / 12) * 1 + 1);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.mixer.calls, []);
});

test("the room model warns on the measurement mic when confidence drops below the low threshold", () => {
  const h = harness(tuned("room", { ema: 1 }));
  const room = new RoomModel(h.ctx);
  room.update(feat({ rmsDbfs: -15, contrastDb: 12 }), 3);
  assert.equal(h.state.roomConfidence, 0.3);
  assert.equal(room.lastLowconfWarn, 3);
  assert.deepEqual(h.events, [{ kind: "system", msg: lowMsg("30%"), ch: 8 }]);
});

test("the room model does not warn when confidence equals the low threshold", () => {
  const h = harness(tuned("room", { ema: 1 }));
  const room = new RoomModel(h.ctx);
  room.update(feat({ rmsDbfs: -45, contrastDb: 6 }), 0);
  assert.equal(h.state.roomConfidence, 0.5);
  room.update(feat({ rmsDbfs: -30, contrastDb: 12 }), 1);
  assert.equal(h.state.roomConfidence, 0.65);
  assert.deepEqual(h.events, []);
  assert.equal(room.lastLowconfWarn, -1e9);
});

test("the low confidence warning repeats only after strictly more than the warn interval", () => {
  const h = harness(tuned("room", { ema: 1 }));
  const room = new RoomModel(h.ctx);
  const loud = feat({ rmsDbfs: -15, contrastDb: 12 });
  room.update(loud, 10);
  room.update(loud, 25);
  room.update(loud, 40);
  assert.equal(h.events.length, 1);
  room.update(feat({ rmsDbfs: -15, contrastDb: 6 }), 40.5);
  assert.equal(h.state.roomConfidence, 0.15);
  assert.deepEqual(h.events, [
    { kind: "system", msg: lowMsg("30%"), ch: 8 },
    { kind: "system", msg: lowMsg("15%"), ch: 8 },
  ]);
  assert.equal(room.lastLowconfWarn, 40.5);
});

isolated("the room model honours an injected measurement channel and room tuning", () => {
  const h = harness({ ...tuned("room", { ema: 0.5, lowConf: 0.9, lowConfWarnS: 1 }), MEAS_MIC_CH: 16 });
  const room = new RoomModel(h.ctx);
  room.update(feat({ rmsDbfs: -30, contrastDb: 24 }), 0);
  assert.equal(room.roomLevelDb, -60);
  assert.equal(room.roomContrastDb, 12);
  assert.equal(h.state.roomConfidence, 1);
  room.update(feat({ rmsDbfs: 0, contrastDb: 12 }), 1);
  assert.equal(room.roomLevelDb, -30);
  assert.equal(h.state.roomConfidence, 0.65);
  room.update(feat({ rmsDbfs: -30, contrastDb: 12 }), 2);
  room.update(feat({ rmsDbfs: -30, contrastDb: 12 }), 3.5);
  assert.deepEqual(h.events, [
    { kind: "system", msg: lowMsg("65%"), ch: 16 },
    { kind: "system", msg: lowMsg("65%"), ch: 16 },
  ]);
});

test("a new stage job has no baseline and a long-past warning time", () => {
  const h = harness();
  const stage = new StageJob(h.ctx);
  assert.equal(stage.stageBaseline, null);
  assert.equal(stage.lastStageWarn, -1e9);
  assert.equal(stage.ctx, h.ctx);
});

test("the first stage reading seeds the baseline at its own level without warning", () => {
  const h = harness();
  const stage = new StageJob(h.ctx);
  stage.handle(feat({ rmsDbfs: -40 }), 0);
  assert.equal(stage.stageBaseline, -40);
  assert.deepEqual(h.events, []);
});

test("the stage baseline moves slowly with the default ema and a loud jump warns with no stage channel", () => {
  const h = harness();
  const stage = new StageJob(h.ctx);
  stage.handle(feat({ rmsDbfs: -40 }), 0);
  stage.handle(feat({ rmsDbfs: -20 }), 1);
  near(stage.stageBaseline ?? 0, 0.999 * -40 + 0.001 * -20);
  assert.equal(stage.lastStageWarn, 1);
  assert.deepEqual(h.events, [
    { kind: "system", msg: "stage volume up ~20 dB over baseline — consider easing back", ch: null },
  ]);
  assert.deepEqual(h.mixer.calls, []);
});

test("the stage warning needs the level strictly above baseline plus the rise", () => {
  const h = harness(tuned("stage", { baselineEma: 0.5 }));
  const stage = new StageJob(h.ctx);
  stage.handle(feat({ rmsDbfs: -40 }), 0);
  stage.handle(feat({ rmsDbfs: -32 }), 1);
  assert.equal(stage.stageBaseline, -36);
  assert.deepEqual(h.events, []);
  stage.handle(feat({ rmsDbfs: -27 }), 2);
  assert.equal(stage.stageBaseline, -31.5);
  assert.deepEqual(h.events, [
    { kind: "system", msg: "stage volume up ~4 dB over baseline — consider easing back", ch: null },
  ]);
});

test("the stage warning repeats only after strictly more than the warn interval", () => {
  const h = harness({ ...tuned("stage", { baselineEma: 0 }), STAGE_MIC_CH: 6 });
  const stage = new StageJob(h.ctx);
  stage.handle(feat({ rmsDbfs: -40 }), 0);
  stage.handle(feat({ rmsDbfs: -30 }), 5);
  stage.handle(feat({ rmsDbfs: -30 }), 35);
  stage.handle(feat({ rmsDbfs: -30 }), 35.5);
  assert.equal(stage.stageBaseline, -40);
  assert.equal(stage.lastStageWarn, 35.5);
  const msg = "stage volume up ~10 dB over baseline — consider easing back";
  assert.deepEqual(h.events, [
    { kind: "system", msg, ch: 6 },
    { kind: "system", msg, ch: 6 },
  ]);
});

test("a quieter stage reading lowers the baseline and does not warn", () => {
  const h = harness(tuned("stage", { baselineEma: 0.5 }));
  const stage = new StageJob(h.ctx);
  stage.handle(feat({ rmsDbfs: -20 }), 0);
  stage.handle(feat({ rmsDbfs: -40 }), 100);
  assert.equal(stage.stageBaseline, -30);
  assert.deepEqual(h.events, []);
});

isolated("the stage job honours an injected stage channel and tuning", () => {
  const h = harness({ ...tuned("stage", { baselineEma: 1, riseDb: 1, warnIntervalS: 0 }), STAGE_MIC_CH: 12 });
  const stage = new StageJob(h.ctx);
  stage.handle(feat({ rmsDbfs: -40 }), 0);
  stage.handle(feat({ rmsDbfs: -10 }), 1);
  assert.equal(stage.stageBaseline, -10);
  assert.deepEqual(h.events, []);
  const h2 = harness({ ...tuned("stage", { baselineEma: 0.25, riseDb: 1, warnIntervalS: 0 }), STAGE_MIC_CH: 12 });
  const s2 = new StageJob(h2.ctx);
  s2.handle(feat({ rmsDbfs: -40 }), 0);
  s2.handle(feat({ rmsDbfs: -36 }), 1);
  s2.handle(feat({ rmsDbfs: -36 }), 1);
  assert.equal(s2.stageBaseline, -38.25);
  assert.equal(s2.lastStageWarn, 1);
  assert.deepEqual(h2.events, [
    { kind: "system", msg: "stage volume up ~3 dB over baseline — consider easing back", ch: 12 },
  ]);
});
