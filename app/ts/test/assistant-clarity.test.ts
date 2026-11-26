import assert from "node:assert/strict";
import test from "node:test";
import { configWith } from "../src/core/config.ts";
import type { Config } from "../src/core/config.ts";
import { PhaseJob, UnmaskJob } from "../src/core/assistant/clarity.ts";
import { Coach } from "../src/core/assistant/coach.ts";
import { ManualClock } from "../src/core/clock.ts";
import type { PhaseRelation } from "../src/core/dsp.ts";
import { feat, globalSnapshot, harness, tuned } from "./jobhelpers.ts";
import type { Harness } from "./jobhelpers.ts";

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

const rel = (zeroCorr: number, lagMs = 0, bestCorr: number = zeroCorr): PhaseRelation => ({
  zeroCorr,
  bestCorr,
  lagSamples: Math.round(lagMs * 48),
  lagMs,
});

interface PhaseRig {
  h: Harness;
  job: PhaseJob;
  forgotten: string[];
}

const phaseRig = (over: Partial<Config> = {}, enabled = true): PhaseRig => {
  const h = harness(over);
  h.state.enabled.phase = enabled;
  const forgotten: string[] = [];
  const job = new PhaseJob(h.ctx, (key) => forgotten.push(key));
  return { h, job, forgotten };
};

const fast = (values: Partial<Config["phase"]> = {}): Partial<Config> => tuned("phase", { ema: 1, sustain: 2, ...values });

const unmaskRig = (over: Partial<Config> = {}, enabled = true): { h: Harness; job: UnmaskJob } => {
  const h = harness(over);
  h.state.enabled.unmask = enabled;
  return { h, job: new UnmaskJob(h.ctx) };
};

const eq = (ch: number, gainDb: number, band = 4, hz = 3000, q = 1.2) => ({ op: "eqBand", ch, band, hz, gainDb, q, on: true });

const FLIP = "lead_vox & harm_vox_l out of polarity → flipped phase on harm_vox_l";
const STILL = "lead_vox & harm_vox_l still out of polarity after a flip → check mic placement / the card tap point.";

test("the default phase and unmask tuning matches the documented values", () => {
  const cfg = configWith();
  assert.deepEqual({ ...cfg.phase }, { corrMin: 0.45, invertCorr: -0.35, combLagMs: 0.35, maxLagMs: 3, ema: 1 / 16, sustain: 8, actCooldownS: 5, warnIntervalS: 20 });
  assert.deepEqual({ ...cfg.unmask }, {
    band: 4,
    freq: 3000,
    q: 1.2,
    depthDb: -4,
    voxGateDb: -38,
    attack: 0.3,
    release: 0.04,
    writeEpsDb: 0.3,
    voxEma: 1 / 6,
    logDb: -1,
    logIntervalS: 10,
  });
  assert.equal(cfg.DEFAULT_ENABLED["phase"], false);
  assert.equal(cfg.DEFAULT_ENABLED["unmask"], false);
  assert.deepEqual(cfg.UNMASK_CHANNELS, []);
});

test("a new phase job starts with every mapped channel at normal polarity and empty state", () => {
  const { job, h } = phaseRig();
  assert.deepEqual([...job.polarity], [1, 2, 3, 4, 5, 6, 7, 8].map((c) => [c, false]));
  assert.equal(job.ctx, h.ctx);
  assert.equal(job.phaseEma.size, 0);
  assert.equal(job.phaseStatus.size, 0);
});

test("a disabled phase job ignores every relation", () => {
  const { h, job, forgotten } = phaseRig(fast(), false);
  for (let t = 0; t < 5; t++) job.handle(1, 2, rel(-0.9), t);
  job.handle(1, 2, rel(0.9), 6);
  assert.equal(job.phaseEma.size, 0);
  assert.equal(job.phaseLagEma.size, 0);
  assert.equal(job.phaseStatus.size, 0);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.recs, []);
  assert.deepEqual(forgotten, []);
});

