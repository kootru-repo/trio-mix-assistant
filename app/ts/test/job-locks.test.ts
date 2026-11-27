import assert from "node:assert/strict";
import test from "node:test";
import { PhaseJob, UnmaskJob } from "../src/core/assistant/clarity.ts";
import { ClipJob } from "../src/core/assistant/clip.ts";
import { FeedbackJob } from "../src/core/assistant/feedback.ts";
import { MixAssistant } from "../src/core/assistant/index.ts";
import { RideJob } from "../src/core/assistant/ride.ts";
import { RoomModel, StageJob } from "../src/core/assistant/room.ts";
import type { AnalysedBlock } from "../src/core/blockanalysis.ts";
import { CaptureSourceBase } from "../src/core/capture.ts";
import type { Frame } from "../src/core/capture.ts";
import { ManualClock } from "../src/core/clock.ts";
import { defaultConfig } from "../src/core/config.ts";
import type { Config } from "../src/core/config.ts";
import { OscConsole, dbToFader, faderToDb } from "../src/core/console.ts";
import { emptyFeatures } from "../src/core/dsp.ts";
import type { ChannelFeatures, PhaseRelation } from "../src/core/dsp.ts";
import { Engine } from "../src/core/engine/index.ts";
import { decodeMessage, oscFloat, oscInt } from "../src/core/oscwire.ts";
import type { OscArg } from "../src/core/oscwire.ts";
import type { MeterReceiverPort } from "../src/core/ports.ts";
import { RecordingMixer, feat, harness, tuned } from "./jobhelpers.ts";
import type { Harness, MixerCall } from "./jobhelpers.ts";
import { StepClock } from "./stepclock.ts";

interface Jobs {
  feedback: FeedbackJob;
  clip: ClipJob;
  ride: RideJob;
  phase: PhaseJob;
  unmask: UnmaskJob;
  room: RoomModel;
  stage: StageJob;
}

const jobsFor = (h: Harness): Jobs => ({
  feedback: new FeedbackJob(h.ctx),
  clip: new ClipJob(h.ctx),
  ride: new RideJob(h.ctx),
  phase: new PhaseJob(h.ctx, () => undefined),
  unmask: new UnmaskJob(h.ctx),
  room: new RoomModel(h.ctx),
  stage: new StageJob(h.ctx),
});

const inverted: PhaseRelation = { zeroCorr: -0.9, bestCorr: -0.9, lagSamples: 0, lagMs: 0 };

const fastOver = (): Partial<Config> => ({
  ...tuned("phase", { ema: 1, sustain: 2 }),
  ...tuned("feedback", { sustainBlocks: 2 }),
});

const chOf = (c: MixerCall): number | null => ("ch" in c ? c.ch : null);

const callsTo = (h: Harness, ch: number, from = 0): MixerCall[] => h.mixer.calls.slice(from).filter((c) => chOf(c) === ch);

interface LockCase {
  name: string;
  job: string;
  target: number;
  setup?: (h: Harness, j: Jobs) => void;
  act: (h: Harness, j: Jobs) => void;
}

const loudVox = feat({ rmsDbfs: -10, peakDbfs: -8 });
const quietVox = feat({ rmsDbfs: -80, peakDbfs: -78 });

const cases: readonly LockCase[] = [
  {
    name: "unmask dips the instruments while the vocal is up",
    job: "unmask",
    target: 2,
    act: (_h, j) => j.unmask.handle(loudVox, 10),
  },
  {
    name: "unmask keeps converging a dip that was applied before the lock",
    job: "unmask",
    target: 2,
    setup: (_h, j) => j.unmask.handle(loudVox, 10),
    act: (_h, j) => {
      for (let k = 0; k < 40; k++) j.unmask.handle(quietVox, 11 + k);
    },
  },
  {
    name: "unmask release flattens the dip",
    job: "unmask",
    target: 3,
    setup: (_h, j) => j.unmask.handle(loudVox, 10),
    act: (_h, j) => j.unmask.release(),
  },
  {
    name: "phase flips the polarity of the second channel of a pair",
    job: "phase",
    target: 2,
    act: (_h, j) => {
      for (let k = 0; k < 4; k++) j.phase.handle(1, 2, inverted, 10 + k);
    },
  },
  {
    name: "reset notches clears a channel's parked notches",
    job: "feedback",
    target: 4,
    setup: (_h, j) => j.feedback.usedNotchBand.set(4, 1),
    act: (_h, j) => j.feedback.resetNotches(),
  },
  {
    name: "feedback notches the channel it heard ring",
    job: "feedback",
    target: 4,
    act: (_h, j) => {
      for (let k = 0; k < 6; k++) j.feedback.handle(4, feat({ fbFreq: 1000, rmsDbfs: -40 + k }));
    },
  },
  {
    name: "clip trims a hot preamp",
    job: "clip",
    target: 4,
    act: (_h, j) => j.clip.handle(4, feat({ peakDbfs: -0.2 }), 10),
  },
  {
    name: "clip restores a trimmed preamp",
    job: "clip",
    target: 4,
    setup: (h) => h.state.gainDb.set(4, 15),
    act: (_h, j) => j.clip.handle(4, feat({ peakDbfs: -30 }), 100),
  },
  {
    name: "balance rides a balance channel",
    job: "balance",
    target: 5,
    setup: (_h, j) => j.ride.balanceTargets.set(5, -10),
    act: (_h, j) => j.ride.handleBalance(5, feat({ rmsDbfs: -30 }), 10),
  },
  {
    name: "vocal ride rides the lead vocal",
    job: "vocal_ride",
    target: 1,
    act: (_h, j) => j.ride.handleVocal(feat({ rmsDbfs: -40 }), 10),
  },
];

