import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysedBlock } from "../src/core/blockanalysis.ts";
import { CaptureSourceBase } from "../src/core/capture.ts";
import type { BlockHandler, Frame } from "../src/core/capture.ts";
import { ManualClock } from "../src/core/clock.ts";
import { configWith, defaultConfig } from "../src/core/config.ts";
import { SimConsole, dbToFader, faderToDb } from "../src/core/console.ts";
import { emptyFeatures } from "../src/core/dsp.ts";
import { Engine } from "../src/core/engine/index.ts";
import type { HoldReason } from "../src/core/engine/hold.ts";
import { oscFloat, oscInt } from "../src/core/oscwire.ts";
import type { OscArg } from "../src/core/oscwire.ts";
import type { MeterReceiverPort } from "../src/core/ports.ts";
import { fromObject } from "../src/core/template.ts";
import type { Lane } from "../src/core/writegov.ts";

const base = defaultConfig();
const cfg = configWith({
  link: { ...base.link, probeS: 0.75, staleS: 1.5, downS: 2.5, steadyS: 1.0, syncRetryS: 0.5, syncTries: 2, resyncS: 2.0 },
  safety: { ...base.safety, lockMoves: 2 },
  CHANNELS: new Map([
    [1, "lead_vox"],
    [2, "harm_vox_l"],
    [3, "meas_mic"],
  ]),
  MEAS_MIC_CH: 3,
  BALANCE_CHANNELS: [],
});

const template = fromObject({ name: "hold model", songs: [{ name: "Song", scene: 5 }] }, cfg);

const TICK = 0.5;
const START = 100;
const GAP = 8;
const HAND_CH = 2;
const FAIL_FADER = "/ch/01/mix/fader";
const GAP_GAIN = "/headamp/000/gain";

const FADER = /^\/ch\/(\d\d)\/mix\/fader$/;
const GAIN = /^\/headamp\/(\d\d\d)\/gain$/;
const INVERT = /^\/ch\/(\d\d)\/preamp\/invert$/;
const CH_ADDR = /^\/ch\/(\d\d)\//;

const isRead = (address: string): boolean => FADER.test(address) || GAIN.test(address) || INVERT.test(address);

const channelOf = (address: string): number | null => {
  const c = CH_ADDR.exec(address);
  if (c !== null) return Number(c[1]);
  const g = GAIN.exec(address);
  return g !== null ? Number(g[1]) + 1 : null;
};

class ParkedClock extends ManualClock {
  override sleep(_seconds: number): Promise<void> {
    return new Promise<void>(() => undefined);
  }
}

class PushedSource extends CaptureSourceBase {
  block(): Frame {
    return new Map();
  }
  subscribe(_handler: BlockHandler): void {}
}

interface Wire {
  lane: Lane;
  addr: string;
  args: OscArg[];
}

class LaneConsole extends SimConsole {
  storm = false;
  onWire: ((w: Wire) => void) | null = null;

  protected override send(addr: string, ...args: OscArg[]): void {
    if (this.onWire !== null) this.onWire({ lane: this.lane, addr, args });
    super.send(addr, ...args);
  }

  override storming(_now: number): boolean {
    return this.storm;
  }
}

class ModelEngine extends Engine {
  reasons(): HoldReason[] {
    return [...this.holdReasons];
  }
  get hasLink(): boolean {
    return this.link !== null;
  }
  get linkState(): string | null {
    return this.link === null ? null : this.link.state;
  }
  get isAdopted(): boolean {
    return this.adopted;
  }
  get readOnce(): boolean {
    return this.syncedOnce;
  }
  get readActive(): boolean {
    return this.syncing;
  }
  lockedNow(): number[] {
    return this.outside.lockedChannels();
  }
  wake(now: number, gapS: number): void {
    this.onResume(now, gapS);
  }
}

const EVENTS = [
  "tick",
  "wait1",
  "waitDown",
  "hear",
  "reply",
  "replyFail",
  "replyGap",
  "resume",
  "storm",
  "fault",
  "press",
  "release",
  "hand",
  "auto",
  "scene",
] as const;

type Ev = (typeof EVENTS)[number];

const TIMED: ReadonlySet<Ev> = new Set<Ev>(["tick", "wait1", "waitDown", "resume"]);

