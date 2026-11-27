import assert from "node:assert/strict";
import test from "node:test";
import { FeedbackJob } from "../src/core/assistant/feedback.ts";
import type { CalibrationResult } from "../src/core/calibration.ts";
import type { Config } from "../src/core/config.ts";
import { feat, globalSnapshot, harness, tuned } from "./jobhelpers.ts";
import type { Harness } from "./jobhelpers.ts";

interface Rig {
  h: Harness;
  job: FeedbackJob;
}

const it = (name: string, over: Partial<Config>, fn: (r: Rig) => void): void => {
  test(name, () => {
    const before = globalSnapshot();
    const h = harness(over);
    const job = new FeedbackJob(h.ctx);
    fn({ h, job });
    assert.equal(globalSnapshot(), before);
  });
};

const climb = (job: FeedbackJob, ch: number, n: number, hz: number, startDb = -60): void => {
  for (let i = 0; i < n; i++) job.handle(ch, feat({ fbFreq: hz, rmsDbfs: startDb + i }));
};

const streak = (job: FeedbackJob, ch: number): number | undefined => job.fbStreak.get(ch);

const calib = (freqs: number[]): CalibrationResult => ({
  baseline: new Map(),
  corrections: [],
  watchlist: freqs.map((f): [number, number] => [f, 3]),
});

it("the default feedback tuning matches the documented values", {}, ({ h }) => {
  const f = h.cfg.feedback;
  assert.deepEqual(
    [f.sustainBlocks, f.stableTol, f.riseDb, f.harmonicSustain, f.watchTol, f.lowConf, f.confFloor, f.notchGainDb, f.notchQ],
    [4, 0.03, 0.3, 3, 0.06, 0.7, 0.3, -9, 8],
  );
  assert.equal(h.cfg.MEAS_MIC_CH, 8);
  assert.equal(h.cfg.CHANNEL_EQ_BANDS, 4);
  assert.equal(h.cfg.BUS_EQ_BANDS, 6);
  assert.equal(h.cfg.unmask.band, 4);
});