test("the zero-lag correlation is smoothed with the default phase ema after the first reading", () => {
  const { job } = phaseRig();
  job.handle(1, 2, rel(-0.8), 0);
  assert.equal(job.phaseEma.get("1,2"), -0.8);
  job.handle(1, 2, rel(0.8), 1);
  near(job.phaseEma.get("1,2") ?? 0, -0.7);
  assert.equal(job.phaseStatus.get("1,2")?.corr, -0.7);
});

test("the lag is smoothed only when the best correlation reaches the minimum", () => {
  const { job } = phaseRig(tuned("phase", { ema: 0.5 }));
  job.handle(1, 2, rel(0.1, 1, 0.44), 0);
  assert.equal(job.phaseLagEma.has("1,2"), false);
  assert.equal(job.phaseStatus.get("1,2")?.lag_ms, 0);
  job.handle(1, 2, rel(0.1, 1, 0.45), 1);
  assert.equal(job.phaseLagEma.get("1,2"), 1);
  job.handle(1, 2, rel(0.1, 3, -0.5), 2);
  assert.equal(job.phaseLagEma.get("1,2"), 2);
  job.handle(1, 2, rel(0.1, 9, -0.449), 3);
  assert.equal(job.phaseLagEma.get("1,2"), 2);
  assert.equal(job.phaseStatus.get("1,2")?.lag_ms, 2);
});

test("the phase status is classified at the exact thresholds", () => {
  const cases: [PhaseRelation, string][] = [
    [rel(-0.36), "inverted"],
    [rel(-0.35), "unrelated"],
    [rel(0.449), "unrelated"],
    [rel(0.45), "aligned"],
    [rel(-0.45), "inverted"],
    [rel(0.9, 0.35), "aligned"],
    [rel(0.9, 0.36), "comb"],
    [rel(0.9, -0.5), "comb"],
    [rel(-0.9, 2), "inverted"],
    [rel(0.2, 2, 0.9), "unrelated"],
  ];
  for (const [r, status] of cases) {
    const { job } = phaseRig(fast({ sustain: 100 }));
    job.handle(1, 2, r, 0);
    assert.equal(job.phaseStatus.get("1,2")?.status, status, JSON.stringify(r));
  }
});

test("the phase status record carries rounded correlation and lag and both channel polarities", () => {
  const { job } = phaseRig(fast());
  job.handle(3, 4, rel(0.91234, 0.12345), 0);
  assert.deepEqual(job.phaseStatus.get("3,4"), { a: 3, b: 4, corr: 0.91, lag_ms: 0.12, status: "aligned", inv_a: false, inv_b: false });
});

test("the inverted streak builds and decays by one per non-inverted reading but never below zero", () => {
  const { job } = phaseRig(fast({ sustain: 100 }));
  job.handle(1, 2, rel(-0.9), 0);
  job.handle(1, 2, rel(-0.9), 1);
  job.handle(1, 2, rel(-0.9), 2);
  assert.equal(job.phaseStreak.get("1,2"), 3);
  job.handle(1, 2, rel(0.9), 3);
  assert.equal(job.phaseStreak.get("1,2"), 2);
  job.handle(1, 2, rel(0.9, 1), 4);
  assert.equal(job.phaseStreak.get("1,2"), 1);
  job.handle(1, 2, rel(0), 5);
  job.handle(1, 2, rel(0), 6);
  assert.equal(job.phaseStreak.get("1,2"), 0);
});

test("the default sustain flips polarity on the eighth inverted reading", () => {
  const { h, job } = phaseRig(tuned("phase", { ema: 1 }));
  for (let t = 0; t < 7; t++) job.handle(1, 2, rel(-0.9), t);
  assert.deepEqual(h.mixer.calls, []);
  job.handle(1, 2, rel(-0.9), 7);
  assert.deepEqual(h.mixer.calls, [{ op: "polarity", ch: 2, inverted: true }]);
});

