import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysedBlock } from "../src/core/blockanalysis.ts";
import { CaptureSourceBase } from "../src/core/capture.ts";
import type { Frame } from "../src/core/capture.ts";
import { C } from "../src/core/config.ts";
import { ConsoleBase, SimConsole, dbToFader, faderToDb } from "../src/core/console.ts";
import { emptyFeatures } from "../src/core/dsp.ts";
import type { ChannelFeatures } from "../src/core/dsp.ts";
import type { Alert } from "../src/core/engine/base.ts";
import { Engine } from "../src/core/engine/index.ts";
import { oscFloat, oscInt } from "../src/core/oscwire.ts";
import type { OscArg } from "../src/core/oscwire.ts";
import type { MeterReceiverPort } from "../src/core/ports.ts";
import { StepClock } from "./stepclock.ts";

class QuietSource extends CaptureSourceBase {
  block(): Frame {
    return new Map();
  }
}

class RampConsole extends SimConsole {
  override rampFaderDb(ch: number, startDb: number, endDb: number, ms?: number, steps?: number): number {
    return ConsoleBase.prototype.rampFaderDb.call(this, ch, startDb, endDb, ms, steps);
  }
}

interface Rig {
  e: Engine;
  clock: StepClock;
  con: SimConsole;
}

interface Desk {
  fader: number;
  gain: number;
  inverted: ReadonlySet<number>;
}

const DESK: Desk = { fader: -10, gain: 35, inverted: new Set([3]) };

const FADER = /^\/ch\/(\d\d)\/mix\/fader$/;
const GAIN = /^\/headamp\/(\d\d\d)\/gain$/;
const INVERT = /^\/ch\/(\d\d)\/preamp\/invert$/;

const isRead = (address: string): boolean => FADER.test(address) || GAIN.test(address) || INVERT.test(address);

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

const deskAddresses = (): string[] =>
  [...C.CHANNELS.keys()].flatMap((ch) => [`/ch/${pad(ch, 2)}/mix/fader`, `/headamp/${pad(ch - 1, 3)}/gain`, `/ch/${pad(ch, 2)}/preamp/invert`]);

const quietReceiver = (): MeterReceiverPort => ({ start: () => Promise.resolve(), stop: () => undefined });

const makeRig = async (opts: { console?: SimConsole; rx?: MeterReceiverPort | null } = {}): Promise<Rig> => {
  const clock = new StepClock(100, 1_700_000_000);
  const con = opts.console ?? new SimConsole();
  const e = new Engine({ clock, sim: false, console: con, source: new QuietSource(), tick: 0.05 });
  e.meterRx = opts.rx === undefined ? quietReceiver() : opts.rx;
  await e.start();
  return { e, clock, con };
};

const readsSince = (con: SimConsole, from: number): string[] =>
  con.wireLog.slice(from).filter((w) => w.length === 1 && isRead(w[0])).map((w) => w[0]);

const countSent = (con: SimConsole, address: string, from = 0): number =>
  con.wireLog.slice(from).filter((w) => w.length === 1 && w[0] === address).length;

const writesTo = (con: SimConsole, address: string, from = 0): OscArg[] =>
  con.wireLog
    .slice(from)
    .filter((w) => w[0] === address && w.length > 1)
    .map((w) => w[1])
    .filter((a): a is OscArg => a !== undefined);

const floatOf = (a: OscArg | undefined): number => {
  assert.ok(a !== undefined && a.t === "f");
  return a.v;
};

const reply = (e: Engine, address: string, desk: Desk): void => {
  e.consoleHeard();
  const f = FADER.exec(address);
  if (f !== null) {
    const pos = dbToFader(desk.fader);
    e.consoleParam(address, [oscFloat(pos)]);
    e.reconcileFader(Number(f[1]), faderToDb(pos));
    return;
  }
  if (GAIN.test(address)) {
    e.consoleParam(address, [oscFloat((desk.gain + 12) / 72)]);
    return;
  }
  const i = INVERT.exec(address);
  if (i !== null) e.consoleParam(address, [oscInt(desk.inverted.has(Number(i[1])) ? 1 : 0)]);
};

