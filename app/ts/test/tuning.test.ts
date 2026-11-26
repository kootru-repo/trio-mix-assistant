import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { C, defaultTuning } from "../src/core/config.ts";
import { RemoteCapture } from "../src/core/capturelink.ts";
import { ManualClock } from "../src/core/clock.ts";
import { TemplateError, fromObject } from "../src/core/template.ts";
import {
  TUNABLE,
  TuningError,
  activeTuning,
  checkedOverride,
  parseOverride,
  pinDefaultTuning,
  setTuning,
  tuningLines,
  tuningTable,
} from "../src/core/tuning.ts";
import { UsageError, parseCliArgs } from "../src/host/args.ts";
import { ConfError, buildArgv, parseConf } from "../src/host/launcher.ts";

const reset = (): void => setTuning([]);

test("every tuning setting exists, has a number default and the default is inside its range", () => {
  const d = defaultTuning();
  for (const t of TUNABLE) {
    const [section, key] = t.path.split(".");
    const v: unknown = Reflect.get(Reflect.get(d, section ?? ""), key ?? "");
    assert.equal(typeof v, "number", t.path);
    assert.ok(Number(v) >= t.min && Number(v) <= t.max, `${t.path} default ${String(v)} outside ${t.min}..${t.max}`);
    if (t.int === true) assert.ok(Number.isInteger(v), t.path);
  }
  assert.equal(new Set(TUNABLE.map((t) => t.path)).size, TUNABLE.length);
});

test("the hard guardrails and structural values cannot be tuned", () => {
  for (const path of ["limits.faderMaxDb", "limits.headampMaxDb", "ride.maxStepDb", "calibration.maxCutDb", "calibration.noiseDbfs", "feedback.detectFft", "unmask.band"]) {
    assert.throws(() => parseOverride(`${path}=1`, "test"), TuningError, path);
  }
});

test("later overrides win, unset values keep their defaults, and an empty list restores every default", () => {
  try {
    setTuning([parseOverride("feedback.ringDb=10", "template"), parseOverride("feedback.ringDb=14", "show.conf"), parseOverride("clip.trimDb=-3", "show.conf")]);
    assert.equal(C.feedback.ringDb, 14);
    assert.equal(C.clip.trimDb, -3);
    assert.equal(C.feedback.notchQ, defaultTuning().feedback.notchQ);
    assert.equal(activeTuning().length, 3);
    assert.deepEqual(tuningLines(), ["feedback.ringDb = 14 (default 12, from show.conf)", "clip.trimDb = -3 (default -2, from show.conf)"]);
    reset();
    assert.deepEqual({ ...C.feedback }, { ...defaultTuning().feedback });
    assert.deepEqual(tuningLines(), []);
  } finally {
    reset();
  }
});

test("tuned sections are read-only", () => {
  try {
    setTuning([parseOverride("ride.toleranceDb=3", "test")]);
    assert.ok(Object.isFrozen(C.ride));
    assert.equal(Reflect.set(C.ride, "toleranceDb", 9), false);
    assert.equal(C.ride.toleranceDb, 3);
  } finally {
    reset();
  }
});

test("names are matched without regard to case, as show.conf upper-cases its keys", () => {
  assert.deepEqual(parseOverride("FEEDBACK.RINGDB=10", "show.conf"), { path: "feedback.ringDb", value: 10, source: "show.conf" });
});

test("unknown names, bad numbers, out-of-range and fractional whole-number values are refused", () => {
  assert.throws(() => parseOverride("feedback.ringDbb=10", "t"), /not a tuning setting/);
  assert.throws(() => parseOverride("feedback.ringDb", "t"), /section\.name=value/);
  assert.throws(() => parseOverride("feedback.ringDb=loud", "t"), /must be a number/);
  assert.throws(() => parseOverride("feedback.ringDb=99", "t"), /outside 6 to 30/);
  assert.throws(() => parseOverride("feedback.sustainBlocks=2.5", "t"), /whole number/);
  assert.throws(() => checkedOverride("clip.trimDb", Number.NaN, "t"), /must be a number/);
});