it("a new job starts with empty per-channel counters for every mapped channel", {}, ({ job }) => {
  assert.deepEqual([...job.fbStreak.keys()], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok([...job.fbStreak.values()].every((v) => v === 0));
  assert.ok([...job.usedNotchBand.values()].every((v) => v === 0));
  assert.ok([...job.fbLastFreq.values()].every((v) => v === null));
  assert.ok([...job.fbLastLevel.values()].every((v) => v === -90));
  assert.equal(job.usedBusNotchBand, 0);
  assert.deepEqual(job.fbBusBands, []);
  assert.deepEqual([...job.calBusBands], []);
  assert.deepEqual(job.watchFreqs, []);
  assert.deepEqual(job.venueWatchFreqs, []);
});

it("the first block of a tone is not stable so no streak builds", {}, ({ job }) => {
  job.handle(1, feat({ fbFreq: 1000, rmsDbfs: -20 }));
  assert.equal(streak(job, 1), 0);
  assert.equal(job.fbLastFreq.get(1), 1000);
  assert.equal(job.fbLastLevel.get(1), -20);
});

it("a stable and rising tone adds one to the streak per block", {}, ({ job }) => {
  climb(job, 1, 3, 1000);
  assert.equal(streak(job, 1), 2);
});

it("a steady tone that is not rising never builds a streak", {}, ({ h, job }) => {
  for (let i = 0; i < 10; i++) job.handle(1, feat({ fbFreq: 1000, rmsDbfs: -30 }));
  assert.equal(streak(job, 1), 0);
  assert.deepEqual(h.mixer.calls, []);
});

it("a level rise of exactly riseDb does not count as rising", {}, ({ job }) => {
  job.handle(1, feat({ fbFreq: 1000, rmsDbfs: -40 }));
  job.handle(1, feat({ fbFreq: 1000, rmsDbfs: -39.7 }));
  assert.equal(streak(job, 1), 0);
  job.handle(1, feat({ fbFreq: 1000, rmsDbfs: -39.3 }));
  assert.equal(streak(job, 1), 1);
});

it("a frequency drift of exactly stableTol is not stable while a smaller one is", {}, ({ job }) => {
  job.handle(1, feat({ fbFreq: 970, rmsDbfs: -40 }));
  job.handle(1, feat({ fbFreq: 1000, rmsDbfs: -30 }));
  assert.equal(streak(job, 1), 0);
  job.handle(1, feat({ fbFreq: 1029, rmsDbfs: -20 }));
  assert.equal(streak(job, 1), 1);
});

it("a block that is stable but not rising lowers the streak by one", {}, ({ job }) => {
  climb(job, 1, 4, 1000);
  assert.equal(streak(job, 1), 3);
  job.handle(1, feat({ fbFreq: 1000, rmsDbfs: -80 }));
  assert.equal(streak(job, 1), 2);
});

it("a rising block at a new frequency lowers the streak by one", {}, ({ job }) => {
  climb(job, 1, 3, 1000);
  job.handle(1, feat({ fbFreq: 2000, rmsDbfs: 0 }));
  assert.equal(streak(job, 1), 1);
});

it("a rising block after a downward frequency jump is not stable", {}, ({ job }) => {
  climb(job, 1, 3, 1000);
  job.handle(1, feat({ fbFreq: 500, rmsDbfs: 0 }));
  assert.equal(streak(job, 1), 1);
});

it("frequency drift is measured against the new frequency", {}, ({ job }) => {
  job.handle(1, feat({ fbFreq: 1000, rmsDbfs: -40 }));
  job.handle(1, feat({ fbFreq: 1030, rmsDbfs: -30 }));
  assert.equal(streak(job, 1), 1);
});

it("a falling block at a new frequency never notches even when the required count drops below the decayed streak", {}, ({ h, job }) => {
  for (let i = 0; i < 6; i++) job.handle(1, feat({ fbFreq: 1000, rmsDbfs: -60 + i, harmonicity: 1 }));
  assert.deepEqual(h.mixer.calls, []);
  assert.equal(streak(job, 1), 5);
  job.handle(1, feat({ fbFreq: 3000, rmsDbfs: -80, harmonicity: 0 }));
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
  assert.equal(streak(job, 1), 4);
  job.handle(1, feat({ fbFreq: 3000, rmsDbfs: -70, harmonicity: 0 }));
  assert.deepEqual(h.mixer.calls, [{ op: "notch", ch: 1, band: 1, hz: 3000 }]);
  assert.equal(streak(job, 1), 0);
});

it("a stable block that is not rising never notches even with the streak at the required count", {}, ({ h, job }) => {
  for (let i = 0; i < 6; i++) job.handle(1, feat({ fbFreq: 1000, rmsDbfs: -60 + i, harmonicity: 1 }));
  job.handle(1, feat({ fbFreq: 1000, rmsDbfs: -80, harmonicity: 0 }));
  assert.deepEqual(h.mixer.calls, []);
  assert.equal(streak(job, 1), 4);
});

it("blocks with no feedback frequency decay the streak and never go below zero", {}, ({ job }) => {
  climb(job, 1, 3, 1000);
  job.handle(1, feat({ rmsDbfs: -50 }));
  assert.equal(streak(job, 1), 1);
  assert.equal(job.fbLastFreq.get(1), null);
  assert.equal(job.fbLastLevel.get(1), -50);
  job.handle(1, feat({ fbFreq: 0, rmsDbfs: -45 }));
  assert.equal(streak(job, 1), 0);
  assert.equal(job.fbLastLevel.get(1), -45);
  job.handle(1, feat());
  assert.equal(streak(job, 1), 0);
});

it("after a gap the next tone block is not stable because the last frequency was cleared", {}, ({ job }) => {
  climb(job, 1, 3, 1000);
  job.handle(1, feat({ rmsDbfs: -90 }));
  job.handle(1, feat({ fbFreq: 1000, rmsDbfs: 0 }));
  assert.equal(streak(job, 1), 0);
});

it("a channel notch fires on exactly sustainBlocks rising blocks after the first", {}, ({ h, job }) => {
  climb(job, 1, 4, 1000);
  assert.deepEqual(h.mixer.calls, []);
  assert.equal(streak(job, 1), 3);
  job.handle(1, feat({ fbFreq: 1000, rmsDbfs: 0 }));
  assert.deepEqual(h.mixer.calls, [{ op: "notch", ch: 1, band: 1, hz: 1000 }]);
  assert.deepEqual(h.events, [{ kind: "feedback", msg: "1000 Hz on lead_vox → notch band 1", ch: 1 }]);
  assert.deepEqual(h.latency, ["feedback"]);
  assert.deepEqual(h.recs, []);
  assert.equal(streak(job, 1), 0);
  assert.equal(job.usedNotchBand.get(1), 1);
  assert.equal(job.fbLastFreq.get(1), 1000);
  assert.equal(job.fbLastLevel.get(1), 0);
});

it("the notch frequency is passed unrounded while the message rounds it", {}, ({ h, job }) => {
  climb(job, 2, 5, 1234.56);
  assert.deepEqual(h.mixer.calls, [{ op: "notch", ch: 2, band: 1, hz: 1234.56 }]);
  assert.deepEqual(h.events, [{ kind: "feedback", msg: "1235 Hz on harm_vox_l → notch band 1", ch: 2 }]);
});

it("disabled feedback never notches and resets the channel's streak, frequency and level", {}, ({ h, job }) => {
  climb(job, 1, 4, 1000);
  assert.equal(streak(job, 1), 3);
  h.state.enabled["feedback"] = false;
  job.handle(1, feat({ fbFreq: 1000, rmsDbfs: -12 }));
  assert.equal(streak(job, 1), 0);
  assert.equal(job.fbLastFreq.get(1), null);
  assert.equal(job.fbLastLevel.get(1), -12);
  climb(job, 1, 10, 1000);
  assert.equal(streak(job, 1), 0);
  assert.equal(job.fbLastFreq.get(1), null);
  assert.equal(job.fbLastLevel.get(1), -51);
  job.handle(1, feat());
  assert.equal(job.fbLastLevel.get(1), -30);
  assert.throws(() => job.handle(99, feat({ fbFreq: 1000 })), /^Error: unknown channel 99$/);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.recs, []);
  assert.deepEqual(h.latency, []);
  h.state.enabled["feedback"] = true;
  job.handle(1, feat({ fbFreq: 1000, rmsDbfs: 0 }));
  assert.equal(streak(job, 1), 0);
});