test("the phase job runs the full flip, cooldown, warn, re-arm and flip-back cycle", () => {
  const { h, job, forgotten } = phaseRig(fast());
  const inv = rel(-0.8, 0.1);
  job.handle(1, 2, inv, 0);
  assert.equal(job.phaseStreak.get("1,2"), 1);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(job.phaseStatus.get("1,2"), { a: 1, b: 2, corr: -0.8, lag_ms: 0.1, status: "inverted", inv_a: false, inv_b: false });

  job.handle(1, 2, inv, 1);
  assert.deepEqual(h.mixer.calls, [{ op: "polarity", ch: 2, inverted: true }]);
  assert.equal(job.polarity.get(2), true);
  assert.equal(job.lastPhaseAct.get("1,2"), 1);
  assert.equal(job.phaseArmed.get("1,2"), false);
  assert.equal(job.phaseStreak.get("1,2"), 0);
  assert.deepEqual(h.events, [{ kind: "phase", msg: `${FLIP} (inverted)`, ch: 2 }]);
  assert.deepEqual(h.latency, ["phase"]);
  assert.equal(job.phaseStatus.get("1,2")?.inv_b, false);

  job.handle(1, 2, inv, 2);
  job.handle(1, 2, inv, 3);
  job.handle(1, 2, inv, 6);
  assert.equal(h.events.length, 1);
  assert.equal(job.phaseStatus.get("1,2")?.inv_b, true);

  job.handle(1, 2, inv, 7);
  assert.deepEqual(h.events[1], { kind: "phase", msg: STILL, ch: 1 });
  assert.equal(job.lastPhaseWarn.get("1,2|flip"), 7);
  assert.equal(job.lastPhaseWarn.has("1,2"), false);
  job.handle(1, 2, inv, 8);
  job.handle(1, 2, inv, 27);
  assert.equal(h.events.length, 2);
  job.handle(1, 2, inv, 28);
  assert.deepEqual(h.events[2], { kind: "phase", msg: STILL, ch: 1 });
  assert.equal(h.mixer.calls.length, 1);
  assert.equal(job.phaseStreak.get("1,2"), 7);

  job.handle(1, 2, rel(0.9), 29);
  assert.equal(job.phaseArmed.get("1,2"), true);
  assert.equal(job.phaseStreak.get("1,2"), 6);
  assert.deepEqual(forgotten, ["phase|1,2"]);

  job.handle(1, 2, inv, 30);
  assert.deepEqual(h.mixer.calls, [
    { op: "polarity", ch: 2, inverted: true },
    { op: "polarity", ch: 2, inverted: false },
  ]);
  assert.equal(job.polarity.get(2), false);
  assert.deepEqual(h.events[3], { kind: "phase", msg: `${FLIP} (normal)`, ch: 2 });
  assert.deepEqual(h.latency, ["phase", "phase"]);
  assert.equal(h.events.length, 4);
});

test("an unrelated reading re-arms the pair after a flip but a comb reading does not", () => {
  const { h, job, forgotten } = phaseRig(fast({ actCooldownS: 0 }));
  job.handle(1, 2, rel(-0.9), 0);
  job.handle(1, 2, rel(-0.9), 1);
  assert.equal(h.mixer.calls.length, 1);
  job.handle(1, 2, rel(0.9, 1), 2);
  assert.equal(job.phaseArmed.get("1,2"), false);
  job.handle(1, 2, rel(-0.9), 3);
  job.handle(1, 2, rel(-0.9), 4);
  assert.equal(h.mixer.calls.length, 1);
  assert.deepEqual(h.events.map((e) => e.msg), [
    `${FLIP} (inverted)`,
    "lead_vox & harm_vox_l arrive ~1.00 ms apart (comb filtering) → time-align them or move the mic.",
    STILL,
  ]);
  job.handle(1, 2, rel(0.1), 5);
  assert.equal(job.phaseArmed.get("1,2"), true);
  assert.deepEqual(forgotten, ["phase|1,2"]);
  job.handle(1, 2, rel(-0.9), 6);
  assert.equal(h.mixer.calls.length, 2);
});

