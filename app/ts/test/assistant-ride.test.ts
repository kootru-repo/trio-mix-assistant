import assert from "node:assert/strict";
import test from "node:test";
import { RideJob } from "../src/core/assistant/ride.ts";
import { NEG_INF } from "../src/core/util.ts";
import { feat, globalSnapshot, harness, tuned } from "./jobhelpers.ts";
import type { Harness } from "./jobhelpers.ts";

const setup = (h: Harness = harness()): { h: Harness; job: RideJob } => ({ h, job: new RideJob(h.ctx) });

const keepsGlobal = (body: () => void): void => {
  const before = globalSnapshot();
  body();
  assert.equal(globalSnapshot(), before);
};

const ride = (job: RideJob, ch: number, rms: number, target: number, now: number, minInterval = 0, kind = "vocal"): void =>
  job.rideToward(ch, feat({ rmsDbfs: rms }), target, now, minInterval, kind);

test("the ride and limit defaults match the expected tuning", () => {
  const { h } = setup();
  assert.deepEqual(
    { ...h.cfg.ride },
    {
      leadTargetDb: -6.0,
      toleranceDb: 2.0,
      leadTargetMinDb: -40.0,
      leadTargetMaxDb: 10.0,
      maxStepDb: 1.0,
      rampMs: 350,
      ema: 1 / 24,
      minMoveDb: 0.05,
      vocalIntervalS: 0.25,
      balanceIntervalS: 1.0,
    },
  );
  assert.equal(h.cfg.limits.faderMinDb, -12);
  assert.equal(h.cfg.limits.faderMaxDb, 6);
  assert.equal(h.cfg.LEAD_VOCAL_CH, 1);
  assert.deepEqual(h.cfg.BALANCE_CHANNELS, [5, 7]);
  assert.equal(h.state.enabled["vocal_ride"], false);
  assert.equal(h.state.enabled["balance"], false);
});

test("a new job takes the lead target from config and starts with empty per channel state", () => {
  const { job } = setup();
  assert.equal(job.leadTarget, -6);
  assert.deepEqual(
    [...job.inEma.entries()],
    [1, 2, 3, 4, 5, 6, 7, 8].map((c) => [c, null]),
  );
  assert.ok([...job.lastRideT.values()].every((v) => v === NEG_INF));
  assert.equal(job.balanceTargets.size, 0);
});

test("the first block seeds the level average and later blocks smooth it", () => {
  const { h, job } = setup();
  ride(job, 1, -30, -30, 1);
  assert.equal(job.inEma.get(1), -30);
  ride(job, 1, -6, -30, 2);
  const a = 1 / 24;
  const second = (1 - a) * -30 + a * -6;
  assert.equal(job.inEma.get(1), second);
  ride(job, 1, -54, -30, 3);
  assert.equal(job.inEma.get(1), (1 - a) * second + a * -54);
  assert.equal(job.inEma.get(2), null);
  assert.deepEqual(h.mixer.calls, []);
});

test("a ride moves the fader one step, stamps times, notes latency and reports", () => {
  const { h, job } = setup();
  ride(job, 1, -30, -6, 10, 0.25, "vocal");
  assert.deepEqual(h.mixer.calls, [{ op: "ramp", ch: 1, startDb: 0, endDb: 1 }]);
  assert.equal(h.state.faderDb.get(1), 1);
  assert.equal(h.state.lastMoveT.get(1), 10);
  assert.equal(job.lastRideT.get(1), 10);
  assert.deepEqual(h.latency, ["vocal"]);
  assert.deepEqual(h.events, [{ kind: "vocal", msg: "lead_vox: out -30.0 dB vs target -6.0 → fader +0.0→+1.0 dB", ch: 1 }]);
  assert.deepEqual(h.recs, []);
});

test("a ride down is clamped to the maximum step and uses the given kind", () => {
  const { h, job } = setup();
  h.state.faderDb.set(5, 2);
  ride(job, 5, -10, -20, 4, 1, "balance");
  assert.deepEqual(h.mixer.calls, [{ op: "ramp", ch: 5, startDb: 2, endDb: 1 }]);
  assert.deepEqual(h.latency, ["balance"]);
  assert.deepEqual(h.events, [{ kind: "balance", msg: "bass_di: out -8.0 dB vs target -20.0 → fader +2.0→+1.0 dB", ch: 5 }]);
});

test("an error smaller than the maximum step moves by the error", () => {
  const { h, job } = setup();
  ride(job, 1, -8.5, -6, 10);
  assert.deepEqual(h.mixer.calls, [{ op: "ramp", ch: 1, startDb: 0, endDb: 1 }]);
  const tuneH = harness(tuned("ride", { maxStepDb: 5 }));
  const tuneJob = new RideJob(tuneH.ctx);
  ride(tuneJob, 1, -8.5, -6, 10);
  assert.deepEqual(tuneH.mixer.calls, [{ op: "ramp", ch: 1, startDb: 0, endDb: 2.5 }]);
});