const clipBlock = (ch: number): AnalysedBlock => ({
  feats: new Map([[ch, { ...emptyFeatures(), rmsDbfs: -6, peakDbfs: -0.2 }]]),
  phases: [],
});

interface Coverage {
  entered: Set<string>;
  exited: Set<string>;
  autoWrites: number;
  locks: number;
  unlocks: number;
  rearms: number;
  bareReleases: number;
  laterAdoptions: number;
}

const newCoverage = (): Coverage => ({
  entered: new Set(),
  exited: new Set(),
  autoWrites: 0,
  locks: 0,
  unlocks: 0,
  rearms: 0,
  bareReleases: 0,
  laterAdoptions: 0,
});

class Harness {
  readonly e: ModelEngine;
  readonly con: LaneConsole;
  readonly clock: ParkedClock;
  readonly cov: Coverage;
  readonly trail: string[] = [];
  talking = false;
  round = 0;
  hands = 0;
  lastNow: number;
  lastHeard: number | null = null;
  runStart: number | null = null;
  outstanding = new Set<string>();
  unansweredFaders = new Set<string>();
  gainAnswered = new Set<number>();
  startNominal: Map<number, number>;
  frozenNominal: Map<number, number> | null = null;
  violation: string | null = null;
  event: Ev | null = null;

  constructor(e: ModelEngine, con: LaneConsole, clock: ParkedClock, cov: Coverage) {
    this.e = e;
    this.con = con;
    this.clock = clock;
    this.cov = cov;
    this.lastNow = clock.monotonic();
    this.startNominal = new Map(e.assistant.nominalGain);
    con.onWire = (w) => this.wire(w);
  }

  fail(why: string): never {
    assert.fail(`${why}\n  after: ${this.trail.join(" -> ")}`);
  }

  private wire(w: Wire): void {
    if (w.lane === "safety" && w.args.length === 0 && isRead(w.addr)) {
      this.outstanding.add(w.addr);
      if (FADER.test(w.addr)) this.unansweredFaders.add(w.addr);
      return;
    }
    const reasons = this.e.reasons();
    if (w.lane === "manual" && reasons.length > 0 && this.event !== "scene")
      this.violation ??= `${w.addr} sent on ${String(this.event)} while on hold for ${reasons.join(", ")}`;
    if (w.lane !== "auto") return;
    const ch = channelOf(w.addr);
    if (reasons.length > 0) this.violation ??= `automatic write ${w.addr} while on hold for ${reasons.join(", ")}`;
    else if (this.e.status === "takeover") this.violation ??= `automatic write ${w.addr} during TAKEOVER`;
    else if (ch !== null && this.e.lockedNow().includes(ch)) this.violation ??= `automatic write ${w.addr} to locked ch${ch}`;
    else this.cov.autoWrites += 1;
  }

  heard(): void {
    const now = this.clock.monotonic();
    if (this.lastHeard === null || now - this.lastHeard > cfg.link.staleS) this.runStart = now;
    this.lastHeard = now;
    this.e.consoleHeard();
  }

  private stepTo(now: number): void {
    if (this.talking) this.heard();
    this.e.step(now, this.lastNow);
    this.lastNow = now;
  }

  private advance(seconds: number, ev: Ev): void {
    const n = Math.round(seconds / TICK);
    for (let i = 0; i < n; i++) {
      const pre = this.state();
      this.clock.advance(TICK);
      this.stepTo(this.clock.monotonic());
      this.check(pre, ev);
    }
  }

  private reply(withhold: string | null): void {
    const gain = 35 - 4 * this.round;
    this.round += 1;
    const asked = [...this.outstanding].sort();
    this.outstanding.clear();
    for (const address of asked) {
      if (address === withhold) continue;
      this.heard();
      const f = FADER.exec(address);
      if (f !== null) {
        const pos = dbToFader(-10);
        this.e.consoleParam(address, [oscFloat(pos)]);
        this.e.reconcileFader(Number(f[1]), faderToDb(pos));
        this.unansweredFaders.delete(address);
        continue;
      }
      const g = GAIN.exec(address);
      if (g !== null) {
        this.e.consoleParam(address, [oscFloat((gain + 12) / 72)]);
        this.gainAnswered.add(Number(g[1]) + 1);
        continue;
      }
      const i = INVERT.exec(address);
      if (i !== null) this.e.consoleParam(address, [oscInt(Number(i[1]) === 2 ? 1 : 0)]);
    }
  }