it("an unknown channel throws for both tone and silent blocks", {}, ({ job }) => {
  assert.throws(() => job.handle(99, feat({ fbFreq: 1000 })), /^Error: unknown channel 99$/);
  assert.throws(() => job.handle(42, feat()), /^Error: unknown channel 42$/);
});

it("a tone near a calibration watch frequency needs one block fewer and is flagged", {}, ({ h, job }) => {
  job.setCalibration(calib([1020]));
  climb(job, 1, 4, 1000);
  assert.deepEqual(h.mixer.calls, [{ op: "notch", ch: 1, band: 1, hz: 1000 }]);
  assert.deepEqual(h.events, [{ kind: "feedback", msg: "1000 Hz on lead_vox → notch band 1 [watch-list]", ch: 1 }]);
});

it("a tone near a venue watch frequency needs one block fewer", {}, ({ h, job }) => {
  job.venueWatchFreqs = [1000];
  climb(job, 1, 3, 1000);
  assert.deepEqual(h.mixer.calls, []);
  job.handle(1, feat({ fbFreq: 1000, rmsDbfs: 0 }));
  assert.deepEqual(h.mixer.calls, [{ op: "notch", ch: 1, band: 1, hz: 1000 }]);
  assert.match(h.events[0]?.msg ?? "", /\[watch-list\]$/);
});

it("a tone exactly watchTol away from a watch frequency is not near it", {}, ({ h, job }) => {
  job.venueWatchFreqs = [1000];
  assert.equal(job.isNearWatch(1060), false);
  assert.equal(job.isNearWatch(1059), true);
  assert.equal(job.isNearWatch(940), false);
  assert.equal(job.isNearWatch(941), true);
  climb(job, 1, 4, 1060);
  assert.deepEqual(h.mixer.calls, []);
  job.handle(1, feat({ fbFreq: 1060, rmsDbfs: 0 }));
  assert.deepEqual(h.events, [{ kind: "feedback", msg: "1060 Hz on lead_vox → notch band 1", ch: 1 }]);
});

it("isNearWatch honours an explicit tolerance and ignores zero watch entries", {}, ({ job }) => {
  job.venueWatchFreqs = [0, 1000];
  assert.equal(job.isNearWatch(1100), false);
  assert.equal(job.isNearWatch(1100, 0.11), true);
  assert.equal(job.isNearWatch(0.001, 1e9), true);
  job.venueWatchFreqs = [0];
  assert.equal(job.isNearWatch(0.001, 1e9), false);
});

it("isNearWatch is false with no watch frequencies", {}, ({ job }) => {
  assert.equal(job.isNearWatch(1000), false);
});

it("setCalibration loads watch frequencies and null clears them", {}, ({ job }) => {
  job.setCalibration(calib([250, 3150]));
  assert.deepEqual(job.watchFreqs, [250, 3150]);
  assert.equal(job.isNearWatch(3100), true);
  job.setCalibration(null);
  assert.deepEqual(job.watchFreqs, []);
  assert.equal(job.isNearWatch(3100), false);
});

it("a watch-list tone never needs fewer than one block", tuned("feedback", { sustainBlocks: 1 }), ({ h, job }) => {
  job.venueWatchFreqs = [1000];
  job.handle(1, feat({ fbFreq: 1000, rmsDbfs: -40 }));
  assert.deepEqual(h.mixer.calls, []);
  job.handle(1, feat({ fbFreq: 1000, rmsDbfs: -30 }));
  assert.deepEqual(h.mixer.calls, [{ op: "notch", ch: 1, band: 1, hz: 1000 }]);
});

it("harmonicity adds harmonicity times harmonicSustain rounded half to even", {}, ({ h, job }) => {
  for (let i = 0; i < 6; i++) job.handle(1, feat({ fbFreq: 1000, rmsDbfs: -60 + i, harmonicity: 0.5 }));
  assert.deepEqual(h.mixer.calls, []);
  assert.equal(streak(job, 1), 5);
  job.handle(1, feat({ fbFreq: 1000, rmsDbfs: 0, harmonicity: 0.5 }));
  assert.deepEqual(h.mixer.calls, [{ op: "notch", ch: 1, band: 1, hz: 1000 }]);
});