test("comb and still-inverted warnings for one pair have independent rate limits", () => {
  const { h, job } = phaseRig(fast({ actCooldownS: 0 }));
  const COMB = "lead_vox & harm_vox_l arrive ~1.00 ms apart (comb filtering) → time-align them or move the mic.";
  job.handle(1, 2, rel(-0.9), 0);
  job.handle(1, 2, rel(-0.9), 1);
  job.handle(1, 2, rel(0.9, 1), 2);
  job.handle(1, 2, rel(-0.9), 3);
  job.handle(1, 2, rel(-0.9), 4);
  assert.deepEqual(h.events, [
    { kind: "phase", msg: `${FLIP} (inverted)`, ch: 2 },
    { kind: "phase", msg: COMB, ch: 1 },
    { kind: "phase", msg: STILL, ch: 1 },
  ]);
  assert.equal(job.lastPhaseWarn.get("1,2|comb"), 2);
  assert.equal(job.lastPhaseWarn.get("1,2|flip"), 4);
  job.handle(1, 2, rel(0.9, 1), 5);
  job.handle(1, 2, rel(-0.9), 6);
  job.handle(1, 2, rel(-0.9), 7);
  assert.equal(h.events.length, 3);
  job.handle(1, 2, rel(0.9, 1), 22.5);
  assert.deepEqual(h.events[3], { kind: "phase", msg: COMB, ch: 1 });
  job.handle(1, 2, rel(-0.9), 23);
  job.handle(1, 2, rel(-0.9), 24);
  assert.equal(h.events.length, 4);
  job.handle(1, 2, rel(-0.9), 24.5);
  assert.deepEqual(h.events[4], { kind: "phase", msg: STILL, ch: 1 });
  assert.equal(h.mixer.calls.length, 1);
});

test("the flip waits for the action cooldown to be strictly exceeded", () => {
  const { h, job } = phaseRig(fast({ sustain: 1, actCooldownS: 5 }));
  job.handle(1, 2, rel(-0.9), 0);
  assert.equal(h.mixer.calls.length, 1);
  job.handle(1, 2, rel(0.9), 1);
  job.handle(1, 2, rel(-0.9), 5);
  assert.equal(h.mixer.calls.length, 1);
  assert.deepEqual(h.events.length, 1);
  job.handle(1, 2, rel(-0.9), 5.5);
  assert.equal(h.mixer.calls.length, 2);
});

test("a comb reading warns with the absolute lag and is rate limited per pair", () => {
  const { h, job, forgotten } = phaseRig(fast());
  const msg = "lead_vox & harm_vox_l arrive ~0.50 ms apart (comb filtering) → time-align them or move the mic.";
  job.handle(1, 2, rel(0.9, -0.5), 0);
  assert.deepEqual(h.events, [{ kind: "phase", msg, ch: 1 }]);
  job.handle(1, 2, rel(0.9, -0.5), 20);
  assert.equal(h.events.length, 1);
  job.handle(1, 3, rel(0.9, 0.5), 20);
  assert.equal(h.events.length, 2);
  assert.equal(h.events[1]?.msg, "lead_vox & harm_vox_r arrive ~0.50 ms apart (comb filtering) → time-align them or move the mic.");
  job.handle(1, 2, rel(0.9, -0.5), 21);
  assert.deepEqual(h.events[2], { kind: "phase", msg, ch: 1 });
  assert.deepEqual(forgotten, []);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.recs, []);
});

test("aligned and unrelated readings forget the coaching card of that pair", () => {
  const { job, forgotten, h } = phaseRig(fast());
  job.handle(3, 4, rel(0.9), 0);
  job.handle(5, 6, rel(0), 0);
  job.handle(7, 1, rel(-0.9), 0);
  job.handle(3, 8, rel(0.9), 0);
  assert.deepEqual(forgotten, ["phase|3,4", "phase|5,6", "phase|3,8"]);
  assert.deepEqual(h.events, []);
});

