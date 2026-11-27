import assert from "node:assert/strict";
import test from "node:test";
import { ClipJob } from "../src/core/assistant/clip.ts";
import { Coach } from "../src/core/assistant/coach.ts";
import { ManualClock } from "../src/core/clock.ts";
import { NEG_INF } from "../src/core/util.ts";
import { feat, globalSnapshot, harness, tuned } from "./jobhelpers.ts";
import type { Harness } from "./jobhelpers.ts";

const setup = (h: Harness = harness()): { h: Harness; job: ClipJob } => ({ h, job: new ClipJob(h.ctx) });

const keepsGlobal = (body: () => void): void => {
  const before = globalSnapshot();
  body();
  assert.equal(globalSnapshot(), before);
};

test("the clip defaults match the expected tuning", () => {
  const { h } = setup();
  assert.deepEqual(
    { ...h.cfg.clip },
    {
      peakDbfs: -1.0,
      trimDb: -2.0,
      trimCooldownS: 0.25,
      recoverS: 8.0,
      recoverDb: 0.5,
      recoverMarginDb: 6.0,
      recentS: 1.5,
    },
  );
  assert.equal(h.state.enabled["clip"], true);
});

test("a new job starts every channel with no clip or recovery history", () => {
  const { job } = setup();
  assert.deepEqual([...job.lastClipT.keys()], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok([...job.lastClipT.values()].every((v) => v === NEG_INF));
  assert.ok([...job.lastRecoverT.values()].every((v) => v === NEG_INF));
});

test("a peak exactly at the threshold does nothing", () => {
  const { h, job } = setup();
  job.handle(1, feat({ peakDbfs: -1 }), 10);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.recs, []);
  assert.equal(h.state.gainDb.get(1), 20);
  assert.equal(job.lastClipT.get(1), NEG_INF);
});

test("a peak just above the threshold trims the preamp and notes latency", () => {
  const { h, job } = setup();
  job.handle(1, feat({ peakDbfs: -0.99 }), 10);
  assert.deepEqual(h.mixer.calls, [{ op: "gain", ch: 1, currentDb: 20, deltaDb: -2 }]);
  assert.equal(h.state.gainDb.get(1), 18);
  assert.equal(job.lastClipT.get(1), 10);
  assert.equal(job.lastRecoverT.get(1), NEG_INF);
  assert.deepEqual(h.events, [{ kind: "clip", msg: "lead_vox near clip → preamp -2 dB → 18 dB", ch: 1 }]);
  assert.deepEqual(h.latency, ["clip"]);
  assert.deepEqual(h.recs, []);
});

test("a trim only touches the clipping channel", () => {
  const { h, job } = setup();
  job.handle(4, feat({ peakDbfs: 0 }), 3);
  assert.deepEqual(h.mixer.calls, [{ op: "gain", ch: 4, currentDb: 20, deltaDb: -2 }]);
  assert.equal(h.state.gainDb.get(4), 18);
  assert.equal(h.state.gainDb.get(1), 20);
  assert.equal(job.lastClipT.get(1), NEG_INF);
  assert.equal(h.events[0]?.msg, "acoustic_gtr near clip → preamp -2 dB → 18 dB");
});

test("the gain written to state is whatever the mixer reports back", () => {
  const h = harness();
  h.mixer.nudgeGainDb = (ch, currentDb, deltaDb) => {
    h.mixer.calls.push({ op: "gain", ch, currentDb, deltaDb });
    return 15;
  };
  const job = new ClipJob(h.ctx);
  job.handle(1, feat({ peakDbfs: 0 }), 1);
  assert.equal(h.state.gainDb.get(1), 15);
  assert.equal(h.events[0]?.msg, "lead_vox near clip → preamp -2 dB → 15 dB");
});

test("a second hot block inside the cooldown is ignored", () => {
  const { h, job } = setup();
  job.handle(1, feat({ peakDbfs: 0 }), 10);
  job.handle(1, feat({ peakDbfs: 0 }), 10.125);
  assert.equal(h.mixer.calls.length, 1);
  assert.equal(h.events.length, 1);
  assert.deepEqual(h.latency, ["clip"]);
  assert.equal(h.state.gainDb.get(1), 18);
  assert.equal(job.lastClipT.get(1), 10);
});