it("a harmonic extra of exactly two and a half rounds down to two", tuned("feedback", { harmonicSustain: 5 }), ({ h, job }) => {
  for (let i = 0; i < 6; i++) job.handle(1, feat({ fbFreq: 1000, rmsDbfs: -60 + i, harmonicity: 0.5 }));
  assert.deepEqual(h.mixer.calls, []);
  job.handle(1, feat({ fbFreq: 1000, rmsDbfs: 0, harmonicity: 0.5 }));
  assert.deepEqual(h.mixer.calls, [{ op: "notch", ch: 1, band: 1, hz: 1000 }]);
});

it("a harmonic extra of exactly a half rounds down to zero", tuned("feedback", { harmonicSustain: 1 }), ({ h, job }) => {
  for (let i = 0; i < 5; i++) job.handle(1, feat({ fbFreq: 1000, rmsDbfs: -60 + i, harmonicity: 0.5 }));
  assert.deepEqual(h.mixer.calls, [{ op: "notch", ch: 1, band: 1, hz: 1000 }]);
});

it("zero or negative harmonicity adds nothing", {}, ({ h, job }) => {
  for (let i = 0; i < 5; i++) job.handle(1, feat({ fbFreq: 1000, rmsDbfs: -60 + i, harmonicity: -1 }));
  for (let i = 0; i < 5; i++) job.handle(2, feat({ fbFreq: 1000, rmsDbfs: -60 + i, harmonicity: 0 }));
  assert.deepEqual(h.mixer.calls, [
    { op: "notch", ch: 1, band: 1, hz: 1000 },
    { op: "notch", ch: 2, band: 1, hz: 1000 },
  ]);
});

it("missing harmonicity is treated as zero", {}, ({ h, job }) => {
  for (let i = 0; i < 5; i++) {
    const f = feat({ fbFreq: 1000, rmsDbfs: -60 + i });
    Reflect.deleteProperty(f, "harmonicity");
    job.handle(1, f);
  }
  assert.deepEqual(h.mixer.calls, [{ op: "notch", ch: 1, band: 1, hz: 1000 }]);
});

it("low room confidence on the measurement mic raises the block count", {}, ({ h, job }) => {
  h.state.roomConfidence = 0.5;
  climb(job, 8, 8, 1000);
  assert.deepEqual(h.mixer.calls, []);
  assert.equal(streak(job, 8), 7);
  job.handle(8, feat({ fbFreq: 1000, rmsDbfs: 0 }));
  assert.deepEqual(h.mixer.calls, [{ op: "busEq", band: 1, hz: 1000, gainDb: -9, q: 8 }]);
});

it("very low room confidence is clamped at confFloor", {}, ({ h, job }) => {
  h.state.roomConfidence = 0.05;
  climb(job, 8, 13, 1000);
  assert.deepEqual(h.mixer.calls, []);
  job.handle(8, feat({ fbFreq: 1000, rmsDbfs: 10 }));
  assert.deepEqual(h.mixer.calls, [{ op: "busEq", band: 1, hz: 1000, gainDb: -9, q: 8 }]);
});

it("room confidence exactly at lowConf does not raise the block count", {}, ({ h, job }) => {
  h.state.roomConfidence = 0.7;
  climb(job, 8, 5, 1000);
  assert.deepEqual(h.mixer.calls, [{ op: "busEq", band: 1, hz: 1000, gainDb: -9, q: 8 }]);
});

it("low room confidence does not affect channels other than the measurement mic", {}, ({ h, job }) => {
  h.state.roomConfidence = 0.1;
  climb(job, 1, 5, 1000);
  assert.deepEqual(h.mixer.calls, [{ op: "notch", ch: 1, band: 1, hz: 1000 }]);
});

it("the confidence scaling rounds half to even", tuned("feedback", { sustainBlocks: 5 }), ({ h, job }) => {
  h.state.roomConfidence = 0.4;
  climb(job, 8, 13, 1000);
  assert.deepEqual(h.mixer.calls, [{ op: "busEq", band: 1, hz: 1000, gainDb: -9, q: 8 }]);
  assert.equal(streak(job, 8), 0);
});

it("the confidence scaling never lowers the block count below the unscaled one", tuned("feedback", { confFloor: 2 }), ({ h, job }) => {
  h.state.roomConfidence = 0.5;
  climb(job, 8, 4, 1000);
  assert.deepEqual(h.mixer.calls, []);
  job.handle(8, feat({ fbFreq: 1000, rmsDbfs: 0 }));
  assert.deepEqual(h.mixer.calls, [{ op: "busEq", band: 1, hz: 1000, gainDb: -9, q: 8 }]);
});

it("a measurement mic notch goes to the main bus and is recorded", {}, ({ h, job }) => {
  climb(job, 8, 5, 812.4);
  assert.deepEqual(h.mixer.calls, [{ op: "busEq", band: 1, hz: 812.4, gainDb: -9, q: 8 }]);
  assert.deepEqual(h.events, [{ kind: "feedback", msg: "812 Hz on meas_mic → main-bus band 1", ch: 8 }]);
  assert.deepEqual(h.latency, ["feedback"]);
  assert.deepEqual(job.fbBusBands, [1]);
  assert.equal(job.usedBusNotchBand, 1);
  assert.equal(streak(job, 8), 0);
  assert.equal(job.usedNotchBand.get(8), 0);
});

