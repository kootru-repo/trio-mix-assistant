import { defaultConfig } from "../src/core/config.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysedBlock } from "../src/core/blockanalysis.ts";
import { CaptureSourceBase } from "../src/core/capture.ts";
import type { Frame } from "../src/core/capture.ts";
import { formatHhmmss } from "../src/core/clock.ts";
import type { Clock } from "../src/core/clock.ts";
import { OscConsole, SimConsole, autoLane, dbToFader, faderToDb } from "../src/core/console.ts";
import { emptyFeatures } from "../src/core/dsp.ts";
import type { ChannelFeatures } from "../src/core/dsp.ts";
import type { Alert } from "../src/core/engine/base.ts";
import { Engine } from "../src/core/engine/index.ts";
import { decodeMessage, oscFloat, oscInt } from "../src/core/oscwire.ts";
import type { OscArg } from "../src/core/oscwire.ts";
import type { MeterReceiverPort } from "../src/core/ports.ts";
import type { WriteGovernor } from "../src/core/writegov.ts";
import { StepClock } from "./stepclock.ts";

const testCfg = defaultConfig();

interface Sleeper {
  wake: number;
  resolve: () => void;
}

class JumpClock implements Clock {
  private now: number;
  private wall: number;
  private sleepers: Sleeper[] = [];

  constructor(start: number, wall: number) {
    this.now = start;
    this.wall = wall;
  }

  monotonic(): number {
    return this.now;
  }

  highResolution(): number {
    return this.now;
  }

  time(): number {
    return this.wall;
  }

  hhmmss(): string {
    return formatHhmmss(this.wall, true);
  }

  sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepers.push({ wake: this.now + Math.max(0, seconds), resolve });
    });
  }

  async advance(seconds: number): Promise<void> {
    const target = this.now + seconds;
    for (;;) {
      let best: Sleeper | null = null;
      for (const s of this.sleepers) if (s.wake <= target + 1e-12 && (best === null || s.wake < best.wake)) best = s;
      if (best === null) break;
      this.sleepers = this.sleepers.filter((s) => s !== best);
      this.wall += Math.max(0, best.wake - this.now);
      this.now = Math.max(this.now, best.wake);
      best.resolve();
      for (let k = 0; k < 40; k++) await Promise.resolve();
    }
    this.wall += Math.max(0, target - this.now);
    this.now = Math.max(this.now, target);
  }

  async jump(seconds: number): Promise<void> {
    this.now += seconds;
    this.wall += seconds;
    await this.advance(0);
  }

  shiftWall(seconds: number): void {
    this.wall += seconds;
  }
}

class SlipClock implements Clock {
  now = 100;
  extra: number[] = [];
  monotonic(): number {
    return this.now;
  }
  highResolution(): number {
    return this.now;
  }
  time(): number {
    return this.now;
  }
  hhmmss(): string {
    return "";
  }
  sleep(seconds: number): Promise<void> {
    this.now += seconds + (this.extra.shift() ?? 0);
    return Promise.resolve();
  }
}

interface Sent {
  addr: string;
  args: OscArg[];
}

class Sink {
  readonly sent: Sent[] = [];
  send(data: Uint8Array): void {
    const m = decodeMessage(data);
    assert.ok(m !== null);
    this.sent.push({ addr: m.address, args: m.args });
  }
  close(): void {}
  since(from: number): Sent[] {
    return this.sent.slice(from);
  }
}

class QuietSource extends CaptureSourceBase {
  block(): Frame {
    return new Map();
  }
}

class CountingEngine extends Engine {
  steps = 0;
  override step(now: number, lastNow: number): void {
    this.steps += 1;
    super.step(now, lastNow);
  }
}

type AnyClock = StepClock | JumpClock;

interface Rig {
  e: CountingEngine;
  clock: AnyClock;
  con: OscConsole;
  sink: Sink;
}

const FADER = /^\/ch\/(\d\d)\/mix\/fader$/;
const GAIN = /^\/headamp\/(\d\d\d)\/gain$/;
const INVERT = /^\/ch\/(\d\d)\/preamp\/invert$/;

const isRead = (s: Sent): boolean => s.args.length === 0 && (FADER.test(s.addr) || GAIN.test(s.addr) || INVERT.test(s.addr));

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