const answerReads = (r: Rig, from: number, desk: Desk = DESK, skip: readonly string[] = []): number => {
  const asked = [...new Set(readsSince(r.con, from))].filter((a) => !skip.includes(a));
  for (const a of asked) reply(r.e, a, desk);
  return asked.length;
};

const drive = async (r: Rig, seconds: number, heard: boolean): Promise<void> => {
  const n = Math.round(seconds / 0.1);
  for (let i = 0; i < n; i++) {
    if (heard) r.e.consoleHeard();
    await r.clock.advance(0.1);
  }
};

const armedRig = async (opts: { console?: SimConsole } = {}): Promise<Rig> => {
  const r = await makeRig(opts);
  assert.equal(answerReads(r, 0), deskAddresses().length);
  await drive(r, 1.3, true);
  assert.equal(r.e.held, false);
  return r;
};

const msgs = (e: Engine): string[] => e.events.map((ev) => ev.msg);

const count = (e: Engine, prefix: string): number => msgs(e).filter((m) => m.startsWith(prefix)).length;

const noErrors = (e: Engine): void => {
  assert.deepEqual(msgs(e).filter((m) => m.startsWith("engine error")), []);
};

const isAlert = (x: unknown): x is Alert =>
  typeof x === "object" && x !== null && "level" in x && "msg" in x && typeof x.level === "string" && typeof x.msg === "string";

const alertsOf = (e: Engine): Alert[] => {
  const a = e.snapshot()["alerts"];
  assert.ok(Array.isArray(a));
  return a.filter(isAlert);
};

const holdOf = (e: Engine): unknown => e.snapshot()["hold"];

const block = (feats: ReadonlyArray<[number, Partial<ChannelFeatures>]>): AnalysedBlock => ({
  feats: new Map(feats.map(([ch, f]) => [ch, { ...emptyFeatures(), ...f }])),
  phases: [],
});

const clipBlock = (ch: number): AnalysedBlock => block([[ch, { rmsDbfs: -6, peakDbfs: -0.2 }]]);

const gainOf = (e: Engine, ch: number): number => {
  const g = e.assistant.gainDb.get(ch);
  assert.ok(g !== undefined);
  return g;
};

const near = (actual: number | undefined, expected: number, tol = 1e-6): void => {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < tol, `expected ${expected}, got ${String(actual)}`);
};