it("main-bus notches take the next free band skipping calibration bands", {}, ({ h, job }) => {
  job.calBusBands = new Set([1, 3]);
  climb(job, 8, 5, 1000);
  climb(job, 8, 5, 2000);
  climb(job, 8, 5, 3000);
  assert.deepEqual(
    h.mixer.calls.map((c) => (c.op === "busEq" ? c.band : -1)),
    [2, 4, 5],
  );
  assert.deepEqual(job.fbBusBands, [2, 4, 5]);
  assert.equal(job.usedBusNotchBand, 3);
});

it("main-bus notches reuse their own bands in turn once every band is claimed", {}, ({ h, job }) => {
  job.calBusBands = new Set([1, 2, 3, 4]);
  for (const hz of [1000, 2000, 3000, 4000, 5000]) climb(job, 8, 5, hz);
  assert.deepEqual(
    h.mixer.calls.map((c) => (c.op === "busEq" ? [c.band, c.hz] : [])),
    [
      [5, 1000],
      [6, 2000],
      [5, 3000],
      [6, 4000],
      [5, 5000],
    ],
  );
  assert.deepEqual(job.fbBusBands, [5, 6]);
  assert.equal(job.usedBusNotchBand, 5);
});

it("allocBusBand cycles its own unclaimed bands by the bus notch counter", {}, ({ job }) => {
  job.calBusBands = new Set([1, 2, 3, 4, 5, 6]);
  assert.equal(job.allocBusBand(), -1);
  job.calBusBands = new Set([1, 3, 4]);
  job.fbBusBands = [2, 5, 6];
  job.usedBusNotchBand = 4;
  assert.equal(job.allocBusBand(), 5);
  job.usedBusNotchBand = 3;
  assert.equal(job.allocBusBand(), 2);
  job.calBusBands = new Set([1, 3, 4, 5]);
  assert.equal(job.allocBusBand(), 6);
  job.calBusBands = new Set([1, 2, 3, 4, 5, 6]);
  assert.equal(job.allocBusBand(), -1);
  job.calBusBands = new Set([1]);
  assert.equal(job.allocBusBand(), 3);
});

it("allocBusBand uses the taken list and counter it is given", {}, ({ job }) => {
  job.calBusBands = new Set([1, 3, 4]);
  job.fbBusBands = [2, 5, 6];
  job.usedBusNotchBand = 0;
  assert.equal(job.allocBusBand([2, 5, 6], 1), 5);
  assert.equal(job.allocBusBand([2], 0), 5);
  assert.equal(job.allocBusBand([], 7), 2);
  assert.deepEqual(job.fbBusBands, [2, 5, 6]);
  assert.equal(job.usedBusNotchBand, 0);
});

it("a band calibration claimed later is never recycled", {}, ({ h, job }) => {
  job.calBusBands = new Set([1, 2, 3, 4]);
  climb(job, 8, 5, 1000);
  climb(job, 8, 5, 2000);
  assert.deepEqual(job.fbBusBands, [5, 6]);
  job.calBusBands.add(5);
  climb(job, 8, 5, 3000);
  climb(job, 8, 5, 4000);
  assert.deepEqual(
    h.mixer.calls.map((c) => (c.op === "busEq" ? [c.band, c.hz] : [])),
    [
      [5, 1000],
      [6, 2000],
      [6, 3000],
      [6, 4000],
    ],
  );
  job.calBusBands.add(6);
  h.events.length = 0;
  climb(job, 8, 5, 5000);
  assert.equal(h.mixer.calls.length, 4);
  assert.deepEqual(h.events, [{ kind: "system", msg: "no free main-bus band for a feedback notch", ch: null }]);
  assert.equal(job.usedBusNotchBand, 4);
});

it("with no free main-bus band the job reports it and resets the streak", {}, ({ h, job }) => {
  job.calBusBands = new Set([1, 2, 3, 4, 5, 6]);
  climb(job, 8, 5, 1000);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, [{ kind: "system", msg: "no free main-bus band for a feedback notch", ch: null }]);
  assert.deepEqual(h.latency, []);
  assert.deepEqual(h.recs, []);
  assert.equal(streak(job, 8), 0);
  assert.equal(job.usedBusNotchBand, 0);
  assert.equal(job.fbLastFreq.get(8), 1000);
});

it("with no free main-bus band coach mode reports it instead of recommending", {}, ({ h, job }) => {
  h.coach.on = true;
  job.calBusBands = new Set([1, 2, 3, 4, 5, 6]);
  climb(job, 8, 5, 1000);
  assert.deepEqual(h.recs, []);
  assert.deepEqual(h.events, [{ kind: "system", msg: "no free main-bus band for a feedback notch", ch: null }]);
});