test("a hot block exactly one cooldown later trims again", () => {
  const { h, job } = setup();
  job.handle(1, feat({ peakDbfs: 0 }), 10);
  job.handle(1, feat({ peakDbfs: 0 }), 10.25);
  assert.deepEqual(h.mixer.calls, [
    { op: "gain", ch: 1, currentDb: 20, deltaDb: -2 },
    { op: "gain", ch: 1, currentDb: 18, deltaDb: -2 },
  ]);
  assert.equal(h.state.gainDb.get(1), 16);
  assert.equal(job.lastClipT.get(1), 10.25);
  assert.equal(h.events[1]?.msg, "lead_vox near clip → preamp -2 dB → 16 dB");
  assert.deepEqual(h.latency, ["clip", "clip"]);
});

test("coach mode recommends a trim on every hot block and never touches the mixer", () => {
  const { h, job } = setup();
  h.coach.on = true;
  job.handle(1, feat({ peakDbfs: 0.46 }), 10);
  job.handle(1, feat({ peakDbfs: 0.46 }), 10.01);
  const rec = {
    kind: "clip",
    ch: 1,
    text: "lead_vox near clip → trim its preamp/gain -2 dB.",
    persist: false,
    meta: { peak: 0.5, trim_db: -2 },
  };
  assert.deepEqual(h.recs, [rec, rec]);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.latency, []);
  assert.equal(h.state.gainDb.get(1), 20);
  assert.equal(job.lastClipT.get(1), NEG_INF);
});

test("coach mode ignores a cooldown left by an earlier real trim", () => {
  const { h, job } = setup();
  job.handle(1, feat({ peakDbfs: 0 }), 10);
  h.coach.on = true;
  job.handle(1, feat({ peakDbfs: -0.5 }), 10.01);
  assert.equal(h.recs.length, 1);
  assert.equal(h.recs[0]?.text, "lead_vox near clip → trim its preamp/gain -2 dB.");
  assert.deepEqual(h.recs[0]?.meta, { peak: -0.5, trim_db: -2 });
  assert.equal(h.mixer.calls.length, 1);
  assert.equal(job.lastClipT.get(1), 10);
});

test("coach trim advice keeps the same text as the peak moves and carries the peak only in meta", () => {
  const { h, job } = setup();
  h.coach.on = true;
  job.handle(1, feat({ peakDbfs: -0.5 }), 10);
  job.handle(1, feat({ peakDbfs: 0.83 }), 10.01);
  const text = "lead_vox near clip → trim its preamp/gain -2 dB.";
  assert.deepEqual(h.recs, [
    { kind: "clip", ch: 1, text, persist: false, meta: { peak: -0.5, trim_db: -2 } },
    { kind: "clip", ch: 1, text, persist: false, meta: { peak: 0.8, trim_db: -2 } },
  ]);
});

test("a real coach shows a moving hot peak as one coach event while refreshing the record", () => {
  const h = harness();
  const clock = new ManualClock(0, 0);
  const shown: { kind: string; msg: string; ch: number | null }[] = [];
  const coach = new Coach(h.cfg, clock, (kind, msg, ch) => shown.push({ kind, msg, ch }));
  const job = new ClipJob({ ...h.ctx, coaching: () => true, recommend: (...args) => coach.recommend(...args) });
  job.handle(1, feat({ peakDbfs: -0.5 }), 10);
  clock.advance(1);
  job.handle(1, feat({ peakDbfs: 0.2 }), 11);
  clock.advance(1);
  job.handle(1, feat({ peakDbfs: -0.9 }), 12);
  assert.deepEqual(shown, [{ kind: "coach", msg: "lead_vox near clip → trim its preamp/gain -2 dB.", ch: 1 }]);
  const recs = coach.snapshot();
  assert.equal(recs.length, 1);
  assert.equal(recs[0]?.["peak"], -0.9);
  assert.equal(recs[0]?.mono, 2);
  assert.deepEqual(h.mixer.calls, []);
});

test("a disabled clip job does nothing on hot or clean blocks", () => {
  const { h, job } = setup();
  h.state.enabled["clip"] = false;
  h.state.gainDb.set(1, 10);
  job.handle(1, feat({ peakDbfs: 3 }), 10);
  job.handle(1, feat({ peakDbfs: -60 }), 100);
  h.coach.on = true;
  job.handle(1, feat({ peakDbfs: 3 }), 200);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.recs, []);
  assert.deepEqual(h.latency, []);
  assert.equal(h.state.gainDb.get(1), 10);
});