test("a hardware-style engine starts held for unsynced and reads every fader, preamp gain and polarity", async () => {
  const r = await makeRig();
  try {
    assert.equal(r.e.held, true);
    assert.deepEqual(holdOf(r.e), { held: true, reasons: ["unsynced"] });
    assert.deepEqual(new Set(readsSince(r.con, 0)), new Set(deskAddresses()));
    assert.equal(readsSince(r.con, 0).length, 24);
    assert.ok(readsSince(r.con, 0).includes("/headamp/000/gain"));
    assert.ok(readsSince(r.con, 0).includes("/headamp/007/gain"));
    assert.ok(msgs(r.e).some((m) => m.startsWith("automatic jobs on hold: reading the desk's faders")));
    const alerts = alertsOf(r.e);
    assert.ok(alerts.some((a) => a.level === "warn" && a.msg.startsWith("jobs on hold — reading the desk")));
    assert.equal(r.e.snapshot()["op_mode"], "alert");
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("while held a clipping block writes nothing, and once re-armed it trims from the adopted gain", async () => {
  const r = await makeRig();
  try {
    const from = r.con.wireLog.length;
    r.e.onPushedBlock(clipBlock(2), 0);
    assert.deepEqual(writesTo(r.con, "/headamp/001/gain", from), []);
    assert.equal(gainOf(r.e, 2), 20);
    answerReads(r, 0);
    await drive(r, 1.3, true);
    assert.equal(r.e.held, false);
    assert.deepEqual(holdOf(r.e), { held: false, reasons: [] });
    assert.equal(count(r.e, "automatic jobs re-armed"), 1);
    const before = r.con.wireLog.length;
    r.e.onPushedBlock(clipBlock(2), 0);
    near(gainOf(r.e, 2), 33);
    const writes = writesTo(r.con, "/headamp/001/gain", before);
    assert.equal(writes.length, 1);
    near(floatOf(writes[0]), 45 / 72);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("the first desk read alone does not re-arm the jobs until the console link has been steady for steadyS", async () => {
  const r = await makeRig();
  try {
    answerReads(r, 0);
    await drive(r, 0.3, true);
    assert.equal(r.e.held, true, "re-armed after a read with the link heard for only 0.3 s (steadyS is 1 s)");
    await drive(r, 1.0, true);
    assert.equal(r.e.held, false);
  } finally {
    await r.e.stop();
  }
});

test("the desk read is adopted as fader, gain, nominal gain and polarity, and a later read updates gain but not nominal gain", async () => {
  const r = await makeRig();
  try {
    const a = r.e.assistant;
    a.polarity.set(5, true);
    answerReads(r, 0);
    await drive(r, 1.3, true);
    for (const ch of C.CHANNELS.keys()) {
      near(a.faderDb.get(ch), -10);
      near(a.gainDb.get(ch), 35);
      near(a.nominalGain.get(ch), 35);
      assert.equal(a.polarity.get(ch), ch === 3);
    }
    assert.ok(msgs(r.e).includes("read the desk: faders, preamp gains and polarity adopted"));
    const from = r.con.wireLog.length;
    r.e.recallSceneManual(4);
    assert.equal(r.e.held, true);
    answerReads(r, from, { fader: -5, gain: 30, inverted: new Set() });
    await drive(r, 0.3, true);
    assert.equal(r.e.held, false);
    for (const ch of C.CHANNELS.keys()) {
      near(a.faderDb.get(ch), -5);
      near(a.gainDb.get(ch), 30);
      near(a.nominalGain.get(ch), 35);
      assert.equal(a.polarity.get(ch), false);
    }
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("fader replies during the desk read do not count as hand moves", async () => {
  const r = await makeRig();
  try {
    answerReads(r, 0);
    await drive(r, 1.3, true);
    const now = r.clock.monotonic();
    for (const ch of C.CHANNELS.keys()) assert.ok((r.e.assistant.manualHoldUntil.get(ch) ?? -1e9) < now, `ch${ch} got a manual hold`);
    assert.equal(msgs(r.e).filter((m) => m.includes("moved on console")).length, 0);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("a fader reply that completes the desk read does not count as a hand move", async () => {
  const r = await makeRig();
  try {
    const late = "/ch/03/mix/fader";
    answerReads(r, 0, DESK, [late]);
    await drive(r, 0.6, true);
    assert.ok(countSent(r.con, late) >= 2);
    reply(r.e, late, DESK);
    await drive(r, 0.3, true);
    const now = r.clock.monotonic();
    near(r.e.assistant.faderDb.get(3), -10);
    assert.deepEqual(msgs(r.e).filter((m) => m.includes("moved on console")), []);
    assert.ok((r.e.assistant.manualHoldUntil.get(3) ?? -1e9) < now, "the final fader reply of the read put ch3 on a manual hold");
  } finally {
    await r.e.stop();
  }
});

test("silence puts the jobs on hold for link, logs the link as down, and re-arms only after the desk is read again", async () => {
  const r = await armedRig();
  try {
    await drive(r, 1.7, false);
    assert.equal(r.e.held, true);
    assert.deepEqual(holdOf(r.e), { held: true, reasons: ["link"] });
    assert.equal(count(r.e, "automatic jobs on hold: the console link went quiet"), 1);
    const quiet = r.con.wireLog.length;
    r.e.onPushedBlock(clipBlock(2), 0);
    assert.deepEqual(writesTo(r.con, "/headamp/001/gain", quiet), []);
    near(gainOf(r.e, 2), 35);
    await drive(r, 3.6, false);
    assert.equal(count(r.e, "console link lost"), 1);
    const from = r.con.wireLog.length;
    await drive(r, 0.5, true);
    assert.deepEqual(readsSince(r.con, from), []);
    assert.equal(r.e.held, true);
    await drive(r, 0.8, true);
    assert.equal(count(r.e, "console link back — reading the desk again"), 1);
    assert.deepEqual(new Set(readsSince(r.con, from)), new Set(deskAddresses()));
    const h = r.e.snapshot()["hold"];
    assert.ok(typeof h === "object" && h !== null && "reasons" in h && Array.isArray(h.reasons));
    assert.deepEqual([...h.reasons].sort(), ["link", "unsynced"]);
    await drive(r, 0.6, true);
    assert.equal(r.e.held, true);
    assert.equal(count(r.e, "automatic jobs re-armed"), 1);
    answerReads(r, from, { fader: -10, gain: 30, inverted: new Set() });
    await drive(r, 0.2, true);
    assert.equal(r.e.held, false);
    assert.equal(count(r.e, "automatic jobs re-armed"), 2);
    r.e.onPushedBlock(clipBlock(2), 0);
    near(gainOf(r.e, 2), 28);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("going on hold cancels fader ramps that are in flight", async () => {
  const clock = new StepClock(100, 1_700_000_000);
  const con = new RampConsole({ clock });
  const e = new Engine({ clock, sim: false, console: con, source: new QuietSource(), tick: 0.05 });
  e.meterRx = quietReceiver();
  await e.start();
  const rig: Rig = { e, clock, con };
  try {
    answerReads(rig, 0);
    await drive(rig, 1.3, true);
    assert.equal(e.held, false);
    const steady = con.wireLog.length;
    con.rampFaderDb(3, 0, -10, 1000, 10);
    await drive(rig, 1.5, true);
    assert.equal(writesTo(con, "/ch/03/mix/fader", steady).length, 10);
    near(con.faderDb.get(3), -10);
    await drive(rig, 1.0, false);
    const from = con.wireLog.length;
    con.rampFaderDb(4, 0, -10, 2000, 20);
    await drive(rig, 3.0, false);
    assert.equal(e.held, true);
    const written = writesTo(con, "/ch/04/mix/fader", from).length;
    assert.ok(written > 0 && written < 20, `ramp wrote ${written} of 20 steps`);
    const last = con.faderDb.get(4);
    assert.ok(last !== undefined && last > -9.5, `ramp reached ${String(last)}`);
    noErrors(e);
  } finally {
    await e.stop();
  }
});

test("a channel ducked before the hold is flattened again when the jobs re-arm", async () => {
  const r = await armedRig();
  try {
    r.e.setEnabled("unmask", true);
    for (let i = 0; i < 10; i++) r.e.onPushedBlock(block([[1, { rmsDbfs: -10, peakDbfs: -8 }]]), 0);
    const ducked = r.con.eqBands.get(2)?.get(C.unmask.band)?.gainDb;
    assert.ok(ducked !== undefined && ducked < 0);
    assert.ok(r.e.assistant.duckApplied.size > 0);
    await drive(r, 1.7, false);
    assert.equal(r.e.held, true);
    const from = r.con.wireLog.length;
    await drive(r, 1.3, true);
    answerReads(r, from);
    const rearm = r.con.wireLog.length;
    await drive(r, 0.2, true);
    assert.equal(r.e.held, false);
    for (const ch of [2, 3, 4, 5, 6, 7]) {
      const g = writesTo(r.con, `/ch/${pad(ch, 2)}/eq/${C.unmask.band}/g`, rearm);
      assert.equal(g.length, 1, `ch${ch} was not flattened on re-arm`);
      near(floatOf(g[0]), 0.5);
    }
    for (const ch of [1, 8]) assert.deepEqual(writesTo(r.con, `/ch/${pad(ch, 2)}/eq/${C.unmask.band}/g`, rearm), []);
    assert.equal(r.e.assistant.duckApplied.size, 0);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("feedback streaks and last frequencies are cleared when the jobs re-arm", async () => {
  const r = await armedRig();
  try {
    for (const rms of [-30, -29, -28]) r.e.onPushedBlock(block([[2, { rmsDbfs: rms, peakDbfs: -20, fbFreq: 1000 }]]), 0);
    assert.ok((r.e.assistant.fbStreak.get(2) ?? 0) >= 1);
    assert.equal(r.e.assistant.feedback.fbLastFreq.get(2), 1000);
    const from = r.con.wireLog.length;
    r.e.recallSceneManual(2);
    assert.equal(r.e.held, true);
    assert.ok((r.e.assistant.fbStreak.get(2) ?? 0) >= 1);
    answerReads(r, from);
    await drive(r, 0.2, true);
    assert.equal(r.e.held, false);
    assert.equal(r.e.assistant.fbStreak.get(2), 0);
    assert.equal(r.e.assistant.feedback.fbLastFreq.get(2), null);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("a read that leaves a fader unanswered fails, stays held, and tries again after resyncS", async () => {
  const r = await makeRig();
  try {
    const missing = "/ch/04/mix/fader";
    answerReads(r, 0, DESK, [missing]);
    await drive(r, 1.2, true);
    assert.equal(countSent(r.con, missing), 3);
    assert.equal(count(r.e, "could not read the desk"), 0);
    await drive(r, 0.5, true);
    assert.ok(msgs(r.e).includes(`could not read the desk (1 value(s) unanswered) — trying again in ${C.link.resyncS} s`));
    assert.deepEqual(holdOf(r.e), { held: true, reasons: ["unsynced"] });
    assert.equal(countSent(r.con, "/ch/01/mix/fader"), 1);
    await drive(r, 4.5, true);
    assert.equal(countSent(r.con, "/ch/01/mix/fader"), 1);
    assert.equal(r.e.held, true);
    const from = r.con.wireLog.length;
    await drive(r, 0.8, true);
    assert.deepEqual(new Set(readsSince(r.con, from)), new Set(deskAddresses()));
    assert.equal(count(r.e, "could not read the desk"), 1);
    answerReads(r, from);
    await drive(r, 0.2, true);
    assert.equal(r.e.held, false);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("a second failed read after a successful one in between is logged and waits resyncS before trying again", async () => {
  const r = await makeRig();
  try {
    const missing = "/ch/04/mix/fader";
    answerReads(r, 0, DESK, [missing]);
    await drive(r, 1.7, true);
    assert.equal(count(r.e, "could not read the desk"), 1);
    const good = r.con.wireLog.length;
    r.e.recallSceneManual(4);
    answerReads(r, good);
    await drive(r, 0.2, true);
    assert.equal(r.e.held, false);
    await drive(r, 5.0, true);
    const bad = r.con.wireLog.length;
    r.e.recallSceneManual(5);
    answerReads(r, bad, DESK, [missing]);
    await drive(r, 1.7, true);
    assert.equal(r.e.held, true);
    assert.equal(count(r.e, "could not read the desk"), 2, "the second failed read was not logged");
    assert.equal(countSent(r.con, "/ch/01/mix/fader", bad), 1, "the desk was read again before resyncS had passed");
  } finally {
    await r.e.stop();
  }
});

test("a receiver that fails to start holds the jobs for no-feedback with a critical alert while manual controls still write", async () => {
  const r = await makeRig({ rx: { start: () => Promise.reject(new Error("EADDRINUSE")), stop: () => undefined } });
  try {
    assert.equal(r.e.meterRx, null);
    assert.deepEqual(holdOf(r.e), { held: true, reasons: ["no-feedback"] });
    assert.ok(alertsOf(r.e).some((a) => a.level === "critical" && a.msg.startsWith("jobs on hold — the console's reply port could not be opened")));
    assert.deepEqual(readsSince(r.con, 0), []);
    await drive(r, 2.0, false);
    assert.equal(r.e.held, true);
    assert.equal(countSent(r.con, "/xinfo"), 0);
    const from = r.con.wireLog.length;
    r.e.onPushedBlock(clipBlock(2), 0);
    assert.deepEqual(writesTo(r.con, "/headamp/001/gain", from), []);
    r.e.setFader(3, -5);
    r.e.setMute(4, true);
    near(floatOf(writesTo(r.con, "/ch/03/mix/fader", from)[0]), dbToFader(-5));
    assert.equal(writesTo(r.con, "/ch/04/mix/on", from).length, 1);
    assert.equal(r.e.snapshot()["op_mode"], "alert");
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("an engine with no receiver never holds and its jobs act", async () => {
  const r = await makeRig({ rx: null });
  try {
    assert.equal(r.e.held, false);
    assert.deepEqual(holdOf(r.e), { held: false, reasons: [] });
    r.e.onPushedBlock(clipBlock(2), 0);
    near(gainOf(r.e, 2), 18);
    await drive(r, 3.0, false);
    r.e.recallSceneManual(4);
    r.e.consoleHeard();
    r.e.consoleParam("/ch/01/mix/fader", [oscFloat(0.5)]);
    await drive(r, 1.0, false);
    assert.equal(r.e.held, false);
    assert.deepEqual(readsSince(r.con, 0), []);
    assert.equal(countSent(r.con, "/xinfo"), 0);
    assert.equal(r.e.assistant.faderDb.get(1), 0);
    assert.equal(count(r.e, "automatic jobs on hold"), 0);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("a simulation engine never holds", async () => {
  const clock = new StepClock(100, 1_700_000_000);
  const e = new Engine({ clock, sim: true, tick: 0.05 });
  await e.start();
  try {
    for (let i = 0; i < 30; i++) {
      await clock.advance(0.1);
      assert.equal(e.held, false);
    }
    assert.deepEqual(holdOf(e), { held: false, reasons: [] });
    assert.equal(count(e, "automatic jobs on hold"), 0);
    const nears = count(e, "harm_vox_l near clip");
    e.onPushedBlock(clipBlock(2), 0);
    assert.equal(count(e, "harm_vox_l near clip"), nears + 1);
    noErrors(e);
  } finally {
    await e.stop();
  }
});

test("calibration is refused while held and starts once the jobs are re-armed", async () => {
  const r = await makeRig();
  try {
    r.e.runCalibration();
    assert.ok(msgs(r.e).some((m) => m.startsWith("calibration waits: the automatic jobs are on hold")));
    assert.equal(r.e.calibStatus, "none");
    assert.equal(r.e.status, "live");
    assert.equal(r.e.calibrationTask, null);
    answerReads(r, 0);
    await drive(r, 1.3, true);
    assert.equal(r.e.held, false);
    r.e.runCalibration();
    assert.equal(r.e.calibStatus, "running");
    assert.equal(r.e.status, "calibrating");
    await drive(r, 1.5, true);
    await r.e.calibrationTask;
    assert.equal(r.e.status, "live");
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("a scene recall puts the jobs on hold until the desk is read again", async () => {
  const r = await armedRig();
  try {
    const from = r.con.wireLog.length;
    r.e.recallSceneManual(7);
    assert.equal(writesTo(r.con, "/-action/goscene", from).length, 1);
    assert.deepEqual(holdOf(r.e), { held: true, reasons: ["unsynced"] });
    assert.deepEqual(new Set(readsSince(r.con, from)), new Set(deskAddresses()));
    const quiet = r.con.wireLog.length;
    r.e.onPushedBlock(clipBlock(2), 0);
    assert.deepEqual(writesTo(r.con, "/headamp/001/gain", quiet), []);
    await drive(r, 1.0, true);
    assert.equal(r.e.held, true);
    answerReads(r, from);
    await drive(r, 0.2, true);
    assert.equal(r.e.held, false);
    assert.equal(count(r.e, "automatic jobs re-armed"), 2);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("a finished full test puts the jobs on hold until the desk is read again", async () => {
  const r = await armedRig();
  try {
    r.e.vetHost = {
      console: false,
      run: async () => {
        await r.clock.sleep(1.0);
        return { text: "", summary: "0 failed", failed: 0 };
      },
    };
    const from = r.con.wireLog.length;
    const vet = r.e.runVet({ channel: null, gain: false, main: false, identify: false });
    assert.equal(r.e.held, false);
    await drive(r, 1.3, true);
    await vet;
    assert.equal(r.e.held, true);
    assert.deepEqual(new Set(readsSince(r.con, from)), new Set(deskAddresses()));
    answerReads(r, from);
    await drive(r, 0.2, true);
    assert.equal(r.e.held, false);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("during silence the engine probes with /xinfo at most once per probeS, and not while traffic flows", async () => {
  const r = await makeRig();
  try {
    const times: number[] = [];
    let seen = 0;
    for (let i = 0; i < 100; i++) {
      await r.clock.advance(0.05);
      const n = countSent(r.con, "/xinfo");
      if (n > seen) times.push(r.clock.monotonic());
      assert.ok(n - seen <= 1);
      seen = n;
    }
    assert.ok(times.length >= 5, `only ${times.length} probes in 5 s of silence`);
    assert.ok(times[0]! >= 100 + C.link.probeS);
    for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= C.link.probeS - 1e-9);
    answerReads(r, 0);
    await drive(r, 1.0, true);
    const flowing = countSent(r.con, "/xinfo");
    await drive(r, 3.0, true);
    assert.equal(countSent(r.con, "/xinfo"), flowing);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});