it("a watch-list measurement mic notch is flagged", {}, ({ h, job }) => {
  job.setCalibration(calib([1000]));
  climb(job, 8, 4, 1000);
  assert.deepEqual(h.events, [{ kind: "feedback", msg: "1000 Hz on meas_mic → main-bus band 1 [watch-list]", ch: 8 }]);
});

it("coach mode on the measurement mic recommends a main-bus cut and touches nothing", {}, ({ h, job }) => {
  h.coach.on = true;
  job.calBusBands = new Set([1]);
  climb(job, 8, 5, 1234.56);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.latency, []);
  assert.deepEqual(h.recs, [
    {
      kind: "feedback",
      ch: 8,
      text: "Feedback 1235 Hz in the room → cut the MAIN BUS at 1235 Hz by -9 dB (Q 8); e.g. main PEQ band 2.",
      persist: false,
      meta: { freq: 1234.6, gain_db: -9, q: 8, target: "main-bus", band: 2 },
    },
  ]);
  assert.deepEqual(job.fbBusBands, []);
  assert.equal(job.usedBusNotchBand, 0);
  assert.deepEqual(job.coachBusBands, [2]);
  assert.equal(job.coachBusUsed, 1);
  assert.equal(streak(job, 8), 0);
});

it("coach mode on the measurement mic cycles bands with its own counters", {}, ({ h, job }) => {
  h.coach.on = true;
  job.calBusBands = new Set([1, 2, 3, 4]);
  for (const hz of [1000, 2000, 3000, 4000]) climb(job, 8, 5, hz);
  assert.deepEqual(
    h.recs.map((r) => r.meta["band"]),
    [5, 6, 5, 6],
  );
  assert.deepEqual(job.coachBusBands, [5, 6]);
  assert.equal(job.coachBusUsed, 4);
  assert.deepEqual(job.fbBusBands, []);
  assert.equal(job.usedBusNotchBand, 0);
  assert.deepEqual(h.mixer.calls, []);
  h.coach.on = false;
  climb(job, 8, 5, 5000);
  assert.deepEqual(h.mixer.calls, [{ op: "busEq", band: 5, hz: 5000, gainDb: -9, q: 8 }]);
  assert.deepEqual(job.fbBusBands, [5]);
  assert.equal(job.usedBusNotchBand, 1);
  assert.equal(job.coachBusUsed, 4);
});

it("coach mode on the measurement mic flags watch-list tones", {}, ({ h, job }) => {
  h.coach.on = true;
  job.venueWatchFreqs = [1000];
  climb(job, 8, 4, 1000);
  assert.equal(
    h.recs[0]?.text,
    "Feedback 1000 Hz in the room → cut the MAIN BUS at 1000 Hz by -9 dB (Q 8); e.g. main PEQ band 1. [watch-list]",
  );
});

it("coach mode on a channel recommends an input notch and touches nothing", {}, ({ h, job }) => {
  h.coach.on = true;
  climb(job, 3, 5, 2500.04);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.latency, []);
  assert.deepEqual(h.recs, [
    {
      kind: "feedback",
      ch: 3,
      text: "Feedback 2500 Hz on harm_vox_r → notch input EQ band 1 at 2500 Hz, -9 dB (Q 8).",
      persist: false,
      meta: { freq: 2500, gain_db: -9, q: 8, target: "ch3", band: 1 },
    },
  ]);
  assert.equal(job.usedNotchBand.get(3), 0);
  assert.equal(job.coachNotchBand.get(3), 1);
  assert.equal(streak(job, 3), 0);
});

it("coach mode on a channel flags watch-list tones and cycles bands with its own counter", {}, ({ h, job }) => {
  h.coach.on = true;
  job.venueWatchFreqs = [1000];
  climb(job, 1, 4, 1000);
  climb(job, 1, 4, 1000, 0);
  assert.equal(h.recs.length, 2);
  assert.equal(h.recs[0]?.text, "Feedback 1000 Hz on lead_vox → notch input EQ band 1 at 1000 Hz, -9 dB (Q 8). [watch-list]");
  assert.deepEqual(h.recs[1]?.meta, { freq: 1000, gain_db: -9, q: 8, target: "ch1", band: 2 });
  assert.equal(job.coachNotchBand.get(1), 2);
  assert.equal(job.usedNotchBand.get(1), 0);
  for (const hz of [2000, 3000, 4000]) climb(job, 1, 5, hz);
  assert.deepEqual(
    h.recs.map((r) => r.meta["band"]),
    [1, 2, 3, 4, 1],
  );
  assert.deepEqual(h.mixer.calls, []);
  h.coach.on = false;
  climb(job, 1, 5, 5000);
  assert.deepEqual(h.mixer.calls, [{ op: "notch", ch: 1, band: 1, hz: 5000 }]);
  assert.equal(job.coachNotchBand.get(1), 1);
});