test("a clean trimmed channel restores one recovery step and does not note latency", () => {
  const { h, job } = setup();
  h.state.gainDb.set(1, 17.5);
  job.handle(1, feat({ peakDbfs: -20 }), 100);
  assert.deepEqual(h.mixer.calls, [{ op: "gain", ch: 1, currentDb: 17.5, deltaDb: 0.5 }]);
  assert.equal(h.state.gainDb.get(1), 18);
  assert.equal(job.lastRecoverT.get(1), 100);
  assert.equal(job.lastClipT.get(1), NEG_INF);
  assert.deepEqual(h.events, [{ kind: "clip", msg: "lead_vox clean → restoring preamp → 18 dB", ch: 1 }]);
  assert.deepEqual(h.latency, []);
  assert.deepEqual(h.recs, []);
});

test("the recovery message prints a fractional restored gain with one decimal", () => {
  const { h, job } = setup();
  h.state.gainDb.set(1, 18);
  job.handle(1, feat({ peakDbfs: -20 }), 100);
  assert.equal(h.state.gainDb.get(1), 18.5);
  assert.deepEqual(h.events, [{ kind: "clip", msg: "lead_vox clean → restoring preamp → 18.5 dB", ch: 1 }]);
});

test("the trim message prints a fractional gain with one decimal", () => {
  const { h, job } = setup();
  h.state.gainDb.set(1, 18.5);
  job.handle(1, feat({ peakDbfs: 0 }), 10);
  assert.deepEqual(h.mixer.calls, [{ op: "gain", ch: 1, currentDb: 18.5, deltaDb: -2 }]);
  assert.equal(h.state.gainDb.get(1), 16.5);
  assert.deepEqual(h.events, [{ kind: "clip", msg: "lead_vox near clip → preamp -2 dB → 16.5 dB", ch: 1 }]);
});

test("the recovery step is capped at the nominal gain", () => {
  const { h, job } = setup();
  h.state.gainDb.set(1, 19.75);
  job.handle(1, feat({ peakDbfs: -20 }), 100);
  assert.deepEqual(h.mixer.calls, [{ op: "gain", ch: 1, currentDb: 19.75, deltaDb: 0.25 }]);
  assert.equal(h.state.gainDb.get(1), 20);
  assert.equal(h.events[0]?.msg, "lead_vox clean → restoring preamp → 20 dB");
});

test("a peak exactly at the recovery margin does not recover", () => {
  const { h, job } = setup();
  h.state.gainDb.set(1, 18);
  job.handle(1, feat({ peakDbfs: -7 }), 100);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
  job.handle(1, feat({ peakDbfs: -7.01 }), 100);
  assert.equal(h.mixer.calls.length, 1);
});

test("a peak between the margin and the threshold neither trims nor recovers", () => {
  const { h, job } = setup();
  h.state.gainDb.set(1, 18);
  job.handle(1, feat({ peakDbfs: -3 }), 100);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
  assert.equal(h.state.gainDb.get(1), 18);
});

test("a channel already at nominal gain is not recovered", () => {
  const { h, job } = setup();
  job.handle(1, feat({ peakDbfs: -40 }), 100);
  h.state.gainDb.set(1, 21);
  job.handle(1, feat({ peakDbfs: -40 }), 200);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
  assert.equal(job.lastRecoverT.get(1), NEG_INF);
});

test("recovery waits until strictly more than recoverS after the last trim", () => {
  const { h, job } = setup();
  job.handle(1, feat({ peakDbfs: 0 }), 10);
  job.handle(1, feat({ peakDbfs: -20 }), 18);
  assert.equal(h.mixer.calls.length, 1);
  job.handle(1, feat({ peakDbfs: -20 }), 18.5);
  assert.deepEqual(h.mixer.calls[1], { op: "gain", ch: 1, currentDb: 18, deltaDb: 0.5 });
  assert.equal(job.lastRecoverT.get(1), 18.5);
});

test("recovery waits until strictly more than recoverS after the last recovery", () => {
  const { h, job } = setup();
  h.state.gainDb.set(1, 17);
  job.handle(1, feat({ peakDbfs: -20 }), 100);
  job.handle(1, feat({ peakDbfs: -20 }), 108);
  assert.equal(h.mixer.calls.length, 1);
  job.handle(1, feat({ peakDbfs: -20 }), 108.5);
  assert.deepEqual(h.mixer.calls, [
    { op: "gain", ch: 1, currentDb: 17, deltaDb: 0.5 },
    { op: "gain", ch: 1, currentDb: 17.5, deltaDb: 0.5 },
  ]);
  assert.equal(h.state.gainDb.get(1), 18);
  assert.equal(job.lastRecoverT.get(1), 108.5);
});