const run = (c: LockCase, lock: boolean): { h: Harness; from: number; j: Jobs } => {
  const h = harness(fastOver());
  for (const k of Object.keys(h.state.enabled)) h.state.enabled[k] = true;
  const j = jobsFor(h);
  if (c.setup) c.setup(h, j);
  const from = h.mixer.calls.length;
  if (lock) h.locks.add(c.target);
  c.act(h, j);
  return { h, from, j };
};

for (const c of cases) {
  test(`a locked target gets no write: ${c.job}: ${c.name}`, () => {
    const free = run(c, false);
    assert.ok(callsTo(free.h, c.target, free.from).length > 0, `the unlocked run never wrote ch${c.target}, so the case proves nothing`);
    const held = run(c, true);
    assert.deepEqual(callsTo(held.h, c.target, held.from), [], `${c.job} wrote to locked ch${c.target}`);
  });
}

test("every job that writes a channel is covered by the lock table", () => {
  const covered = new Set(cases.map((c) => c.job));
  for (const job of ["unmask", "phase", "feedback", "clip", "balance", "vocal_ride"]) assert.ok(covered.has(job), job);
});

test("the room and stage models never write to the console", () => {
  const h = harness(fastOver());
  const j = jobsFor(h);
  for (let k = 0; k < 50; k++) {
    j.room.update(feat({ rmsDbfs: -10 + k, contrastDb: 20 }), k);
    j.stage.handle(feat({ rmsDbfs: -60 + 3 * k }), k);
  }
  assert.deepEqual(h.mixer.calls, []);
});

test("unmask only writes the unlocked targets and logs how many it ducked", () => {
  const h = harness();
  h.state.enabled.unmask = true;
  h.locks.add(2);
  h.locks.add(6);
  const job = new UnmaskJob(h.ctx);
  for (let k = 0; k < 20; k++) job.handle(loudVox, 10 + k);
  const written = [...new Set(h.mixer.calls.map(chOf))].sort((a, b) => (a ?? 0) - (b ?? 0));
  assert.deepEqual(written, [3, 4, 5, 7]);
  assert.equal(job.duckApplied.has(2), false);
  assert.equal(job.duckApplied.has(6), false);
  assert.ok(h.events.some((e) => e.msg.includes("on 4 instrument(s)")));
});

test("a dip applied before the lock is kept on the books and flattened once the lock is gone", () => {
  const h = harness();
  h.state.enabled.unmask = true;
  const job = new UnmaskJob(h.ctx);
  job.handle(loudVox, 10);
  const dipped = job.duckApplied.get(2);
  assert.ok(dipped !== undefined && dipped < 0);
  h.locks.add(2);
  const from = h.mixer.calls.length;
  job.release();
  assert.deepEqual(callsTo(h, 2, from), []);
  assert.equal(job.duckApplied.get(2), dipped);
  assert.deepEqual([...job.duckApplied.keys()], [2]);
  h.locks.delete(2);
  const after = h.mixer.calls.length;
  job.release();
  assert.deepEqual(callsTo(h, 2, after), [{ op: "eqBand", ch: 2, band: 4, hz: 3000, gainDb: 0, q: 1.2, on: true }]);
  assert.equal(job.duckApplied.size, 0);
});

test("a phase flip held back by a lock leaves the pair state alone and flips once the lock is gone", () => {
  const h = harness(fastOver());
  h.state.enabled.phase = true;
  const job = new PhaseJob(h.ctx, () => undefined);
  h.locks.add(2);
  for (let k = 0; k < 4; k++) job.handle(1, 2, inverted, 10 + k);
  assert.deepEqual(h.mixer.calls, []);
  assert.equal(job.polarity.get(2), false);
  assert.equal(job.lastPhaseAct.has("1,2"), false);
  h.locks.delete(2);
  job.handle(1, 2, inverted, 20);
  assert.deepEqual(h.mixer.calls, [{ op: "polarity", ch: 2, inverted: true }]);
  assert.equal(job.polarity.get(2), true);
});