  run(ev: Ev): void {
    this.trail.push(ev);
    this.event = ev;
    if (ev === "tick") return this.advance(TICK, ev);
    if (ev === "wait1") return this.advance(cfg.link.steadyS, ev);
    if (ev === "waitDown") return this.advance(cfg.link.downS, ev);
    const pre = this.state();
    this.apply(ev);
    this.check(pre, ev);
  }

  private apply(ev: Ev): void {
    const e = this.e;
    switch (ev) {
      case "hear":
        this.talking = !this.talking;
        break;
      case "reply":
        this.reply(null);
        break;
      case "replyFail":
        this.reply(FAIL_FADER);
        break;
      case "replyGap":
        this.reply(GAP_GAIN);
        break;
      case "resume": {
        this.clock.advance(GAP);
        const now = this.clock.monotonic();
        this.lastHeard = null;
        this.runStart = null;
        e.wake(now, now - this.lastNow);
        this.stepTo(now);
        break;
      }
      case "storm":
        this.con.storm = !this.con.storm;
        break;
      case "fault":
        e.fault("model fault");
        break;
      case "press":
        e.command({ type: "panic", on: true });
        break;
      case "release":
        e.command({ type: "panic", on: false });
        break;
      case "hand":
        this.heard();
        this.hands += 1;
        e.reconcileFader(HAND_CH, -20 - 3 * this.hands);
        break;
      case "auto":
        e.onPushedBlock(clipBlock(HAND_CH), 0);
        break;
      case "scene":
        e.command({ type: "scene", index: 5 });
        break;
    }
  }

  state(): State {
    return {
      reasons: new Set(this.e.reasons()),
      takeover: this.e.status === "takeover",
      locked: this.e.lockedNow(),
      once: this.e.readOnce,
      events: this.e.events.length,
    };
  }