test("the fader state is set from what the mixer reports back", () => {
  const h = harness();
  h.mixer.rampFaderDb = (ch, startDb, endDb) => {
    h.mixer.calls.push({ op: "ramp", ch, startDb, endDb });
    return 0.5;
  };
  const job = new RideJob(h.ctx);
  ride(job, 1, -30, -6, 10);
  assert.equal(h.state.faderDb.get(1), 0.5);
  assert.equal(h.events[0]?.msg, "lead_vox: out -30.0 dB vs target -6.0 → fader +0.0→+0.5 dB");
});

test("an error exactly at the tolerance does not move or stamp the ride time", () => {
  const { h, job } = setup();
  ride(job, 1, -8, -6, 10);
  ride(job, 2, -4, -6, 11);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
  assert.equal(job.lastRideT.get(1), NEG_INF);
  assert.equal(job.lastRideT.get(2), NEG_INF);
});

test("an error just past the tolerance moves", () => {
  const { h, job } = setup();
  ride(job, 1, -8.25, -6, 10);
  assert.deepEqual(h.mixer.calls, [{ op: "ramp", ch: 1, startDb: 0, endDb: 1 }]);
});

test("a manual hold blocks rides but still updates the level average", () => {
  const { h, job } = setup();
  h.state.manualHoldUntil.set(1, 20);
  ride(job, 1, -30, -6, 19.5);
  assert.equal(job.inEma.get(1), -30);
  assert.deepEqual(h.mixer.calls, []);
  assert.equal(job.lastRideT.get(1), NEG_INF);
  ride(job, 1, -30, -6, 20);
  assert.deepEqual(h.mixer.calls, [{ op: "ramp", ch: 1, startDb: 0, endDb: 1 }]);
});

test("a channel missing from the manual hold map is treated as not held", () => {
  const { h, job } = setup();
  h.state.manualHoldUntil.delete(1);
  ride(job, 1, -30, -6, 0);
  assert.equal(h.mixer.calls.length, 1);
});

test("the minimum interval blocks a second ride until exactly that long has passed", () => {
  const { h, job } = setup();
  ride(job, 1, -30, -6, 10, 0.25);
  ride(job, 1, -30, -6, 10.125, 0.25);
  assert.equal(h.mixer.calls.length, 1);
  assert.equal(job.lastRideT.get(1), 10);
  ride(job, 1, -30, -6, 10.25, 0.25);
  assert.deepEqual(h.mixer.calls, [
    { op: "ramp", ch: 1, startDb: 0, endDb: 1 },
    { op: "ramp", ch: 1, startDb: 1, endDb: 2 },
  ]);
  assert.equal(job.lastRideT.get(1), 10.25);
});

test("a fader believed to be out of range stamps the ride time and does nothing else", () => {
  for (const fader of [6.5, -12.5, Number.NaN]) {
    const { h, job } = setup();
    h.state.faderDb.set(1, fader);
    ride(job, 1, -30, -6, 10);
    assert.deepEqual(h.mixer.calls, []);
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.recs, []);
    assert.equal(job.lastRideT.get(1), 10);
    assert.equal(job.inEma.get(1), -30);
    assert.equal(h.state.lastMoveT.get(1), NEG_INF);
  }
});

test("a fader exactly at either limit is still ridden away from it", () => {
  const top = setup();
  top.h.state.faderDb.set(1, 6);
  ride(top.job, 1, -2, -12, 10);
  assert.deepEqual(top.h.mixer.calls, [{ op: "ramp", ch: 1, startDb: 6, endDb: 5 }]);
  const bottom = setup();
  bottom.h.state.faderDb.set(1, -12);
  ride(bottom.job, 1, -30, -6, 10);
  assert.deepEqual(bottom.h.mixer.calls, [{ op: "ramp", ch: 1, startDb: -12, endDb: -11 }]);
});

test("the new fader position is clamped to the fader limits", () => {
  const up = setup();
  up.h.state.faderDb.set(1, 5.5);
  ride(up.job, 1, -30, -6, 10);
  assert.deepEqual(up.h.mixer.calls, [{ op: "ramp", ch: 1, startDb: 5.5, endDb: 6 }]);
  const down = setup();
  down.h.state.faderDb.set(1, -11.5);
  ride(down.job, 1, 0, -30, 10);
  assert.deepEqual(down.h.mixer.calls, [{ op: "ramp", ch: 1, startDb: -11.5, endDb: -12 }]);
});