test("reset notches leaves a locked channel's notches parked for a later reset", () => {
  const h = harness();
  const job = new FeedbackJob(h.ctx);
  job.usedNotchBand.set(2, 1);
  job.usedNotchBand.set(3, 2);
  h.locks.add(2);
  job.resetNotches();
  assert.deepEqual(h.mixer.calls, [{ op: "clearEq", ch: 3 }]);
  assert.equal(job.usedNotchBand.get(2), 1);
  assert.equal(job.usedNotchBand.get(3), 0);
  h.locks.delete(2);
  job.resetNotches();
  assert.deepEqual(h.mixer.calls.slice(1), [{ op: "clearEq", ch: 2 }]);
});

test("MixAssistant hands the engine's lock predicate to its jobs, and nothing is locked without one", () => {
  const cfg = defaultConfig();
  const locked = new MixAssistant(new RecordingMixer(), new ManualClock(), { config: cfg, locked: (ch) => ch === 2 });
  const free = new MixAssistant(new RecordingMixer(), new ManualClock(), { config: cfg });
  for (const a of [locked, free]) {
    a.enabled["unmask"] = true;
    a.onFeatures(1, loudVox, 10);
  }
  const chans = (a: MixAssistant): (number | null)[] => {
    const m = a.con;
    assert.ok(m instanceof RecordingMixer);
    return [...new Set(m.calls.filter((c) => c.op === "eqBand").map(chOf))].sort((x, y) => (x ?? 0) - (y ?? 0));
  };
  assert.deepEqual(chans(locked), [3, 4, 5, 6, 7]);
  assert.deepEqual(chans(free), [2, 3, 4, 5, 6, 7]);
});

const testCfg = defaultConfig();

class Sink {
  readonly sent: { addr: string; args: OscArg[] }[] = [];
  send(data: Uint8Array): void {
    const m = decodeMessage(data);
    assert.ok(m !== null);
    this.sent.push({ addr: m.address, args: m.args });
  }
  close(): void {}
}

class QuietSource extends CaptureSourceBase {
  block(): Frame {
    return new Map();
  }
}

const quietReceiver = (): MeterReceiverPort => ({ start: () => Promise.resolve(), stop: () => undefined });

const FADER = /^\/ch\/(\d\d)\/mix\/fader$/;
const GAIN = /^\/headamp\/(\d\d\d)\/gain$/;
const INVERT = /^\/ch\/(\d\d)\/preamp\/invert$/;

const answer = (e: Engine, sink: Sink): void => {
  const asked = new Set(sink.sent.filter((s) => s.args.length === 0).map((s) => s.addr));
  for (const address of asked) {
    e.consoleHeard();
    const f = FADER.exec(address);
    if (f !== null) {
      const pos = dbToFader(-10);
      e.consoleParam(address, [oscFloat(pos)]);
      e.reconcileFader(Number(f[1]), faderToDb(pos));
    } else if (GAIN.test(address)) e.consoleParam(address, [oscFloat((35 + 12) / 72)]);
    else if (INVERT.test(address)) e.consoleParam(address, [oscInt(0)]);
  }
};

const drive = async (e: Engine, clock: StepClock, seconds: number): Promise<void> => {
  for (let i = 0; i < Math.round(seconds / 0.1); i++) {
    e.consoleHeard();
    await clock.advance(0.1);
  }
};

const block = (feats: ReadonlyArray<[number, Partial<ChannelFeatures>]>): AnalysedBlock => ({
  feats: new Map(feats.map(([ch, f]) => [ch, { ...emptyFeatures(), ...f }])),
  phases: [],
});

test("from the armed state, unmask never writes EQ to a channel locked by hand moves", async () => {
  const clock = new StepClock(100, 1_700_000_000);
  const sink = new Sink();
  const con = new OscConsole(sink, { cfg: testCfg, clock });
  const e = new Engine({ cfg: testCfg, clock, sim: false, console: con, source: new QuietSource(), tick: 0.05 });
  e.meterRx = quietReceiver();
  await e.start();
  try {
    answer(e, sink);
    await drive(e, clock, 1.3);
    assert.equal(e.held, false);
    e.command({ type: "toggle", job: "unmask", on: true });
    e.reconcileFader(2, -3);
    await drive(e, clock, 1.0);
    e.reconcileFader(2, 0);
    await drive(e, clock, 1.0);
    e.reconcileFader(2, -6);
    assert.equal(e.channelLocked(2), true);
    const from = sink.sent.length;
    e.onPushedBlock(block([[1, { rmsDbfs: -10, peakDbfs: -8 }]]), 0);
    await drive(e, clock, 0.5);
    const eqWrites = (ch: number): string[] =>
      sink.sent
        .slice(from)
        .filter((s) => s.args.length > 0 && s.addr.startsWith(`/ch/0${ch}/eq/4/`))
        .map((s) => s.addr);
    assert.ok(eqWrites(3).length > 0, "unmask did not duck an unlocked channel");
    assert.deepEqual(eqWrites(2), [], "unmask wrote EQ to the hand-locked ch2");
  } finally {
    await e.stop();
  }
});
