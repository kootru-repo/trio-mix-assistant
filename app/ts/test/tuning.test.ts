import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { defaultConfig, defaultTuning } from "../src/core/config.ts";
import { RemoteCapture } from "../src/core/capturelink.ts";
import { ManualClock } from "../src/core/clock.ts";
import { TemplateError, fromObject } from "../src/core/template.ts";
import { TUNABLE, TuningError, checkedOverride, parseOverride, tuningLines, tuningTable, withTuning } from "../src/core/tuning.ts";
import { UsageError, parseCliArgs } from "../src/host/args.ts";
import { ConfError, buildArgv, parseConf } from "../src/host/launcher.ts";

const testCfg = defaultConfig();

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
  for (const path of [
    "limits.faderMaxDb",
    "limits.headampMaxDb",
    "ride.maxStepDb",
    "calibration.maxCutDb",
    "calibration.noiseDbfs",
    "feedback.detectFft",
    "unmask.band",
  ]) {
    assert.throws(() => parseOverride(`${path}=1`, "test"), TuningError, path);
  }
});

test("later overrides win, unset values keep their defaults, and an empty list keeps every default", () => {
  const base = defaultConfig();
  const cfg = withTuning(base, [
    parseOverride("feedback.ringDb=10", "template"),
    parseOverride("feedback.ringDb=14", "show.conf"),
    parseOverride("clip.trimDb=-3", "show.conf"),
  ]);
  assert.equal(cfg.feedback.ringDb, 14);
  assert.equal(cfg.clip.trimDb, -3);
  assert.equal(cfg.feedback.notchQ, defaultTuning().feedback.notchQ);
  assert.equal(cfg.TUNED.length, 3);
  assert.deepEqual(tuningLines(cfg.TUNED), [
    "feedback.ringDb = 14 (default 12, from show.conf)",
    "clip.trimDb = -3 (default -2, from show.conf)",
  ]);
  assert.deepEqual({ ...base.feedback }, { ...defaultTuning().feedback });
  assert.deepEqual(base.TUNED, []);
  const plain = withTuning(base, []);
  assert.deepEqual({ ...plain.feedback }, { ...defaultTuning().feedback });
  assert.deepEqual(tuningLines(plain.TUNED), []);
});

test("tuned sections are read-only", () => {
  const cfg = withTuning(defaultConfig(), [parseOverride("ride.toleranceDb=3", "test")]);
  assert.ok(Object.isFrozen(cfg.ride));
  assert.ok(Object.isFrozen(cfg.room));
  assert.equal(Reflect.set(cfg.ride, "toleranceDb", 9), false);
  assert.equal(cfg.ride.toleranceDb, 3);
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
  const base = defaultConfig();
  assert.throws(() => withTuning(base, [parseOverride("room.quietDb=-20", "t"), parseOverride("room.loudDb=-30", "t")]), /must be below/);
  assert.equal(base.room.quietDb, defaultTuning().room.quietDb);
  assert.deepEqual(base.TUNED, []);
});

test("tuning builds a new config on top of its base and never changes the base", () => {
  const base = defaultConfig();
  base.CHANNELS = new Map([
    [1, "lead_vox"],
    [2, "meas_mic"],
  ]);
  const first = withTuning(base, [parseOverride("feedback.ringDb=20", "show.conf")]);
  const second = withTuning(first, [parseOverride("clip.trimDb=-3", "--tune")]);
  assert.notEqual(first, base);
  assert.equal(base.feedback.ringDb, 12);
  assert.equal(first.clip.trimDb, -2);
  assert.equal(second.feedback.ringDb, 20);
  assert.equal(second.clip.trimDb, -3);
  assert.deepEqual(
    second.TUNED.map((o) => o.path),
    ["feedback.ringDb", "clip.trimDb"],
  );
  assert.equal(first.TUNED.length, 1);
  assert.deepEqual([...second.CHANNELS.keys()], [1, 2]);
});

test("a template's tuning block is read and checked", () => {
  const t = fromObject({ name: "Bench", tuning: { feedback: { ringDb: 10 }, clip: { peakDbfs: -2 } } }, testCfg);
  assert.deepEqual(t.tuning, [
    { path: "feedback.ringDb", value: 10, source: "template 'Bench'" },
    { path: "clip.peakDbfs", value: -2, source: "template 'Bench'" },
  ]);
  assert.deepEqual(fromObject({}, testCfg).tuning, []);
  assert.throws(() => fromObject({ tuning: { feedback: { ringDb: 99 } } }, testCfg), TemplateError);
  assert.throws(() => fromObject({ tuning: { feedback: { ringDb: "10" } } }, testCfg), TemplateError);
  assert.throws(() => fromObject({ tuning: { nope: { x: 1 } } }, testCfg), TemplateError);
  assert.throws(() => fromObject({ tuning: [1] }, testCfg), TemplateError);
});

test("show.conf TUNE lines become --tune flags, and a bad one stops the launch", () => {
  const plan = buildArgv(parseConf("MODE=sim\nLAN=no\nTUNE.feedback.ringDb = 10\nTUNE.CLIP.TRIMDB=-3\n"), ".");
  assert.deepEqual(
    plan.argv.filter((a) => a.startsWith("--tune")),
    ["--tune=feedback.ringDb=10", "--tune=clip.trimDb=-3"],
  );
  assert.throws(() => buildArgv(parseConf("LAN=no\nTUNE.feedback.ringDb=99\n"), "."), ConfError);
  assert.throws(() => buildArgv(parseConf("LAN=no\nTUNE.nothing=1\n"), "."), ConfError);
});

test("--tune is parsed and checked on the command line", () => {
  const a = parseCliArgs(["--tune", "feedback.ringDb=10", "--tune=clip.trimDb=-3"]);
  assert.deepEqual(
    a.tune.map((o) => [o.path, o.value]),
    [
      ["feedback.ringDb", 10],
      ["clip.trimDb", -3],
    ],
  );
  assert.deepEqual(parseCliArgs([]).tune, []);
  assert.throws(() => parseCliArgs(["--tune", "feedback.ringDb=99"]), UsageError);
  assert.equal(parseCliArgs(["--list-tuning"]).listTuning, true);
  assert.match(tuningTable(), /feedback\.ringDb\s+12\s+6 to 30/);
});

test("the audio worker is sent its config's tuning when capture opens, in its analysis settings, and never writes the shared settings", () => {
  const cfg = withTuning(defaultConfig(), [parseOverride("feedback.ringDb=18", "t")]);
  const rc = new RemoteCapture({
    connect: () => {
      throw new Error("not used");
    },
    clock: new ManualClock(),
    stamp: () => 0,
    cfg,
  });
  assert.deepEqual(rc.config().tuning, [{ path: "feedback.ringDb", value: 18, source: "t" }]);
  assert.equal(rc.config().analysis.ringDb, 18);
  const worker = readFileSync(fileURLToPath(new URL("../src/host/audioworker.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(worker, /setTuning|withTuning|\bC\b/);
});