it("coach text rounds the configured gain and Q half to even", tuned("feedback", { notchGainDb: -6.5, notchQ: 4.5 }), ({ h, job }) => {
  h.coach.on = true;
  climb(job, 8, 5, 1000);
  climb(job, 1, 5, 1000);
  assert.deepEqual(
    h.recs.map((r) => r.text),
    [
      "Feedback 1000 Hz in the room → cut the MAIN BUS at 1000 Hz by -6 dB (Q 4); e.g. main PEQ band 1.",
      "Feedback 1000 Hz on lead_vox → notch input EQ band 1 at 1000 Hz, -6 dB (Q 4).",
    ],
  );
  assert.deepEqual(h.recs[0]?.meta, { freq: 1000, gain_db: -6.5, q: 4.5, target: "main-bus", band: 1 });
});

it("main-bus notches use the configured gain and Q", tuned("feedback", { notchGainDb: -12, notchQ: 10 }), ({ h, job }) => {
  climb(job, 8, 5, 1000);
  assert.deepEqual(h.mixer.calls, [{ op: "busEq", band: 1, hz: 1000, gainDb: -12, q: 10 }]);
});

it("channel notches cycle through bands one to four", {}, ({ h, job }) => {
  for (const hz of [1000, 2000, 3000, 4000, 5000]) climb(job, 1, 5, hz);
  assert.deepEqual(
    h.mixer.calls.map((c) => (c.op === "notch" ? [c.band, c.hz] : [])),
    [
      [1, 1000],
      [2, 2000],
      [3, 3000],
      [4, 4000],
      [1, 5000],
    ],
  );
  assert.equal(job.usedNotchBand.get(1), 1);
  assert.deepEqual(h.latency, ["feedback", "feedback", "feedback", "feedback", "feedback"]);
});

it("channel notches skip the unmask band when the unmask job is enabled", {}, ({ h, job }) => {
  h.state.enabled["unmask"] = true;
  for (const hz of [1000, 2000, 3000, 4000, 5000]) climb(job, 1, 5, hz);
  assert.deepEqual(
    h.mixer.calls.map((c) => (c.op === "notch" ? c.band : -1)),
    [1, 2, 3, 1, 2],
  );
  assert.deepEqual(
    h.events.map((e) => e.msg),
    [
      "1000 Hz on lead_vox → notch band 1",
      "2000 Hz on lead_vox → notch band 2",
      "3000 Hz on lead_vox → notch band 3",
      "4000 Hz on lead_vox → notch band 1",
      "5000 Hz on lead_vox → notch band 2",
    ],
  );
});

it("a mid-range unmask band is skipped to the next band", tuned("unmask", { band: 2 }), ({ h, job }) => {
  h.state.enabled["unmask"] = true;
  for (const hz of [1000, 2000, 3000]) climb(job, 1, 5, hz);
  assert.deepEqual(
    h.mixer.calls.map((c) => (c.op === "notch" ? c.band : -1)),
    [1, 3, 4],
  );
});

it("coach mode also skips the unmask band in its suggestion", {}, ({ h, job }) => {
  h.coach.on = true;
  h.state.enabled["unmask"] = true;
  job.coachNotchBand.set(1, 3);
  climb(job, 1, 5, 1000);
  assert.equal(h.recs[0]?.meta["band"], 1);
  assert.equal(job.usedNotchBand.get(1), 0);
});

it("with a single channel EQ band the unmask band is never skipped", { CHANNEL_EQ_BANDS: 1, ...tuned("unmask", { band: 1 }) }, ({
  h,
  job,
}) => {
  h.state.enabled["unmask"] = true;
  for (const hz of [1000, 2000]) climb(job, 1, 5, hz);
  assert.deepEqual(h.mixer.calls, [
    { op: "notch", ch: 1, band: 1, hz: 1000 },
    { op: "notch", ch: 1, band: 1, hz: 2000 },
  ]);
});

it("each channel keeps its own streak and notch band", {}, ({ h, job }) => {
  climb(job, 1, 5, 1000);
  climb(job, 2, 3, 2000);
  climb(job, 1, 5, 1500);
  assert.equal(streak(job, 2), 2);
  assert.deepEqual(h.mixer.calls, [
    { op: "notch", ch: 1, band: 1, hz: 1000 },
    { op: "notch", ch: 1, band: 2, hz: 1500 },
  ]);
  assert.equal(job.usedNotchBand.get(2), 0);
});