  check(pre: State, ev: Ev): void {
    const e = this.e;
    const post = this.state();
    const r = post.reasons;
    const armed = r.size === 0;
    const now = this.clock.monotonic();

    if (this.violation !== null) this.fail(this.violation);
    const said = e.events.slice(pre.events).map((x) => x.msg);
    const errors = said.filter((m) => m.startsWith("engine error"));
    if (errors.length > 0) this.fail(`the engine swallowed an error: ${errors[0] ?? ""}`);
    const rearmed = said.filter((m) => m.startsWith("automatic jobs re-armed")).length;
    const onHold = said.filter((m) => m.startsWith("automatic jobs on hold")).length;
    if (rearmed !== (pre.reasons.size > 0 && armed ? 1 : 0))
      this.fail(`${rearmed} re-arm message(s) for a hold of ${pre.reasons.size} -> ${r.size} reason(s)`);
    if (onHold !== (pre.reasons.size === 0 && !armed ? 1 : 0))
      this.fail(`${onHold} on-hold message(s) for a hold of ${pre.reasons.size} -> ${r.size} reason(s)`);

    if (this.con.mainMuted !== post.takeover) this.fail(`main muted is ${this.con.mainMuted} with TAKEOVER ${post.takeover}`);
    if (e.held !== !armed) this.fail(`held is ${e.held} with reasons [${[...r].join(", ")}]`);
    const snap = e.snapshot();
    assert.deepEqual(snap["hold"], { held: !armed, reasons: [...r] }, `snapshot hold is stale after ${this.trail.join(" -> ")}`);
    assert.deepEqual(snap["locked_channels"], post.locked, `snapshot locked_channels is stale after ${this.trail.join(" -> ")}`);

    for (const x of r) if (!pre.reasons.has(x)) this.cov.entered.add(x);
    for (const x of pre.reasons) if (!r.has(x)) this.cov.exited.add(x);

    if (e.hasLink) {
      if (r.has("no-feedback")) this.fail("no-feedback while the console link is watched");
      if (!e.isAdopted && !r.has("unsynced")) this.fail("the desk read is not adopted but unsynced is not held");
      if (e.readActive && !r.has("unsynced")) this.fail("a desk read is running but unsynced is not held");
      if (armed) {
        if (e.linkState !== "up") this.fail(`armed with the link ${String(e.linkState)}`);
        if (this.unansweredFaders.size > 0) this.fail(`armed with fader reads unanswered: ${[...this.unansweredFaders].join(", ")}`);
        if (this.lastHeard === null || now - this.lastHeard > cfg.link.staleS) this.fail("armed after more than staleS of silence");
      }
      if (pre.reasons.size > 0 && armed) {
        if (this.runStart === null || now - this.runStart < cfg.link.steadyS) this.fail("re-armed before the link was steady for steadyS");
      }
      if (TIMED.has(ev)) {
        const st = e.linkState;
        if ((st === "stale" || st === "down") && !r.has("link")) this.fail(`link ${st} but no link hold`);
        if (st === "up" && e.isAdopted && !e.readActive) {
          for (const x of ["unsynced", "resume", "link"] as const)
            if (r.has(x)) this.fail(`${x} still held with the desk read adopted and the link up`);
        }
      }
    }

    if (pre.reasons.has("no-feedback") && !r.has("no-feedback")) this.fail("no-feedback cleared");
    const released = ev === "release" && pre.takeover;
    if (ev === "release" && !pre.takeover) this.cov.bareReleases += 1;
    for (const x of ["internal-error", "write-storm"] as const) {
      if (pre.reasons.has(x) && !r.has(x) && !released) this.fail(`${x} cleared without a TAKEOVER release`);
      if (released && r.has(x)) this.fail(`${x} still held after a TAKEOVER release`);
    }
    for (const x of ["unsynced", "link", "resume"] as const) {
      if (!pre.reasons.has(x) || r.has(x)) continue;
      if (!TIMED.has(ev)) this.fail(`${x} cleared by ${ev}, which is not a tick`);
      if (e.linkState !== "up") this.fail(`${x} cleared with the link ${String(e.linkState)}`);
      if (x !== "link" && !e.isAdopted) this.fail(`${x} cleared before the desk read was adopted`);
      if (x === "link" && r.has("unsynced")) this.fail("link cleared while the desk is still unread");
    }
    if (released) {
      if (post.locked.length > 0) this.fail(`ch${post.locked.join(", ch")} still locked after a TAKEOVER release`);
      if (pre.locked.length > 0) this.cov.unlocks += 1;
    }
    if (!released && pre.locked.some((ch) => !post.locked.includes(ch))) this.fail(`a lock went away on ${ev}`);
    for (const ch of post.locked) if (!pre.locked.includes(ch)) this.cov.locks += 1;

    if (ev === "fault" && !r.has("internal-error")) this.fail("a fault did not hold for internal-error");
    if (TIMED.has(ev) && this.con.storm && !r.has("write-storm")) this.fail("a write storm did not hold for write-storm");
    if (ev === "resume" && e.hasLink && !(r.has("resume") && r.has("unsynced"))) this.fail("a resume did not hold for resume and unsynced");
    if (ev === "scene" && e.hasLink && !pre.takeover && !r.has("unsynced")) this.fail("a scene recall did not hold for unsynced");

    const nominal = e.assistant.nominalGain;
    if (!post.once) {
      assert.deepEqual(new Map(nominal), this.startNominal, `nominal gain moved before any read: ${this.trail.join(" -> ")}`);
    } else if (this.frozenNominal === null) {
      for (const ch of this.gainAnswered) {
        if (nominal.get(ch) !== e.assistant.gainDb.get(ch)) this.fail(`nominal gain of ch${ch} is not the first read's gain`);
      }
      this.frozenNominal = new Map(nominal);
    } else {
      if (pre.reasons.has("unsynced") && !r.has("unsynced")) this.cov.laterAdoptions += 1;
      assert.deepEqual(new Map(nominal), this.frozenNominal, `nominal gain changed after the first read: ${this.trail.join(" -> ")}`);
    }

    if (pre.reasons.size > 0 && armed) this.cov.rearms += 1;
  }
}

interface State {
  reasons: Set<HoldReason>;
  takeover: boolean;
  locked: number[];
  once: boolean;
  events: number;
}

const okReceiver = (): MeterReceiverPort => ({ start: () => Promise.resolve(), stop: () => undefined });
const busyReceiver = (): MeterReceiverPort => ({ start: () => Promise.reject(new Error("EADDRINUSE")), stop: () => undefined });