test("coaching advice is recommended under a key for its pair", () => {
  const { h } = phaseRig(fast({ sustain: 1 }));
  h.coach.on = true;
  const keys: (string | undefined)[] = [];
  const job = new PhaseJob(
    {
      ...h.ctx,
      recommend: (kind, ch, text, persist, meta, key) => {
        keys.push(key);
        h.ctx.recommend(kind, ch, text, persist, meta, key);
      },
    },
    () => undefined,
  );
  job.handle(3, 5, rel(-0.9), 0);
  job.handle(3, 6, rel(0.9, 1), 0);
  assert.deepEqual(keys, ["phase|3,5", "phase|3,6"]);
  assert.deepEqual(h.recs.map((r) => r.ch), [3, 3]);
});

test("a settled reading on one pair keeps a real coach's advice for another pair sharing channel a", () => {
  const h = harness(fast({ sustain: 1 }));
  h.state.enabled.phase = true;
  const shown: string[] = [];
  const coach = new Coach(h.cfg, new ManualClock(0, 0), (_kind, msg) => shown.push(msg));
  const job = new PhaseJob({ ...h.ctx, coaching: () => true, recommend: (...args) => coach.recommend(...args) }, (key) => coach.forget(key));
  job.handle(3, 5, rel(-0.9), 0);
  job.handle(3, 6, rel(0.9, 1), 0);
  assert.equal(coach.snapshot().length, 2);
  job.handle(3, 7, rel(0.9), 1);
  job.handle(3, 6, rel(0.9), 1);
  const left = coach.snapshot();
  assert.deepEqual(left.map((r) => r.text), ["harm_vox_r & bass_di are OUT OF POLARITY (corr -0.90) → invert phase on bass_di."]);
  assert.deepEqual(left[0]?.["pair"], [3, 5]);
  assert.equal(shown.length, 2);
});

test("coaching mode recommends the polarity flip instead of flipping", () => {
  const { h, job, forgotten } = phaseRig(fast({ sustain: 1 }));
  h.coach.on = true;
  job.handle(1, 2, rel(-0.8), 0);
  job.handle(1, 2, rel(-0.8), 10);
  const rec = {
    kind: "phase",
    ch: 1,
    text: "lead_vox & harm_vox_l are OUT OF POLARITY (corr -0.80) → invert phase on harm_vox_l.",
    persist: true,
    meta: { pair: [1, 2], status: "inverted", corr: -0.8 },
  };
  assert.deepEqual(h.recs, [rec, rec]);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.latency, []);
  assert.equal(job.polarity.get(2), false);
  assert.equal(job.phaseStreak.get("1,2"), 2);
  assert.deepEqual(forgotten, []);
});

test("coaching mode recommends time alignment for a comb reading without warning", () => {
  const { h, job } = phaseRig(fast());
  h.coach.on = true;
  job.handle(1, 2, rel(0.9, 0.756), 0);
  assert.deepEqual(h.recs, [
    {
      kind: "phase",
      ch: 1,
      text: "lead_vox & harm_vox_l arrive ~0.76 ms apart (comb filtering) → time-align them or move the mic.",
      persist: true,
      meta: { pair: [1, 2], status: "comb", lag_ms: 0.76 },
    },
  ]);
  assert.deepEqual(h.events, []);
});

test("channels outside the map are labelled by number and default to normal polarity", () => {
  const { h, job } = phaseRig(fast({ sustain: 1 }));
  job.handle(20, 21, rel(-0.9), 0);
  assert.deepEqual(h.mixer.calls, [{ op: "polarity", ch: 21, inverted: true }]);
  assert.deepEqual(h.events, [{ kind: "phase", msg: "ch20 & ch21 out of polarity → flipped phase on ch21 (inverted)", ch: 21 }]);
  job.handle(21, 20, rel(0.9), 1);
  assert.deepEqual(job.phaseStatus.get("21,20"), { a: 21, b: 20, corr: 0.9, lag_ms: 0, status: "aligned", inv_a: true, inv_b: false });
});