test("a merge that leaves room.quietDb above room.loudDb is refused and changes nothing", () => {
  try {
    assert.throws(() => setTuning([parseOverride("room.quietDb=-20", "t"), parseOverride("room.loudDb=-30", "t")]), /must be below/);
    assert.equal(C.room.quietDb, defaultTuning().room.quietDb);
    assert.deepEqual(activeTuning(), []);
  } finally {
    reset();
  }
});

test("the default restores after a pinned run", () => {
  try {
    setTuning([parseOverride("feedback.ringDb=20", "t")]);
    const restore = pinDefaultTuning();
    assert.equal(C.feedback.ringDb, 12);
    assert.equal(activeTuning().length, 1);
    restore();
    assert.equal(C.feedback.ringDb, 20);
  } finally {
    reset();
  }
});

test("a template's tuning block is read and checked", () => {
  const t = fromObject({ name: "Bench", tuning: { feedback: { ringDb: 10 }, clip: { peakDbfs: -2 } } });
  assert.deepEqual(t.tuning, [
    { path: "feedback.ringDb", value: 10, source: "template 'Bench'" },
    { path: "clip.peakDbfs", value: -2, source: "template 'Bench'" },
  ]);
  assert.deepEqual(fromObject({}).tuning, []);
  assert.throws(() => fromObject({ tuning: { feedback: { ringDb: 99 } } }), TemplateError);
  assert.throws(() => fromObject({ tuning: { feedback: { ringDb: "10" } } }), TemplateError);
  assert.throws(() => fromObject({ tuning: { nope: { x: 1 } } }), TemplateError);
  assert.throws(() => fromObject({ tuning: [1] }), TemplateError);
});

test("show.conf TUNE lines become --tune flags, and a bad one stops the launch", () => {
  const plan = buildArgv(parseConf("MODE=sim\nLAN=no\nTUNE.feedback.ringDb = 10\nTUNE.CLIP.TRIMDB=-3\n"), ".");
  assert.deepEqual(plan.argv.filter((a) => a.startsWith("--tune")), ["--tune=feedback.ringDb=10", "--tune=clip.trimDb=-3"]);
  assert.throws(() => buildArgv(parseConf("LAN=no\nTUNE.feedback.ringDb=99\n"), "."), ConfError);
  assert.throws(() => buildArgv(parseConf("LAN=no\nTUNE.nothing=1\n"), "."), ConfError);
});

test("--tune is parsed and checked on the command line", () => {
  const a = parseCliArgs(["--tune", "feedback.ringDb=10", "--tune=clip.trimDb=-3"]);
  assert.deepEqual(a.tune.map((o) => [o.path, o.value]), [["feedback.ringDb", 10], ["clip.trimDb", -3]]);
  assert.deepEqual(parseCliArgs([]).tune, []);
  assert.throws(() => parseCliArgs(["--tune", "feedback.ringDb=99"]), UsageError);
  assert.equal(parseCliArgs(["--list-tuning"]).listTuning, true);
  assert.match(tuningTable(), /feedback\.ringDb\s+12\s+6 to 30/);
});

test("the audio worker is sent the active tuning when capture opens, and applies it", () => {
  try {
    setTuning([parseOverride("feedback.ringDb=18", "t")]);
    const rc = new RemoteCapture({ connect: () => { throw new Error("not used"); }, clock: new ManualClock(), stamp: () => 0 });
    assert.deepEqual(rc.config().tuning, [{ path: "feedback.ringDb", value: 18, source: "t" }]);
  } finally {
    reset();
  }
  const worker = readFileSync(fileURLToPath(new URL("../src/host/audioworker.ts", import.meta.url)), "utf8");
  assert.match(worker, /setTuning\(message\.config\.tuning\)/);
});