const deskAddresses = (): string[] =>
  [...testCfg.CHANNELS.keys()].flatMap((ch) => [
    `/ch/${pad(ch, 2)}/mix/fader`,
    `/headamp/${pad(ch - 1, 3)}/gain`,
    `/ch/${pad(ch, 2)}/preamp/invert`,
  ]);

const quietReceiver = (): MeterReceiverPort => ({ start: () => Promise.resolve(), stop: () => undefined });

const gov = (con: OscConsole): WriteGovernor => {
  const g = con.governor;
  assert.ok(g !== null, "the console has no write governor");
  return g;
};

const makeRig = async (clock: AnyClock = new StepClock(100, 1_700_000_000)): Promise<Rig> => {
  const sink = new Sink();
  const con = new OscConsole(sink, { cfg: testCfg, clock });
  const e = new CountingEngine({ cfg: testCfg, clock, sim: false, console: con, source: new QuietSource(), tick: 0.05 });
  e.meterRx = quietReceiver();
  await e.start();
  return { e, clock, con, sink };
};

const readsSince = (r: Rig, from: number): string[] =>
  r.sink
    .since(from)
    .filter(isRead)
    .map((s) => s.addr);

const reply = (e: Engine, address: string): void => {
  e.consoleHeard();
  const f = FADER.exec(address);
  if (f !== null) {
    const pos = dbToFader(-10);
    e.consoleParam(address, [oscFloat(pos)]);
    e.reconcileFader(Number(f[1]), faderToDb(pos));
    return;
  }
  if (GAIN.test(address)) {
    e.consoleParam(address, [oscFloat((35 + 12) / 72)]);
    return;
  }
  if (INVERT.test(address)) e.consoleParam(address, [oscInt(0)]);
};

const answerReads = (r: Rig, from: number): number => {
  const asked = [...new Set(readsSince(r, from))];
  for (const a of asked) reply(r.e, a);
  return asked.length;
};

const drive = async (r: Rig, seconds: number, heard: boolean): Promise<void> => {
  const n = Math.round(seconds / 0.1);
  for (let i = 0; i < n; i++) {
    if (heard) r.e.consoleHeard();
    await r.clock.advance(0.1);
  }
};

const armedRig = async (clock?: AnyClock): Promise<Rig> => {
  const r = await makeRig(clock);
  assert.equal(answerReads(r, 0), deskAddresses().length);
  await drive(r, 1.3, true);
  assert.equal(r.e.held, false);
  return r;
};

const writesTo = (r: Rig, address: string, from: number): OscArg[] =>
  r.sink
    .since(from)
    .filter((s) => s.addr === address && s.args.length > 0)
    .map((s) => s.args[0])
    .filter((a): a is OscArg => a !== undefined);

const floatOf = (a: OscArg | undefined): number => {
  assert.ok(a !== undefined && a.t === "f");
  return a.v;
};

const msgs = (e: Engine): string[] => e.events.map((ev) => ev.msg);

const count = (e: Engine, prefix: string): number => msgs(e).filter((m) => m.startsWith(prefix)).length;

const noErrors = (e: Engine): void => {
  assert.deepEqual(
    msgs(e).filter((m) => m.startsWith("engine error")),
    [],
  );
};

const isAlert = (x: unknown): x is Alert =>
  typeof x === "object" && x !== null && "level" in x && "msg" in x && typeof x.level === "string" && typeof x.msg === "string";

const alertsOf = (e: Engine): Alert[] => {
  const a = e.snapshot()["alerts"];
  assert.ok(Array.isArray(a));
  return a.filter(isAlert);
};

const reasonsOf = (e: Engine): string[] => {
  const h = e.snapshot()["hold"];
  assert.ok(typeof h === "object" && h !== null && "reasons" in h && Array.isArray(h.reasons));
  return h.reasons.map(String).sort();
};

const logOf = (e: Engine): string[] => {
  const log = e.snapshot()["log"];
  assert.ok(Array.isArray(log));
  return log.map((l: unknown) => (typeof l === "object" && l !== null && "msg" in l ? String(l.msg) : ""));
};

const block = (feats: ReadonlyArray<[number, Partial<ChannelFeatures>]>): AnalysedBlock => ({
  feats: new Map(feats.map(([ch, f]) => [ch, { ...emptyFeatures(), ...f }])),
  phases: [],
});