test("a move smaller than the minimum is skipped but the ride time is stamped", () => {
  const { h, job } = setup();
  h.state.faderDb.set(1, 5.96875);
  ride(job, 1, -30, -6, 10);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.latency, []);
  assert.equal(job.lastRideT.get(1), 10);
  assert.equal(h.state.lastMoveT.get(1), NEG_INF);
  const pinned = setup();
  pinned.h.state.faderDb.set(1, 6);
  ride(pinned.job, 1, -30, -6, 10);
  assert.deepEqual(pinned.h.mixer.calls, []);
  assert.equal(pinned.job.lastRideT.get(1), 10);
});

test("a move exactly at the minimum is made", () => {
  const { h, job } = setup(harness(tuned("ride", { minMoveDb: 0.5 })));
  h.state.faderDb.set(1, 5.5);
  ride(job, 1, -30, -6, 10);
  assert.deepEqual(h.mixer.calls, [{ op: "ramp", ch: 1, startDb: 5.5, endDb: 6 }]);
});

test("coach mode recommends an upward move with exact text and meta and does not ramp", () => {
  const { h, job } = setup();
  h.coach.on = true;
  ride(job, 1, -30, -6, 10, 0.25, "vocal");
  assert.deepEqual(h.recs, [
    {
      kind: "vocal",
      ch: 1,
      text: "lead_vox: output -30.0 dB vs target -6.0 → move the fader up 1.0 dB (to +1.0).",
      persist: false,
      meta: { output_db: -30, target_db: -6, delta_db: 1, to_db: 1 },
    },
  ]);
  assert.deepEqual(h.mixer.calls, []);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.latency, []);
  assert.equal(h.state.faderDb.get(1), 0);
  assert.equal(h.state.lastMoveT.get(1), NEG_INF);
  assert.equal(job.lastRideT.get(1), 10);
});

test("coach mode recommends a downward move with rounded meta", () => {
  const { h, job } = setup();
  h.coach.on = true;
  h.state.faderDb.set(7, 0.25);
  ride(job, 7, -2.04, -6.06, 3, 1, "balance");
  assert.deepEqual(h.recs, [
    {
      kind: "balance",
      ch: 7,
      text: "keys_aux: output -1.8 dB vs target -6.1 → move the fader down 1.0 dB (to -0.8).",
      persist: false,
      meta: { output_db: -1.8, target_db: -6.1, delta_db: -1, to_db: -0.8 },
    },
  ]);
  assert.deepEqual(h.mixer.calls, []);
});

test("coach mode also respects the minimum interval", () => {
  const { h, job } = setup();
  h.coach.on = true;
  ride(job, 1, -30, -6, 10, 0.25);
  ride(job, 1, -30, -6, 10.1, 0.25);
  assert.equal(h.recs.length, 1);
});

test("an unknown channel throws", () => {
  const { job } = setup();
  assert.throws(() => ride(job, 99, -30, -6, 10), /unknown channel 99/);
});

test("vocal riding does nothing while disabled", () => {
  const { h, job } = setup();
  job.handleVocal(feat({ rmsDbfs: -30 }), 10);
  assert.deepEqual(h.mixer.calls, []);
  assert.equal(job.inEma.get(1), null);
});

test("vocal riding rides the lead vocal toward the lead target on the vocal interval", () => {
  const { h, job } = setup();
  h.state.enabled["vocal_ride"] = true;
  job.handleVocal(feat({ rmsDbfs: -30 }), 10);
  job.handleVocal(feat({ rmsDbfs: -30 }), 10.125);
  job.handleVocal(feat({ rmsDbfs: -30 }), 10.25);
  assert.deepEqual(h.mixer.calls, [
    { op: "ramp", ch: 1, startDb: 0, endDb: 1 },
    { op: "ramp", ch: 1, startDb: 1, endDb: 2 },
  ]);
  assert.deepEqual(h.latency, ["vocal", "vocal"]);
  assert.equal(h.events[0]?.kind, "vocal");
});

test("vocal riding follows a changed lead target", () => {
  const { h, job } = setup();
  h.state.enabled["vocal_ride"] = true;
  job.leadTarget = -40;
  job.handleVocal(feat({ rmsDbfs: -30 }), 10);
  assert.deepEqual(h.mixer.calls, [{ op: "ramp", ch: 1, startDb: 0, endDb: -1 }]);
  assert.equal(h.events[0]?.msg, "lead_vox: out -30.0 dB vs target -40.0 → fader +0.0→-1.0 dB");
});

test("balance riding needs both the enable flag and a captured target", () => {
  const { h, job } = setup();
  job.handleBalance(5, feat({ rmsDbfs: -30 }), 10);
  h.state.enabled["balance"] = true;
  job.handleBalance(5, feat({ rmsDbfs: -30 }), 11);
  assert.equal(job.inEma.get(5), null);
  job.balanceTargets.set(5, -20);
  h.state.enabled["balance"] = false;
  job.handleBalance(5, feat({ rmsDbfs: -30 }), 12);
  assert.deepEqual(h.mixer.calls, []);
  assert.equal(job.inEma.get(5), null);
});

