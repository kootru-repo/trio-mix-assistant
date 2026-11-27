import assert from "node:assert/strict";
import test from "node:test";
import { Coach } from "../src/core/assistant/coach.ts";
import { MixState, chanOf, coachKey, need, pairKey, perChannelOf, roleLabelOf, roleOf } from "../src/core/assistant/context.ts";
import type { CalibrationStep } from "../src/core/calibration.ts";
import { ManualClock } from "../src/core/clock.ts";
import { configWith } from "../src/core/config.ts";
import type { Config } from "../src/core/config.ts";
import { NEG_INF } from "../src/core/util.ts";
import { tuned } from "./jobhelpers.ts";

interface Said {
  kind: string;
  msg: string;
  ch: number | null;
}

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

function makeCoach(cfg: Config = smallConfig()): { coach: Coach; clock: ManualClock; said: Said[] } {
  const clock = new ManualClock(0, 1_700_000_000);
  const said: Said[] = [];
  const coach = new Coach(cfg, clock, (kind, msg, ch) => said.push({ kind, msg, ch }));
  return { coach, clock, said };
}

test("need returns the value for a known channel and throws for an unknown one", () => {
  const m = new Map([[2, 0]]);
  assert.equal(need(m, 2), 0);
  assert.throws(() => need(m, 4), { message: "unknown channel 4" });
});

test("perChannelOf builds one entry per configured channel with the same value", () => {
  const m = perChannelOf(smallConfig(), "x");
  assert.deepEqual(
    [...m],
    [
      [3, "x"],
      [5, "x"],
      [9, "x"],
    ],
  );
});

test("roleOf gives null for no channel and for an unknown channel and the role otherwise", () => {
  const cfg = smallConfig();
  assert.equal(roleOf(cfg, null), null);
  assert.equal(roleOf(cfg, 4), null);
  assert.equal(roleOf(cfg, 5), "stage_mic");
});

test("chanOf gives the role of a known channel and throws for an unknown one", () => {
  const cfg = smallConfig();
  assert.equal(chanOf(cfg, 9), "meas_mic");
  assert.throws(() => chanOf(cfg, 1), { message: "unknown channel 1" });
});

test("roleLabelOf falls back to the channel number for an unknown channel", () => {
  const cfg = smallConfig();
  assert.equal(roleLabelOf(cfg, 3), "lead_vox");
  assert.equal(roleLabelOf(cfg, 12), "ch12");
});

test("coachKey joins kind and channel and leaves the channel empty for none", () => {
  assert.equal(coachKey("clip", 3), "clip|3");
  assert.equal(coachKey("calibration", null), "calibration|");
  assert.equal(coachKey("clip", 0), "clip|0");
});

test("pairKey joins the two channels with a comma", () => {
  assert.equal(pairKey(3, 9), "3,9");
});

test("MixState starts every configured channel at the documented defaults", () => {
  const cfg = smallConfig();
  const s = new MixState(cfg);
  assert.deepEqual(s.enabled, cfg.DEFAULT_ENABLED);
  assert.notEqual(s.enabled, cfg.DEFAULT_ENABLED);
  assert.deepEqual(
    [...s.faderDb],
    [
      [3, 0],
      [5, 0],
      [9, 0],
    ],
  );
  assert.deepEqual(
    [...s.gainDb],
    [
      [3, 20],
      [5, 20],
      [9, 20],
    ],
  );
  assert.deepEqual(
    [...s.nominalGain],
    [
      [3, 20],
      [5, 20],
      [9, 20],
    ],
  );
  assert.deepEqual(
    [...s.lastMoveT],
    [
      [3, NEG_INF],
      [5, NEG_INF],
      [9, NEG_INF],
    ],
  );
  assert.deepEqual(
    [...s.manualHoldUntil],
    [
      [3, NEG_INF],
      [5, NEG_INF],
      [9, NEG_INF],
    ],
  );
  assert.equal(s.roomConfidence, 1);
});

test("changing a MixState enabled flag leaves the config defaults alone", () => {
  const cfg = smallConfig();
  const s = new MixState(cfg);
  s.enabled["phase"] = true;
  assert.equal(cfg.DEFAULT_ENABLED["phase"], false);
});

test("recommend stores a numbered record with the role from the config channel map and the meta fields", () => {
  const { coach, clock } = makeCoach();
  clock.advance(2.5);
  coach.recommend("clip", 3, "trim it", false, { peak: -0.5 });
  coach.recommend("feedback", null, "cut the bus", true);
  assert.deepEqual(coach.coachRecs.get("clip|3"), {
    seq: 1,
    mono: 2.5,
    persist: false,
    time: "22:13:22",
    kind: "clip",
    ch: 3,
    role: "lead_vox",
    text: "trim it",
    peak: -0.5,
  });
  assert.deepEqual(coach.coachRecs.get("feedback|"), {
    seq: 2,
    mono: 2.5,
    persist: true,
    time: "22:13:22",
    kind: "feedback",
    ch: null,
    role: null,
    text: "cut the bus",
  });
});