isolated("the phase job honours an injected channel map and tuning", () => {
  const { h, job } = phaseRig({
    ...tuned("phase", { ema: 1, sustain: 1, invertCorr: -0.1, corrMin: 0.2, actCooldownS: 0 }),
    CHANNELS: new Map([
      [10, "gtr"],
      [11, "vox"],
    ]),
  });
  assert.deepEqual([...job.polarity], [
    [10, false],
    [11, false],
  ]);
  job.handle(10, 11, rel(-0.15), 0);
  assert.deepEqual(h.mixer.calls, [{ op: "polarity", ch: 11, inverted: true }]);
  assert.deepEqual(h.events, [{ kind: "phase", msg: "gtr & vox out of polarity → flipped phase on vox (inverted)", ch: 11 }]);
  job.handle(10, 11, rel(0.2), 1);
  assert.equal(job.phaseStatus.get("10,11")?.status, "aligned");
});

test("a new unmask job holds no duck and no vocal estimate", () => {
  const { job, h } = unmaskRig();
  assert.equal(job.duckGain, 0);
  assert.equal(job.duckApplied.size, 0);
  assert.equal(job.voxLevelEma, null);
  assert.equal(job.lastUnmaskLog, -1e9);
  assert.equal(job.ctx, h.ctx);
});

test("unmask targets every channel except the lead, measurement and stage mics by default", () => {
  assert.deepEqual(unmaskRig().job.targets(), [2, 3, 4, 5, 6, 7]);
  assert.deepEqual(unmaskRig({ STAGE_MIC_CH: 6 }).job.targets(), [2, 3, 4, 5, 7]);
  assert.deepEqual(unmaskRig({ LEAD_VOCAL_CH: 2, MEAS_MIC_CH: 3 }).job.targets(), [1, 4, 5, 6, 7, 8]);
});

test("unmask targets come from the configured list in order, dropping channels not in the map", () => {
  assert.deepEqual(unmaskRig({ UNMASK_CHANNELS: [6, 99, 2, 1] }).job.targets(), [6, 2, 1]);
  assert.deepEqual(unmaskRig({ UNMASK_CHANNELS: [99] }).job.targets(), []);
});

test("a disabled unmask job does nothing", () => {
  const { h, job } = unmaskRig({}, false);
  job.handle(feat({ rmsDbfs: -10 }), 0);
  assert.equal(job.voxLevelEma, null);
  assert.equal(job.duckGain, 0);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.recs, []);
});

test("the vocal level is smoothed with the default vox ema after seeding", () => {
  const { job } = unmaskRig();
  job.handle(feat({ rmsDbfs: -20 }), 0);
  assert.equal(job.voxLevelEma, -20);
  job.handle(feat({ rmsDbfs: -50 }), 1);
  near(job.voxLevelEma ?? 0, -25);
});

test("a present vocal ducks every target with the attack coefficient and logs once", () => {
  const { h, job } = unmaskRig();
  job.handle(feat({ rmsDbfs: -20 }), 0);
  near(job.duckGain, -1.2);
  assert.deepEqual(h.mixer.calls, [2, 3, 4, 5, 6, 7].map((c) => eq(c, -1.2)));
  assert.deepEqual(h.events, [{ kind: "unmask", msg: "vocal up → ducking 3000 Hz -1.2 dB on 6 instrument(s)", ch: null }]);
  assert.equal(job.lastUnmaskLog, 0);
  job.handle(feat({ rmsDbfs: -20 }), 1);
  near(job.duckGain, -2.04);
  assert.deepEqual(h.mixer.calls.slice(6), [2, 3, 4, 5, 6, 7].map((c) => eq(c, -2)));
  assert.equal(h.events.length, 1);
  near(job.duckApplied.get(2) ?? 0, -2.04);
});