test("a recent trim blocks recovery even when the last recovery is old", () => {
  const { h, job } = setup();
  h.state.gainDb.set(1, 17);
  job.lastClipT.set(1, 95);
  job.lastRecoverT.set(1, 0);
  job.handle(1, feat({ peakDbfs: -20 }), 100);
  assert.deepEqual(h.mixer.calls, []);
});

test("a recent recovery blocks recovery even when the last trim is old", () => {
  const { h, job } = setup();
  h.state.gainDb.set(1, 17);
  job.lastClipT.set(1, 0);
  job.lastRecoverT.set(1, 95);
  job.handle(1, feat({ peakDbfs: -20 }), 100);
  assert.deepEqual(h.mixer.calls, []);
});

test("coach mode advises restoring a trimmed clean channel without moving it", () => {
  const { h, job } = setup();
  h.coach.on = true;
  h.state.gainDb.set(1, 18.5);
  job.handle(1, feat({ peakDbfs: -20 }), 100);
  job.handle(1, feat({ peakDbfs: -20 }), 100.1);
  const rec = {
    kind: "clip",
    ch: 1,
    text: "lead_vox is clean but its preamp is still trimmed (18.5 dB) → you can restore it toward 20 dB.",
    persist: false,
    meta: { gain_db: 18.5, nominal_db: 20 },
  };
  assert.deepEqual(h.recs, [rec, rec]);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
  assert.equal(job.lastRecoverT.get(1), NEG_INF);
  assert.equal(h.state.gainDb.get(1), 18.5);
});

test("coach recovery advice rounds the gain to one decimal in the text and meta", () => {
  const { h, job } = setup();
  h.coach.on = true;
  h.state.gainDb.set(1, 12.34);
  h.state.nominalGain.set(1, 25);
  job.handle(1, feat({ peakDbfs: -20 }), 100);
  assert.deepEqual(h.recs[0]?.meta, { gain_db: 12.3, nominal_db: 25 });
  assert.equal(h.recs[0]?.text, "lead_vox is clean but its preamp is still trimmed (12.3 dB) → you can restore it toward 25 dB.");
});

test("coach recovery advice prints a fractional nominal gain with one decimal", () => {
  const { h, job } = setup();
  h.coach.on = true;
  h.state.gainDb.set(1, 16);
  h.state.nominalGain.set(1, 18.5);
  job.handle(1, feat({ peakDbfs: -20 }), 100);
  assert.equal(h.recs[0]?.text, "lead_vox is clean but its preamp is still trimmed (16 dB) → you can restore it toward 18.5 dB.");
  assert.deepEqual(h.recs[0]?.meta, { gain_db: 16, nominal_db: 18.5 });
});

test("an unknown channel throws on the trim, coach and recovery paths", () => {
  const { h, job } = setup();
  assert.throws(() => job.handle(99, feat({ peakDbfs: 0 }), 10), /unknown channel 99/);
  assert.throws(() => job.handle(99, feat({ peakDbfs: -20 }), 10), /unknown channel 99/);
  h.coach.on = true;
  assert.throws(() => job.handle(99, feat({ peakDbfs: 0 }), 10), /unknown channel 99/);
  assert.deepEqual(h.mixer.calls, []);
});

test("an injected clip config is honoured without touching the global config", () => {
  keepsGlobal(() => {
    const { h, job } = setup(harness({ ...tuned("clip", { peakDbfs: -6, trimDb: -3, recoverDb: 1, recoverMarginDb: 2, recoverS: 1 }) }));
    job.handle(2, feat({ peakDbfs: -5 }), 10);
    assert.deepEqual(h.mixer.calls, [{ op: "gain", ch: 2, currentDb: 20, deltaDb: -3 }]);
    assert.equal(h.events[0]?.msg, "harm_vox_l near clip → preamp -3 dB → 17 dB");
    job.handle(2, feat({ peakDbfs: -8.5 }), 11.5);
    assert.deepEqual(h.mixer.calls[1], { op: "gain", ch: 2, currentDb: 17, deltaDb: 1 });
    assert.equal(h.state.gainDb.get(2), 18);
  });
});