test("recommend defaults to a non-persistent record with no meta", () => {
  const { coach } = makeCoach();
  coach.recommend("clip", 9, "t");
  const rec = coach.coachRecs.get("clip|9");
  assert.equal(rec?.persist, false);
  assert.deepEqual(Object.keys(rec ?? {}), ["seq", "mono", "persist", "time", "kind", "ch", "role", "text"]);
  assert.equal(rec?.role, "meas_mic");
});

test("recommend gives a null role for a channel outside the config map", () => {
  const { coach } = makeCoach();
  coach.recommend("clip", 1, "t");
  assert.equal(coach.coachRecs.get("clip|1")?.role, null);
});

test("recommend uses the role from its own config, not the default map", () => {
  const { coach } = makeCoach(configWith());
  coach.recommend("clip", 3, "t");
  assert.equal(coach.coachRecs.get("clip|3")?.role, "harm_vox_r");
});

test("recommend emits a coach event only when the text for that key changes", () => {
  const { coach, said } = makeCoach();
  coach.recommend("clip", 3, "a");
  coach.recommend("clip", 3, "a");
  coach.recommend("clip", 5, "a");
  coach.recommend("clip", 3, "b");
  coach.recommend("clip", 3, "b");
  assert.deepEqual(said, [
    { kind: "coach", msg: "a", ch: 3 },
    { kind: "coach", msg: "a", ch: 5 },
    { kind: "coach", msg: "b", ch: 3 },
  ]);
  assert.equal(coach.coachRecs.get("clip|3")?.seq, 5);
  assert.equal(coach.coachLastText.get("clip|3"), "b");
});

test("a repeated recommendation still refreshes the record time and sequence", () => {
  const { coach, clock } = makeCoach();
  coach.recommend("clip", 3, "a");
  clock.advance(4);
  coach.recommend("clip", 3, "a");
  const rec = coach.coachRecs.get("clip|3");
  assert.equal(rec?.seq, 2);
  assert.equal(rec?.mono, 4);
  assert.equal(rec?.time, "22:13:24");
});

test("meta fields cannot overwrite the record's own fields", () => {
  const { coach, clock, said } = makeCoach();
  clock.advance(1);
  coach.recommend("clip", 3, "real", false, {
    seq: 99,
    mono: 500,
    persist: true,
    time: "00:00:00",
    kind: "fake",
    ch: 7,
    role: "fake_role",
    text: "fake",
    extra: 1,
  });
  assert.deepEqual(coach.coachRecs.get("clip|3"), {
    seq: 1,
    mono: 1,
    persist: false,
    time: "22:13:21",
    kind: "clip",
    ch: 3,
    role: "lead_vox",
    text: "real",
    extra: 1,
  });
  assert.deepEqual(said, [{ kind: "coach", msg: "real", ch: 3 }]);
  assert.deepEqual(coach.snapshot(9.001), []);
});

test("an explicit key lets records with the same kind and channel live side by side", () => {
  const { coach, said } = makeCoach();
  coach.recommend("phase", 3, "pair 5", true, {}, "phase|3,5");
  coach.recommend("phase", 3, "pair 9", true, {}, "phase|3,9");
  coach.recommend("phase", 3, "pair 9", true, {}, "phase|3,9");
  assert.deepEqual([...coach.coachRecs.keys()], ["phase|3,5", "phase|3,9"]);
  assert.equal(coach.coachRecs.has("phase|3"), false);
  assert.equal(coach.coachRecs.get("phase|3,5")?.text, "pair 5");
  assert.equal(coach.coachRecs.get("phase|3,9")?.text, "pair 9");
  assert.equal(coach.coachRecs.get("phase|3,9")?.ch, 3);
  assert.deepEqual(said, [
    { kind: "coach", msg: "pair 5", ch: 3 },
    { kind: "coach", msg: "pair 9", ch: 3 },
  ]);
  coach.forget("phase|3,5");
  assert.deepEqual([...coach.coachRecs.keys()], ["phase|3,9"]);
  assert.deepEqual([...coach.coachLastText.keys()], ["phase|3,9"]);
  coach.forget("phase|3");
  assert.deepEqual([...coach.coachRecs.keys()], ["phase|3,9"]);
});

test("forget drops the record and its last text so the same advice is announced again", () => {
  const { coach, said } = makeCoach();
  coach.recommend("clip", 3, "a");
  coach.recommend("clip", 5, "a");
  coach.forget("clip|3");
  assert.deepEqual([...coach.coachRecs.keys()], ["clip|5"]);
  assert.deepEqual([...coach.coachLastText.keys()], ["clip|5"]);
  coach.recommend("clip", 3, "a");
  assert.equal(said.length, 3);
});

test("forget of an unknown key changes nothing", () => {
  const { coach } = makeCoach();
  coach.recommend("clip", 3, "a");
  coach.forget("nope|");
  assert.equal(coach.coachRecs.size, 1);
  assert.equal(coach.coachLastText.size, 1);
});