interface Seed {
  name: string;
  busy: boolean;
  prefix: readonly Ev[];
  expect: readonly HoldReason[];
  depth: number;
}

const ARMED: readonly Ev[] = ["hear", "reply", "wait1"];

const SEEDS: readonly Seed[] = [
  { name: "cold", busy: false, prefix: [], expect: ["unsynced"], depth: 3 },
  { name: "armed", busy: false, prefix: ARMED, expect: [], depth: 3 },
  { name: "no-feedback", busy: true, prefix: [], expect: ["no-feedback"], depth: 2 },
  {
    name: "relinking",
    busy: false,
    prefix: [...ARMED, "hear", "waitDown", "hear", "wait1", "tick"],
    expect: ["link", "unsynced"],
    depth: 2,
  },
  { name: "stormed", busy: false, prefix: [...ARMED, "storm", "tick", "storm"], expect: ["write-storm"], depth: 2 },
  { name: "locked", busy: false, prefix: [...ARMED, "hand", "hand"], expect: [], depth: 2 },
  { name: "failing", busy: false, prefix: ["hear", "replyFail", "wait1", "wait1"], expect: ["unsynced"], depth: 2 },
  { name: "woken", busy: false, prefix: [...ARMED, "resume", "reply"], expect: ["resume", "unsynced"], depth: 2 },
];

const build = async (seed: Seed, cov: Coverage): Promise<Harness> => {
  const clock = new ParkedClock(START, 1_700_000_000);
  const con = new LaneConsole({ cfg });
  const e = new ModelEngine({ cfg, clock, sim: false, console: con, source: new PushedSource(), tick: TICK, template });
  e.meterRx = seed.busy ? busyReceiver() : okReceiver();
  const h = new Harness(e, con, clock, cov);
  await e.start();
  for (const r of e.reasons()) cov.entered.add(r);
  h.trail.push(`[${seed.name}]`);
  for (const ev of seed.prefix) h.run(ev);
  assert.deepEqual(e.reasons().sort(), [...seed.expect].sort(), `seed ${seed.name} did not reach its state`);
  return h;
};

const forEachSequence = async (size: number, len: number, visit: (seq: readonly number[]) => Promise<void>): Promise<number> => {
  const seq: number[] = new Array<number>(len).fill(0);
  let count = 0;
  for (;;) {
    await visit(seq);
    count++;
    let i = len - 1;
    while (i >= 0 && seq[i] === size - 1) {
      seq[i] = 0;
      i--;
    }
    if (i < 0) return count;
    seq[i] = (seq[i] ?? 0) + 1;
  }
};

const explore = (seed: Seed, cov: Coverage): Promise<number> =>
  forEachSequence(EVENTS.length, seed.depth, async (seq) => {
    const h = await build(seed, cov);
    try {
      for (const k of seq) h.run(EVENTS[k]!);
    } finally {
      await h.e.stop();
    }
  });

test("hold model: every event sequence up to the bound keeps the hold invariants", async () => {
  const cov = newCoverage();
  const t0 = performance.now();
  const counts: Record<string, number> = {};
  for (const seed of SEEDS) counts[seed.name] = await explore(seed, cov);
  const ms = performance.now() - t0;
  const all = ["unsynced", "link", "no-feedback", "resume", "write-storm", "internal-error"];
  assert.deepEqual([...cov.entered].sort(), [...all].sort(), "a hold reason was never entered");
  assert.deepEqual([...cov.exited].sort(), all.filter((x) => x !== "no-feedback").sort(), "a hold reason was never cleared");
  assert.ok(cov.autoWrites > 0, "no automatic write was ever seen, so the write checks are vacuous");
  assert.ok(cov.locks > 0 && cov.unlocks > 0, "no channel was locked and handed back");
  assert.ok(cov.rearms > 0 && cov.bareReleases > 0 && cov.laterAdoptions > 0, JSON.stringify(cov));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(
    `hold model: ${total} sequences ${JSON.stringify(counts)}, ${EVENTS.length} events, ${Math.round(ms)} ms, ${JSON.stringify({ ...cov, entered: cov.entered.size, exited: cov.exited.size })}`,
  );
});