test("the duck releases with the release coefficient when the vocal drops to the gate", () => {
  const { h, job } = unmaskRig({ ...tuned("unmask", { voxEma: 1, attack: 0.5, release: 0.25 }), UNMASK_CHANNELS: [4] });
  job.handle(feat({ rmsDbfs: -20 }), 0);
  assert.equal(job.duckGain, -2);
  job.handle(feat({ rmsDbfs: -38 }), 1);
  assert.equal(job.duckGain, -1.5);
  assert.deepEqual(h.mixer.calls, [eq(4, -2), eq(4, -1.5)]);
  assert.equal(h.events.length, 1);
});

test("the duck holds at full depth using the release coefficient when already at target", () => {
  const { h, job } = unmaskRig({ ...tuned("unmask", { voxEma: 1, attack: 1, release: 0.5 }), UNMASK_CHANNELS: [4] });
  job.handle(feat({ rmsDbfs: -20 }), 0);
  job.handle(feat({ rmsDbfs: -20 }), 1);
  assert.equal(job.duckGain, -4);
  assert.deepEqual(h.mixer.calls, [eq(4, -4)]);
});

test("a vocal at or below the gate leaves an undisturbed duck at zero with no writes or log", () => {
  const { h, job } = unmaskRig(tuned("unmask", { voxEma: 1 }));
  job.handle(feat({ rmsDbfs: -38 }), 0);
  job.handle(feat({ rmsDbfs: -60 }), 100);
  assert.equal(job.duckGain, 0);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
});

test("a channel is written only when the change reaches the write epsilon", () => {
  const exact = unmaskRig({ ...tuned("unmask", { voxEma: 1, attack: 0.5, writeEpsDb: 2 }), UNMASK_CHANNELS: [3] });
  exact.job.handle(feat({ rmsDbfs: -20 }), 0);
  assert.deepEqual(exact.h.mixer.calls, [eq(3, -2)]);
  const under = unmaskRig({ ...tuned("unmask", { voxEma: 1, attack: 0.5, writeEpsDb: 2.5 }), UNMASK_CHANNELS: [3] });
  under.job.handle(feat({ rmsDbfs: -20 }), 0);
  assert.deepEqual(under.h.mixer.calls, []);
  assert.equal(under.job.duckApplied.size, 0);
  under.job.handle(feat({ rmsDbfs: -20 }), 1);
  assert.deepEqual(under.h.mixer.calls, [eq(3, -3)]);
  assert.equal(under.job.duckApplied.get(3), -3);
});

test("the unmask log needs the duck strictly below the log level and respects the log interval", () => {
  const { h, job } = unmaskRig({ ...tuned("unmask", { voxEma: 1, attack: 0.25, writeEpsDb: 100 }), UNMASK_CHANNELS: [2] });
  job.handle(feat({ rmsDbfs: -20 }), 0);
  assert.equal(job.duckGain, -1);
  assert.deepEqual(h.events, []);
  job.handle(feat({ rmsDbfs: -20 }), 1);
  assert.equal(job.duckGain, -1.75);
  assert.deepEqual(h.events, [{ kind: "unmask", msg: "vocal up → ducking 3000 Hz -1.8 dB on 1 instrument(s)", ch: null }]);
  job.handle(feat({ rmsDbfs: -20 }), 11);
  assert.equal(h.events.length, 1);
  job.handle(feat({ rmsDbfs: -20 }), 11.5);
  assert.equal(h.events.length, 2);
  assert.equal(job.lastUnmaskLog, 11.5);
  assert.deepEqual(h.mixer.calls, []);
});

test("the unmask log is skipped when the vocal is absent even with a deep duck", () => {
  const { h, job } = unmaskRig({ ...tuned("unmask", { voxEma: 1, attack: 1, release: 0.1, logIntervalS: 0 }), UNMASK_CHANNELS: [2] });
  job.handle(feat({ rmsDbfs: -20 }), 0);
  assert.equal(h.events.length, 1);
  job.handle(feat({ rmsDbfs: -50 }), 1);
  near(job.duckGain, -3.6);
  assert.equal(h.events.length, 1);
});