test("clear drops every record and every last text", () => {
  const { coach, said } = makeCoach();
  coach.recommend("clip", 3, "a");
  coach.recommend("phase", 5, "b", true);
  coach.clear();
  assert.equal(coach.coachRecs.size, 0);
  assert.equal(coach.coachLastText.size, 0);
  coach.recommend("clip", 3, "a");
  assert.equal(said.length, 3);
});

test("snapshot keeps a non-persistent record exactly at the time limit and drops it just after", () => {
  const { coach } = makeCoach();
  coach.recommend("clip", 3, "a");
  assert.equal(coach.snapshot(8).length, 1);
  assert.equal(coach.coachRecs.size, 1);
  assert.deepEqual(coach.snapshot(8.001), []);
  assert.equal(coach.coachRecs.size, 0);
  assert.equal(coach.coachLastText.size, 0);
});

test("snapshot never drops a persistent record", () => {
  const { coach } = makeCoach();
  coach.recommend("calibration", null, "keep", true);
  const live = coach.snapshot(1e6);
  assert.equal(live.length, 1);
  assert.equal(live[0]?.text, "keep");
});

test("snapshot uses the configured time limit", () => {
  const { coach } = makeCoach(configWith(tuned("coach", { ttlS: 2 })));
  coach.recommend("clip", 3, "a");
  assert.equal(coach.snapshot(2).length, 1);
  assert.equal(coach.snapshot(2.5).length, 0);
});

test("snapshot defaults to the clock time when no time is given", () => {
  const { coach, clock } = makeCoach();
  coach.recommend("clip", 3, "a");
  clock.advance(8);
  assert.equal(coach.snapshot().length, 1);
  clock.advance(0.5);
  assert.equal(coach.snapshot().length, 0);
});

test("snapshot returns live records newest first", () => {
  const { coach, clock } = makeCoach();
  coach.recommend("clip", 3, "old");
  clock.advance(5);
  coach.recommend("phase", 3, "mid", true);
  coach.recommend("clip", 5, "new");
  coach.recommend("clip", 3, "old again");
  assert.deepEqual(
    coach.snapshot(5).map((r) => r.text),
    ["old again", "new", "mid"],
  );
});

test("an expired record announces the same advice again after it is dropped", () => {
  const { coach, said } = makeCoach();
  coach.recommend("clip", 3, "a");
  coach.snapshot(20);
  coach.recommend("clip", 3, "a");
  assert.equal(said.length, 2);
});

test("calibration with no steps advises leaving the main bus flat", () => {
  const { coach, said } = makeCoach();
  coach.calibration([]);
  const rec = coach.coachRecs.get("calibration|");
  assert.equal(rec?.text, "Room measured — no problem peaks; leave the main bus flat.");
  assert.equal(rec?.persist, true);
  assert.equal(rec?.ch, null);
  assert.equal(rec?.role, null);
  assert.deepEqual(rec?.["steps"], []);
  assert.deepEqual(said, [{ kind: "coach", msg: "Room measured — no problem peaks; leave the main bus flat.", ch: null }]);
});

test("calibration lists each band and marks the non-room steps as pre-dips", () => {
  const { coach } = makeCoach();
  const steps: CalibrationStep[] = [
    { band: 1, hz: 123.456, gain: -3, q: 3, kind: "room" },
    { band: 2, hz: 2512.04, gain: -4.25, q: 6.4, kind: "predip", excess: 7 },
  ];
  coach.calibration(steps);
  const rec = coach.coachRecs.get("calibration|");
  assert.equal(rec?.text, "Room calibration → set MAIN-BUS PEQ: band 1 123 Hz -3.0 dB (Q 3); band 2 2512 Hz -4.2 dB (Q 6) pre-dip.");
  assert.equal(rec?.persist, true);
  assert.deepEqual(rec?.["steps"], [
    { band: 1, hz: 123.5, gain: -3, q: 3, kind: "room" },
    { band: 2, hz: 2512, gain: -4.25, q: 6.4, kind: "predip" },
  ]);
});

test("calibration shows a positive gain with a plus sign", () => {
  const { coach } = makeCoach();
  coach.calibration([{ band: 3, hz: 1000, gain: 1.5, q: 2, kind: "room" }]);
  assert.equal(coach.coachRecs.get("calibration|")?.text, "Room calibration → set MAIN-BUS PEQ: band 3 1000 Hz +1.5 dB (Q 2).");
});

test("a later calibration replaces the earlier one under the same key", () => {
  const { coach, said } = makeCoach();
  coach.calibration([]);
  coach.calibration([{ band: 1, hz: 100, gain: -2, q: 3, kind: "room" }]);
  assert.equal(coach.coachRecs.size, 1);
  assert.equal(coach.coachRecs.get("calibration|")?.seq, 2);
  assert.equal(said.length, 2);
});