it("resetNotches clears only used channels, flattens used bus bands and resets every counter", {}, ({ h, job }) => {
  climb(job, 1, 5, 1000);
  climb(job, 3, 5, 1000);
  climb(job, 8, 5, 1000);
  climb(job, 8, 5, 2000);
  climb(job, 2, 3, 1000);
  climb(job, 3, 3, 1000, 20);
  h.coach.on = true;
  climb(job, 4, 5, 1000);
  climb(job, 8, 5, 3000);
  h.coach.on = false;
  assert.equal(streak(job, 2), 2);
  assert.equal(job.coachNotchBand.get(4), 1);
  assert.deepEqual(job.coachBusBands, [3]);
  assert.equal(job.coachBusUsed, 1);
  h.mixer.calls = [];
  h.events.length = 0;
  job.resetNotches();
  assert.deepEqual(h.mixer.calls, [
    { op: "clearEq", ch: 1 },
    { op: "clearEq", ch: 3 },
    { op: "busEq", band: 1, hz: 1000, gainDb: 0, q: 2 },
    { op: "busEq", band: 2, hz: 1000, gainDb: 0, q: 2 },
  ]);
  assert.deepEqual(h.events, [{ kind: "system", msg: "cleared 4 parked notch(es)", ch: null }]);
  assert.equal(job.usedNotchBand.get(1), 0);
  assert.equal(job.usedNotchBand.get(3), 0);
  assert.equal(job.usedNotchBand.get(4), 0);
  assert.ok([...job.fbStreak.values()].every((v) => v === 0));
  assert.ok([...job.coachNotchBand.values()].every((v) => v === 0));
  assert.deepEqual(job.fbBusBands, []);
  assert.equal(job.usedBusNotchBand, 0);
  assert.deepEqual(job.coachBusBands, []);
  assert.equal(job.coachBusUsed, 0);
});

it("resetNotches keeps calibration bus bands claimed", {}, ({ h, job }) => {
  job.calBusBands = new Set([1]);
  climb(job, 8, 5, 1000);
  job.resetNotches();
  assert.deepEqual([...job.calBusBands], [1]);
  climb(job, 8, 5, 1000);
  assert.deepEqual(h.mixer.calls.at(-1), { op: "busEq", band: 2, hz: 1000, gainDb: -9, q: 8 });
});

it("resetNotches with nothing parked reports zero and touches nothing", {}, ({ h, job }) => {
  job.resetNotches();
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, [{ kind: "system", msg: "cleared 0 parked notch(es)", ch: null }]);
});

it("resetNotches uses the configured flat frequency and Q", { EQ_FLAT_FREQ: 750, EQ_FLAT_Q: 1.5 }, ({ h, job }) => {
  climb(job, 8, 5, 1000);
  h.mixer.calls = [];
  job.resetNotches();
  assert.deepEqual(h.mixer.calls, [{ op: "busEq", band: 1, hz: 750, gainDb: 0, q: 1.5 }]);
});

it("an injected channel map, measurement mic and tuning are honoured without touching the global config", {
  CHANNELS: new Map([
    [3, "a"],
    [9, "meas_mic"],
  ]),
  MEAS_MIC_CH: 9,
  ...tuned("feedback", { sustainBlocks: 2 }),
}, ({ h, job }) => {
  assert.deepEqual([...job.fbStreak.keys()], [3, 9]);
  climb(job, 3, 3, 1000);
  climb(job, 9, 3, 2000);
  assert.deepEqual(h.mixer.calls, [
    { op: "notch", ch: 3, band: 1, hz: 1000 },
    { op: "busEq", band: 1, hz: 2000, gainDb: -9, q: 8 },
  ]);
  assert.deepEqual(
    h.events.map((e) => e.msg),
    ["1000 Hz on a → notch band 1", "2000 Hz on meas_mic → main-bus band 1"],
  );
  assert.throws(() => job.handle(1, feat({ fbFreq: 1000 })), /unknown channel 1/);
  assert.throws(() => job.handle(8, feat()), /unknown channel 8/);
  job.resetNotches();
  assert.deepEqual(h.mixer.calls.slice(2), [
    { op: "clearEq", ch: 3 },
    { op: "busEq", band: 1, hz: 1000, gainDb: 0, q: 2 },
  ]);
});

it("a custom bus and channel band count is honoured", { BUS_EQ_BANDS: 2, CHANNEL_EQ_BANDS: 2 }, ({ h, job }) => {
  for (const hz of [1000, 2000, 3000]) climb(job, 8, 5, hz);
  for (const hz of [1000, 2000, 3000]) climb(job, 1, 5, hz);
  assert.deepEqual(
    h.mixer.calls.map((c) => (c.op === "busEq" || c.op === "notch" ? `${c.op}${c.band}` : "")),
    ["busEq1", "busEq2", "busEq1", "notch1", "notch2", "notch1"],
  );
});

it("coach advice on a channel continues after the band a real notch already used", {}, ({ h, job }) => {
  climb(job, 4, 5, 1000);
  assert.equal(job.usedNotchBand.get(4), 1);
  h.coach.on = true;
  climb(job, 4, 5, 2000);
  assert.equal(job.coachNotchBand.get(4), 2);
  assert.equal(h.recs.at(-1)?.meta["band"], 2);
  assert.equal(job.usedNotchBand.get(4), 1);
});

it("coach advice on the main bus skips bands that hold real notches", {}, ({ h, job }) => {
  climb(job, 8, 5, 1000);
  climb(job, 8, 5, 2000);
  assert.deepEqual(job.fbBusBands, [1, 2]);
  h.coach.on = true;
  climb(job, 8, 5, 3000);
  assert.equal(h.recs.at(-1)?.meta["band"], 3);
  assert.deepEqual(job.fbBusBands, [1, 2]);
});