test("coaching mode recommends the dip on the targets and never touches the mixer", () => {
  const { h, job } = unmaskRig();
  h.coach.on = true;
  job.handle(feat({ rmsDbfs: -20 }), 0);
  assert.equal(job.voxLevelEma, -20);
  assert.equal(job.duckGain, 0);
  assert.deepEqual(h.recs, [
    {
      kind: "unmask",
      ch: 1,
      text: "To unmask the vocal: dip ~3000 Hz by 4 dB (Q 1.2) on harm_vox_l, harm_vox_r, acoustic_gtr, bass_di, cajon, keys_aux while the vocal is up.",
      persist: true,
      meta: { freq: 3000, depth_db: -4, channels: [2, 3, 4, 5, 6, 7] },
    },
  ]);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
});

test("release flattens every applied channel, clears the map and resets the duck", () => {
  const { h, job } = unmaskRig({ UNMASK_CHANNELS: [5, 3] });
  job.handle(feat({ rmsDbfs: -20 }), 0);
  h.mixer.calls.length = 0;
  job.release();
  assert.deepEqual(h.mixer.calls, [eq(5, 0), eq(3, 0)]);
  assert.equal(job.duckApplied.size, 0);
  assert.equal(job.duckGain, 0);
  job.release();
  assert.equal(h.mixer.calls.length, 2);
  job.handle(feat({ rmsDbfs: -20 }), 1);
  assert.deepEqual(h.mixer.calls.slice(2), [eq(5, -1.2), eq(3, -1.2)]);
});

test("release works on a disabled job", () => {
  const { h, job } = unmaskRig({}, false);
  job.duckApplied.set(7, -3);
  job.duckGain = -3;
  job.release();
  assert.deepEqual(h.mixer.calls, [eq(7, 0)]);
  assert.equal(job.duckGain, 0);
});

test("an empty target list still logs the duck with zero instruments", () => {
  const { h, job } = unmaskRig({ UNMASK_CHANNELS: [42] });
  job.handle(feat({ rmsDbfs: -20 }), 0);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, [{ kind: "unmask", msg: "vocal up → ducking 3000 Hz -1.2 dB on 0 instrument(s)", ch: null }]);
});

isolated("the unmask job honours an injected channel map and tuning", () => {
  const { h, job } = unmaskRig({
    ...tuned("unmask", { band: 2, freq: 2500, q: 2, depthDb: -6, attack: 1, voxEma: 1, voxGateDb: -30 }),
    CHANNELS: new Map([
      [10, "vox"],
      [11, "gtr"],
      [12, "stage"],
      [13, "room"],
    ]),
    LEAD_VOCAL_CH: 10,
    MEAS_MIC_CH: 13,
    STAGE_MIC_CH: 12,
  });
  assert.deepEqual(job.targets(), [11]);
  job.handle(feat({ rmsDbfs: -30 }), 0);
  assert.deepEqual(h.mixer.calls, []);
  job.handle(feat({ rmsDbfs: -29 }), 1);
  assert.deepEqual(h.mixer.calls, [eq(11, -6, 2, 2500, 2)]);
  assert.deepEqual(h.events, [{ kind: "unmask", msg: "vocal up → ducking 2500 Hz -6.0 dB on 1 instrument(s)", ch: null }]);
  h.coach.on = true;
  job.handle(feat({ rmsDbfs: -29 }), 2);
  assert.deepEqual(h.recs[0]?.ch, 10);
  assert.equal(h.recs[0]?.text, "To unmask the vocal: dip ~2500 Hz by 6 dB (Q 2.0) on gtr while the vocal is up.");
  assert.deepEqual(h.recs[0]?.meta, { freq: 2500, depth_db: -6, channels: [11] });
});