const clipBlock = (ch: number): AnalysedBlock => block([[ch, { rmsDbfs: -6, peakDbfs: -0.2 }]]);

const gainAddr = (ch: number): string => `/headamp/${pad(ch - 1, 3)}/gain`;
const faderAddr = (ch: number): string => `/ch/${pad(ch, 2)}/mix/fader`;

const near = (actual: number | undefined | null, expected: number, tol = 1e-6): void => {
  assert.ok(actual !== undefined && actual !== null && Math.abs(actual - expected) < tol, `expected ${expected}, got ${String(actual)}`);
};

const exhaustAuto = (r: Rig): void => {
  const auto = autoLane(r.e.con);
  for (let ch = 9; ch <= 32 && gov(r.con).backlog("auto") === 0; ch++) {
    for (let band = 1; band <= 4; band++) auto.setEqBand(ch, band, 500 + band * 100, -3, 2, true);
  }
  assert.ok(gov(r.con).backlog("auto") > 0, "the auto lane never filled");
};

test("with the auto lane used up, the assistant's clip trim waits while a dashboard fader and the TAKEOVER mute go out at once", async () => {
  const r = await armedRig();
  try {
    exhaustAuto(r);
    const backlog = gov(r.con).backlog("auto");
    const from = r.sink.sent.length;
    r.e.onPushedBlock(clipBlock(2), 0);
    near(r.e.assistant.gainDb.get(2), 33);
    assert.deepEqual(writesTo(r, gainAddr(2), from), [], "the clip trim jumped the auto queue");
    assert.equal(gov(r.con).backlog("auto"), backlog + 1);
    r.e.command({ type: "fader", ch: 3, db: -5 });
    near(floatOf(writesTo(r, faderAddr(3), from)[0]), dbToFader(-5));
    assert.equal(gov(r.con).backlog("manual"), 0);
    r.e.panic(true);
    const mute = writesTo(r, `/${testCfg.MAIN_BUS}/mix/on`, from);
    assert.equal(mute.length, 1);
    assert.deepEqual(mute[0], oscInt(0));
    assert.equal(writesTo(r, gainAddr(2), from).length, 0);
    await drive(r, 1.0, true);
    const trims = writesTo(r, gainAddr(2), from);
    assert.equal(trims.length, 1, "the queued clip trim never went out");
    near(floatOf(trims[0]), (33 + 12) / 72);
    assert.equal(gov(r.con).backlog(), 0);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("with the auto lane used up, a desk read after a scene recall still goes out at once", async () => {
  const r = await armedRig();
  try {
    exhaustAuto(r);
    const from = r.sink.sent.length;
    r.e.recallSceneManual(4);
    assert.equal(writesTo(r, "/-action/goscene", from).length, 1);
    assert.deepEqual(new Set(readsSince(r, from)), new Set(deskAddresses()));
    assert.ok(gov(r.con).backlog("auto") > 0);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("a trim still queued when a scene recall reads the desk is superseded by the read, and the belief follows the desk", async () => {
  const r = await armedRig();
  try {
    exhaustAuto(r);
    const from = r.sink.sent.length;
    r.e.onPushedBlock(clipBlock(2), 0);
    near(r.e.assistant.gainDb.get(2), 33);
    r.e.recallSceneManual(4);
    assert.equal(gov(r.con).backlog("auto") > 0, true);
    answerReads(r, from);
    await drive(r, 1.0, true);
    assert.equal(r.e.held, false);
    assert.deepEqual(writesTo(r, gainAddr(2), from), [], "a pre-scene trim reached the recalled scene");
    near(r.e.assistant.gainDb.get(2), 35);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("with both the auto and manual lanes used up, a dashboard fader queues while the desk read and the TAKEOVER mute still go out at once", async () => {
  const r = await armedRig();
  try {
    exhaustAuto(r);
    for (let ch = 1; ch <= 32 && gov(r.con).backlog("manual") === 0; ch++) {
      r.e.command({ type: "send", ch: Math.min(ch, 7), fx: 1 + (ch % testCfg.FX_BUSES.size), db: -20 - ch });
      r.e.command({ type: "eq", ch: Math.min(ch, 7), band: 1 + (ch % 4), gain: -1 - ch / 10 });
    }
    assert.ok(gov(r.con).backlog("manual") > 0, "the manual lane never filled");
    const from = r.sink.sent.length;
    r.e.command({ type: "fader", ch: 3, db: -7 });
    assert.deepEqual(writesTo(r, faderAddr(3), from), [], "the dashboard fader skipped the manual queue");
    near(r.e.assistant.faderDb.get(3), -7);
    r.e.recallSceneManual(4);
    assert.deepEqual(new Set(readsSince(r, from)), new Set(deskAddresses()));
    r.e.panic(true);
    const mute = writesTo(r, `/${testCfg.MAIN_BUS}/mix/on`, from);
    assert.equal(mute.length, 1);
    assert.deepEqual(mute[0], oscInt(0));
    assert.ok(gov(r.con).backlog("manual") > 0);
    assert.ok(gov(r.con).backlog("auto") > 0);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("a manual fader write sent while the manual lane is idle is not held back by a full auto lane", async () => {
  const r = await armedRig();
  try {
    exhaustAuto(r);
    const from = r.sink.sent.length;
    for (let i = 0; i < 10; i++) r.e.setFader(5, -20 + i);
    assert.equal(writesTo(r, faderAddr(5), from).length, 10);
    near(floatOf(writesTo(r, faderAddr(5), from)[9]), dbToFader(-11));
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

const flood = (target: ReturnType<typeof autoLane>): void => {
  for (let ch = 1; ch <= 32; ch++) for (let band = 1; band <= 4; band++) target.setEqBand(ch, band, 200 * band, -3, 2, true);
  for (let band = 1; band <= 6; band++) target.setBusEq(band, 100 * band, -2, 4);
  for (let ch = 1; ch <= 32; ch++) target.nudgeGainDb(ch, 30, -1);
};

const uniqueInOrder = (xs: readonly string[]): string[] => [...new Set(xs)];

test("an auto backlog that lasts stormS holds the jobs for write-storm with a critical alert, drains in order with latest values, and TAKEOVER re-arms", async () => {
  const r = await armedRig();
  try {
    const sim = new SimConsole({ cfg: testCfg });
    flood(autoLane(sim));
    autoLane(sim).setEqBand(32, 4, 4321, 6, 3, true);
    const expected = uniqueInOrder(sim.wireLog.map((w) => w[0]));
    const from = r.sink.sent.length;
    const auto = autoLane(r.e.con);
    flood(auto);
    auto.setEqBand(32, 4, 4321, 6, 3, true);
    assert.ok(gov(r.con).backlog("auto") > 300);
    assert.ok(gov(r.con).stats().merged > 0);
    await drive(r, 1.5, true);
    assert.equal(r.e.held, false, "held before the backlog had lasted stormS");
    await drive(r, 0.7, true);
    assert.equal(r.e.held, true);
    assert.deepEqual(reasonsOf(r.e), ["write-storm"]);
    assert.equal(count(r.e, "the console could not take changes as fast as the app sent them"), 1);
    assert.equal(count(r.e, "automatic jobs on hold: the app tried to send more changes"), 1);
    assert.ok(alertsOf(r.e).some((a) => a.level === "critical" && a.msg.startsWith("jobs on hold — the app tried to send more changes")));
    assert.equal(r.e.snapshot()["op_mode"], "alert");
    const quiet = r.sink.sent.length;
    r.e.onPushedBlock(clipBlock(2), 0);
    near(r.e.assistant.gainDb.get(2), 35);
    await drive(r, 3.0, true);
    assert.equal(gov(r.con).backlog(), 0);
    assert.deepEqual(
      writesTo(r, gainAddr(2), quiet).filter((a) => Math.abs(floatOf(a) - (33 + 12) / 72) < 1e-6),
      [],
    );
    const wanted = new Set(expected);
    const got = r.sink.since(from).filter((s) => wanted.has(s.addr) && s.args.length > 0);
    assert.deepEqual(
      got.map((s) => s.addr),
      expected,
      "a queued write was lost, repeated or reordered",
    );
    const last = got.filter((s) => s.addr === "/ch/32/eq/4/g").at(-1);
    near(floatOf(last?.args[0]), (6 + 15) / 30);
    const lastF = got.filter((s) => s.addr === "/ch/32/eq/4/f").at(-1);
    assert.ok(lastF !== undefined);
    assert.equal(r.e.held, true, "the write-storm hold cleared itself without TAKEOVER");
    r.e.panic(true);
    r.e.panic(false);
    assert.equal(r.e.held, false);
    assert.deepEqual(reasonsOf(r.e), []);
    assert.equal(count(r.e, "automatic jobs re-armed"), 2);
    assert.ok(!alertsOf(r.e).some((a) => a.level === "critical"));
    await drive(r, 0.5, true);
    assert.equal(r.e.held, false);
    const after = r.sink.sent.length;
    r.e.onPushedBlock(clipBlock(2), 0);
    assert.equal(writesTo(r, gainAddr(2), after).length, 1);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("releasing TAKEOVER while the auto backlog is still storming puts the jobs straight back on hold", async () => {
  const r = await armedRig();
  try {
    flood(autoLane(r.e.con));
    await drive(r, 2.2, true);
    assert.deepEqual(reasonsOf(r.e), ["write-storm"]);
    r.e.panic(true);
    r.e.panic(false);
    await drive(r, 0.1, true);
    assert.deepEqual(reasonsOf(r.e), ["write-storm"]);
    assert.equal(count(r.e, "the console could not take changes as fast as the app sent them"), 2);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("the echo of the app's own ramp step is ignored, and a hand move during the ramp cancels it, is adopted and starts the manual hold", async () => {
  const r = await armedRig();
  try {
    const from = r.sink.sent.length;
    autoLane(r.e.con).rampFaderDb(4, -10, -4);
    await drive(r, 0.1, true);
    const steps = writesTo(r, faderAddr(4), from);
    assert.ok(steps.length >= 2 && steps.length < 12, `${steps.length} ramp steps by 0.1 s`);
    const echoed = r.con.lastWritten(4);
    assert.ok(echoed !== null);
    const events = r.e.events.length;
    r.e.reconcileFader(4, faderToDb(dbToFader(echoed)));
    near(r.e.assistant.faderDb.get(4), -10);
    assert.ok((r.e.assistant.manualHoldUntil.get(4) ?? -1e9) < r.clock.monotonic(), "the echo started a manual hold");
    assert.equal(r.e.events.length, events, "the echo was logged");
    r.e.reconcileFader(4, 2);
    const hand = r.sink.sent.length;
    const now = r.clock.monotonic();
    near(r.e.assistant.faderDb.get(4), 2);
    assert.ok((r.e.assistant.manualHoldUntil.get(4) ?? -1e9) > now);
    assert.ok(msgs(r.e).some((m) => m.includes("moved on console")));
    await drive(r, 1.0, true);
    assert.deepEqual(writesTo(r, faderAddr(4), hand), [], "later ramp steps overwrote the hand move");
    near(r.e.assistant.faderDb.get(4), 2);
    assert.equal(r.e.channelLocked(4), false);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("a hand move on another channel does not stop a ramp in flight", async () => {
  const r = await armedRig();
  try {
    const from = r.sink.sent.length;
    autoLane(r.e.con).rampFaderDb(4, -10, -4);
    await drive(r, 0.1, true);
    r.e.reconcileFader(6, 0);
    await drive(r, 1.0, true);
    assert.equal(writesTo(r, faderAddr(4), from).length, 12);
    near(r.con.lastWritten(4), -4);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("three hand moves within lockWindowS lock the channel out of every job until TAKEOVER is pressed and released", async () => {
  const r = await armedRig();
  try {
    const lockMsg = `ch2 moved by hand ${testCfg.safety.lockMoves} times in ${testCfg.safety.lockWindowS} s`;
    r.e.reconcileFader(2, -3);
    await drive(r, 1.0, true);
    r.e.reconcileFader(2, 0);
    await drive(r, 1.0, true);
    assert.equal(r.e.channelLocked(2), false);
    assert.equal(count(r.e, lockMsg), 0);
    r.e.reconcileFader(2, -6);
    assert.equal(r.e.channelLocked(2), true);
    assert.equal(count(r.e, lockMsg), 1);
    assert.ok(
      logOf(r.e).some((m) => m.startsWith(lockMsg)),
      "the lock is not in the snapshot log",
    );
    assert.deepEqual(r.e.snapshot()["hold"], { held: false, reasons: [] });
    const from = r.sink.sent.length;
    r.e.onPushedBlock(clipBlock(2), 0);
    r.e.onPushedBlock(clipBlock(5), 0);
    await drive(r, 0.2, true);
    assert.deepEqual(writesTo(r, gainAddr(2), from), [], "a locked channel was trimmed");
    near(r.e.assistant.gainDb.get(2), 35);
    assert.equal(writesTo(r, gainAddr(5), from).length, 1);
    near(r.e.assistant.gainDb.get(5), 33);
    r.e.reconcileFader(2, -12);
    assert.equal(count(r.e, lockMsg), 1);
    assert.equal(r.e.held, false);
    r.e.panic(true);
    assert.equal(r.e.channelLocked(2), true);
    r.e.panic(false);
    assert.equal(r.e.channelLocked(2), false);
    assert.equal(count(r.e, "automatic jobs may move ch2 again"), 1);
    const after = r.sink.sent.length;
    r.e.onPushedBlock(clipBlock(2), 0);
    await drive(r, 0.2, true);
    assert.equal(writesTo(r, gainAddr(2), after).length, 1);
    near(r.e.assistant.gainDb.get(2), 33);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("hand moves spread wider than lockWindowS never lock the channel", async () => {
  const r = await armedRig();
  try {
    for (const db of [-3, 0, -6]) {
      r.e.reconcileFader(2, db);
      await drive(r, testCfg.safety.lockWindowS / 2 + 1, true);
    }
    assert.equal(r.e.channelLocked(2), false);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

const leadRideBlock = (): AnalysedBlock => block([[testCfg.LEAD_VOCAL_CH, { rmsDbfs: -40, peakDbfs: -30 }]]);

test("a ride ramp aborted for oversleeping leaves the fader belief at the last value actually written", async () => {
  const clock = new SlipClock();
  const sink = new Sink();
  const con = new OscConsole(sink, { cfg: testCfg, clock });
  const e = new Engine({ cfg: testCfg, clock, sim: false, console: con, source: new QuietSource(), tick: 0.05 });
  const ch = testCfg.LEAD_VOCAL_CH;
  e.setEnabled("vocal_ride", true);
  clock.extra = [0, 0.3];
  e.onPushedBlock(leadRideBlock(), 0);
  const target = e.assistant.faderDb.get(ch);
  assert.ok(target !== undefined && target > 0.5, `the ride did not move (${String(target)})`);
  await con.flushRamps();
  const written = sink.sent.filter((s) => s.addr === faderAddr(ch));
  assert.equal(written.length, 2);
  const last = con.lastWritten(ch);
  assert.ok(last !== null && last < target);
  near(e.assistant.faderDb.get(ch), last);
  near(faderToDb(floatOf(written[1]?.args[0])), last, 1e-3);
});

test("a ride ramp dropped for waiting too long leaves the belief at the channel's last written level", async () => {
  const clock = new StepClock(100, 1_700_000_000);
  const sink = new Sink();
  const con = new OscConsole(sink, { cfg: testCfg, clock });
  const e = new Engine({ cfg: testCfg, clock, sim: false, console: con, source: new QuietSource(), tick: 0.05 });
  const ch = testCfg.LEAD_VOCAL_CH;
  con.setFaderDb(ch, -3);
  e.assistant.faderDb.set(ch, -3);
  e.setEnabled("vocal_ride", true);
  con.rampFaderDb(7, -10, -4, 2000, 4);
  e.onPushedBlock(leadRideBlock(), 0);
  near(e.assistant.faderDb.get(ch), -2);
  const done = con.flushRamps();
  for (let i = 0; i < 40; i++) await clock.advance(0.1);
  await done;
  assert.equal(sink.sent.filter((s) => s.addr === faderAddr(ch)).length, 1);
  near(e.assistant.faderDb.get(ch), -3);
});

test("a ride ramp dropped before it wrote anything on a channel the app never wrote leaves the belief at the ramp's start", async () => {
  const clock = new StepClock(100, 1_700_000_000);
  const sink = new Sink();
  const con = new OscConsole(sink, { cfg: testCfg, clock });
  const e = new Engine({ cfg: testCfg, clock, sim: false, console: con, source: new QuietSource(), tick: 0.05 });
  const ch = testCfg.LEAD_VOCAL_CH;
  e.setEnabled("vocal_ride", true);
  const start = e.assistant.faderDb.get(ch);
  assert.ok(start !== undefined);
  con.rampFaderDb(7, -10, -4, 2000, 4);
  e.onPushedBlock(leadRideBlock(), 0);
  assert.ok((e.assistant.faderDb.get(ch) ?? start) > start);
  const done = con.flushRamps();
  for (let i = 0; i < 40; i++) await clock.advance(0.1);
  await done;
  assert.equal(sink.sent.filter((s) => s.addr === faderAddr(ch)).length, 0);
  assert.equal(con.lastWritten(ch), null);
  near(e.assistant.faderDb.get(ch), start, 1e-6);
});

test("a long stall is reported, holds the jobs for resume, re-reads the desk without a burst of catch-up steps, and re-arms after the read", async () => {
  const clock = new JumpClock(100, 1_700_000_000);
  const r = await armedRig(clock);
  try {
    const from = r.sink.sent.length;
    const steps = r.e.steps;
    await clock.jump(600);
    assert.ok(r.e.steps - steps <= 2, `${r.e.steps - steps} steps ran for the 600 s gap`);
    await clock.advance(0.05);
    assert.equal(count(r.e, "the engine was paused for about 600 s"), 1);
    assert.ok(r.e.held);
    const reasons = reasonsOf(r.e);
    assert.ok(reasons.includes("resume"), `reasons ${reasons.join(",")}`);
    assert.ok(reasons.includes("unsynced"));
    assert.ok(alertsOf(r.e).some((a) => a.level === "warn" && a.msg.startsWith("jobs on hold — the computer was asleep")));
    assert.deepEqual(new Set(readsSince(r, from)), new Set(deskAddresses()));
    assert.ok(r.sink.since(from).some((s) => s.addr === "/batchsubscribe"));
    const quiet = r.sink.sent.length;
    r.e.onPushedBlock(clipBlock(2), 0);
    assert.deepEqual(writesTo(r, gainAddr(2), quiet), []);
    const before = r.e.steps;
    await drive(r, 1.0, false);
    assert.ok(r.e.steps - before <= 22, `${r.e.steps - before} steps in 1 s after the stall`);
    answerReads(r, from);
    await drive(r, 1.3, true);
    assert.equal(r.e.held, false);
    assert.deepEqual(reasonsOf(r.e), []);
    const after = r.sink.sent.length;
    r.e.onPushedBlock(clipBlock(2), 0);
    assert.equal(writesTo(r, gainAddr(2), after).length, 1);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("a wall-clock jump with no monotonic gap is also treated as a resume", async () => {
  const clock = new JumpClock(100, 1_700_000_000);
  const r = await armedRig(clock);
  try {
    const from = r.sink.sent.length;
    clock.shiftWall(600);
    await drive(r, 0.1, true);
    assert.equal(count(r.e, "the engine was paused for about 600 s"), 1);
    assert.ok(reasonsOf(r.e).includes("resume"));
    assert.deepEqual(new Set(readsSince(r, from)), new Set(deskAddresses()));
    answerReads(r, from);
    await drive(r, 1.3, true);
    assert.equal(r.e.held, false);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("a backward wall-clock step is logged as the clock jumping back and still holds for resume", async () => {
  const clock = new JumpClock(100, 1_700_000_000);
  const r = await armedRig(clock);
  try {
    const from = r.sink.sent.length;
    clock.shiftWall(-600);
    await drive(r, 0.1, true);
    assert.equal(count(r.e, "the computer clock jumped back by about 600 s"), 1);
    assert.equal(count(r.e, "the engine was paused"), 0);
    assert.ok(reasonsOf(r.e).includes("resume"));
    assert.deepEqual(new Set(readsSince(r, from)), new Set(deskAddresses()));
    answerReads(r, from);
    await drive(r, 1.3, true);
    assert.equal(r.e.held, false);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("the EQ flatten sent when the jobs re-arm goes on the auto lane and waits behind a full auto budget", async () => {
  const r = await armedRig();
  try {
    r.e.setEnabled("unmask", true);
    for (let i = 0; i < 10; i++) r.e.onPushedBlock(block([[1, { rmsDbfs: -10, peakDbfs: -8 }]]), 0);
    assert.ok(r.e.assistant.duckApplied.size > 0);
    await drive(r, 1.7, false);
    assert.equal(r.e.held, true);
    const from = r.sink.sent.length;
    await drive(r, 1.3, true);
    answerReads(r, from);
    const auto = autoLane(r.e.con);
    for (let ch = 9; ch <= 32 && gov(r.con).backlog("auto") < 60; ch++) {
      for (let band = 1; band <= 4; band++) auto.setEqBand(ch, band, 500 + band * 100, -3, 2, true);
    }
    assert.ok(gov(r.con).backlog("auto") >= 60, "the auto lane never filled");
    const rearm = r.sink.sent.length;
    await r.clock.advance(0.05);
    for (let i = 0; i < 4 && r.e.held; i++) {
      r.e.consoleHeard();
      await r.clock.advance(0.05);
    }
    assert.equal(r.e.held, false);
    const flat = `/ch/02/eq/${testCfg.unmask.band}/g`;
    assert.deepEqual(writesTo(r, flat, rearm), [], "the flatten jumped the auto queue");
    assert.equal(gov(r.con).backlog("manual"), 0);
    assert.ok(gov(r.con).backlog("auto") > 0);
    await drive(r, 1.0, true);
    const g = writesTo(r, flat, rearm);
    assert.equal(g.length, 1);
    near(floatOf(g[0]), 0.5);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("a simulation engine only logs a long stall and does not hold", async () => {
  const clock = new JumpClock(100, 1_700_000_000);
  const e = new Engine({ cfg: testCfg, clock, sim: true, tick: 0.05 });
  await e.start();
  try {
    await clock.advance(0.5);
    await clock.jump(600);
    await clock.advance(0.5);
    assert.equal(count(e, "the engine was paused for about 600 s"), 1);
    assert.equal(e.held, false);
    assert.deepEqual(reasonsOf(e), []);
    assert.equal(count(e, "automatic jobs on hold"), 0);
    noErrors(e);
  } finally {
    await e.stop();
  }
});

test("a fault holds the jobs for internal-error with a critical alert while manual controls still write, and TAKEOVER re-arms", async () => {
  const r = await armedRig();
  try {
    r.e.fault("boom");
    assert.equal(r.e.held, true);
    assert.deepEqual(reasonsOf(r.e), ["internal-error"]);
    assert.equal(count(r.e, "unexpected error: boom"), 1);
    assert.equal(count(r.e, "automatic jobs on hold: the app hit an unexpected error"), 1);
    assert.ok(alertsOf(r.e).some((a) => a.level === "critical" && a.msg.startsWith("jobs on hold — the app hit an unexpected error")));
    assert.equal(r.e.snapshot()["op_mode"], "alert");
    await drive(r, 2.0, true);
    assert.deepEqual(reasonsOf(r.e), ["internal-error"]);
    const from = r.sink.sent.length;
    r.e.onPushedBlock(clipBlock(2), 0);
    assert.deepEqual(writesTo(r, gainAddr(2), from), []);
    r.e.command({ type: "fader", ch: 3, db: -5 });
    r.e.command({ type: "mute", ch: 4, on: true });
    near(floatOf(writesTo(r, faderAddr(3), from)[0]), dbToFader(-5));
    assert.equal(writesTo(r, "/ch/04/mix/on", from).length, 1);
    r.e.fault("boom again");
    assert.equal(count(r.e, "automatic jobs on hold: the app hit an unexpected error"), 1);
    assert.deepEqual(reasonsOf(r.e), ["internal-error"]);
    r.e.panic(true);
    assert.equal(r.e.held, true);
    r.e.panic(false);
    assert.equal(r.e.held, false);
    assert.deepEqual(reasonsOf(r.e), []);
    assert.equal(count(r.e, "automatic jobs re-armed"), 2);
    const after = r.sink.sent.length;
    r.e.onPushedBlock(clipBlock(2), 0);
    assert.equal(writesTo(r, gainAddr(2), after).length, 1);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("TAKEOVER release clears only the operator holds and leaves a desk-read hold in place", async () => {
  const r = await armedRig();
  try {
    const from = r.sink.sent.length;
    r.e.recallSceneManual(3);
    r.e.fault("boom");
    assert.deepEqual(reasonsOf(r.e), ["internal-error", "unsynced"]);
    const critical = alertsOf(r.e).filter((a) => a.level === "critical").length;
    assert.equal(critical, 1);
    r.e.panic(true);
    r.e.panic(false);
    assert.deepEqual(reasonsOf(r.e), ["unsynced"]);
    answerReads(r, from);
    await drive(r, 0.3, true);
    assert.deepEqual(reasonsOf(r.e), []);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});