test("balance riding rides toward the captured target on the balance interval", () => {
  const { h, job } = setup();
  h.state.enabled["balance"] = true;
  job.balanceTargets.set(5, -20);
  job.handleBalance(5, feat({ rmsDbfs: -30 }), 10);
  job.handleBalance(5, feat({ rmsDbfs: -30 }), 10.5);
  job.handleBalance(5, feat({ rmsDbfs: -30 }), 11);
  assert.deepEqual(h.mixer.calls, [
    { op: "ramp", ch: 5, startDb: 0, endDb: 1 },
    { op: "ramp", ch: 5, startDb: 1, endDb: 2 },
  ]);
  assert.deepEqual(h.latency, ["balance", "balance"]);
  assert.equal(h.events[0]?.msg, "bass_di: out -30.0 dB vs target -20.0 → fader +0.0→+1.0 dB");
});

test("capturing balance prefers the level average, falls back to given levels and adds the fader", () => {
  const { h, job } = setup();
  job.inEma.set(5, -20);
  h.state.faderDb.set(5, 2);
  h.state.faderDb.set(7, -1.5);
  job.captureBalance(
    new Map([
      [5, -99],
      [7, -25],
    ]),
  );
  assert.deepEqual(
    [...job.balanceTargets.entries()],
    [
      [5, -18],
      [7, -26.5],
    ],
  );
  assert.deepEqual(h.events, [{ kind: "balance", msg: "captured balance targets: bass_di -18.0, keys_aux -26.5", ch: null }]);
  assert.deepEqual(h.mixer.calls, []);
});

test("capturing balance skips channels with no average and no level and replaces old targets", () => {
  const { h, job } = setup();
  job.balanceTargets.set(5, -3);
  job.balanceTargets.set(6, -4);
  job.captureBalance(new Map([[7, -10]]));
  assert.deepEqual([...job.balanceTargets.entries()], [[7, -10]]);
  job.captureBalance(new Map());
  assert.equal(job.balanceTargets.size, 0);
  assert.deepEqual(
    h.events.map((e) => e.msg),
    ["captured balance targets: keys_aux -10.0", "captured balance targets: "],
  );
});

test("capturing balance skips a configured channel the job has never tracked", () => {
  const { h, job } = setup(harness({ BALANCE_CHANNELS: [9] }));
  job.captureBalance(new Map());
  assert.equal(job.balanceTargets.size, 0);
  assert.deepEqual(h.events, [{ kind: "balance", msg: "captured balance targets: ", ch: null }]);
});

test("a captured target is then used by balance riding", () => {
  const { h, job } = setup();
  h.state.enabled["balance"] = true;
  job.captureBalance(new Map([[7, -10]]));
  job.handleBalance(7, feat({ rmsDbfs: -14 }), 10);
  assert.deepEqual(h.mixer.calls, [{ op: "ramp", ch: 7, startDb: 0, endDb: 1 }]);
});

test("an injected config is honoured without touching the global config", () => {
  keepsGlobal(() => {
    const { h, job } = setup(harness({ ...tuned("ride", { toleranceDb: 0.5 }), LEAD_VOCAL_CH: 2 }));
    h.state.enabled["vocal_ride"] = true;
    job.handleVocal(feat({ rmsDbfs: -7 }), 10);
    assert.deepEqual(h.mixer.calls, [{ op: "ramp", ch: 2, startDb: 0, endDb: 1 }]);
    assert.equal(job.inEma.get(1), null);
    assert.equal(h.events[0]?.msg, "harm_vox_l: out -7.0 dB vs target -6.0 → fader +0.0→+1.0 dB");
    const plain = setup();
    plain.h.state.enabled["vocal_ride"] = true;
    plain.job.handleVocal(feat({ rmsDbfs: -7 }), 10);
    assert.deepEqual(plain.h.mixer.calls, []);
  });
});

test("an injected lead target and limits are honoured without touching the global config", () => {
  keepsGlobal(() => {
    const over = { ...tuned("ride", { leadTargetDb: -10, maxStepDb: 3 }), ...tuned("limits", { faderMaxDb: 2 }) };
    const { h, job } = setup(harness(over));
    assert.equal(job.leadTarget, -10);
    h.state.enabled["vocal_ride"] = true;
    job.handleVocal(feat({ rmsDbfs: -30 }), 10);
    assert.deepEqual(h.mixer.calls, [{ op: "ramp", ch: 1, startDb: 0, endDb: 2 }]);
  });
});
