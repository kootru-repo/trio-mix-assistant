import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/core/config.ts";
import { type OscArg, oscFloat } from "../src/core/oscwire.ts";
import { type GovernorOptions, type Lane, sameArgs, WriteGovernor } from "../src/core/writegov.ts";

type Limited = "manual" | "auto";

type Event =
  | { kind: "submit"; lane: Lane; address: string; args: readonly OscArg[] }
  | { kind: "pump" }
  | { kind: "wait"; dt: number }
  | { kind: "bad"; lane: Limited | null; t: number }
  | { kind: "flood"; lane: Limited };

interface Owed {
  args: readonly OscArg[];
  lane: Limited;
}

interface Meter {
  readonly rate: number;
  readonly cap: number;
  n: number;
  best: number;
}

interface Coverage {
  sequences: number;
  calls: number;
  merged: number;
  skipped: number;
  queued: number;
  cancelledAuto: number;
  keptManual: number;
  storming: number;
}

const safety = defaultConfig().safety;
const DEFAULTS: GovernorOptions = {
  manualPerS: safety.manualPerS,
  manualBurst: safety.manualBurst,
  autoPerS: safety.autoPerS,
  autoBurst: safety.autoBurst,
  totalPerS: safety.totalPerS,
  repeatS: safety.repeatS,
  stormS: safety.stormS,
};
const TIGHT: GovernorOptions = { ...DEFAULTS, manualPerS: 2, manualBurst: 1, autoPerS: 0.25, autoBurst: 1, totalPerS: 1.5 };

const X = [oscFloat(0.25)];
const Y = [oscFloat(0.75)];
const QUERY: readonly OscArg[] = [];

const describe = (seq: readonly Event[]): string =>
  seq
    .map((e) => {
      if (e.kind === "submit") return `${e.lane}${e.address}=${e.args.length === 0 ? "?" : e.args[0]?.v}`;
      if (e.kind === "wait") return `wait${e.dt}`;
      if (e.kind === "bad") return `${e.lane ?? "pump"}@${e.t}`;
      if (e.kind === "flood") return `flood:${e.lane}`;
      return "pump";
    })
    .join(", ");

class Harness {
  readonly o: GovernorOptions;
  readonly gov: WriteGovernor;
  readonly seq: readonly Event[];
  readonly cov: Coverage;
  step = 0;
  now = 0;
  clock = 0;
  started = false;
  calls: { address: string; args: readonly OscArg[] }[] = [];
  readonly lastEmit = new Map<string, { args: readonly OscArg[]; at: number }>();
  readonly latest = new Map<string, Owed>();
  readonly owed = new Map<string, Owed>();
  readonly desired = new Map<string, readonly OscArg[]>();
  readonly meters: Record<Limited | "total", Meter>;
  safetySubmits = 0;
  limitedSubmits = 0;
  cancelled = 0;
  sent = 0;
  autoSince: number | null = null;
  floods = 0;
  early: Limited[] = [];

  constructor(o: GovernorOptions, seq: readonly Event[], cov: Coverage) {
    this.o = o;
    this.seq = seq;
    this.cov = cov;
    this.gov = new WriteGovernor(o, (address, args) => this.calls.push({ address, args }));
    this.meters = {
      manual: { rate: o.manualPerS, cap: o.manualBurst, n: 0, best: Number.NEGATIVE_INFINITY },
      auto: { rate: o.autoPerS, cap: o.autoBurst, n: 0, best: Number.NEGATIVE_INFINITY },
      total: { rate: o.totalPerS, cap: o.totalPerS, n: 0, best: Number.NEGATIVE_INFINITY },
    };
  }

  check(ok: boolean, msg: string): void {
    if (!ok) assert.fail(`${msg} at step ${this.step} of [${describe(this.seq)}] with ${JSON.stringify(this.o)}`);
  }

  advance(now: number): void {
    if (!Number.isFinite(now)) return;
    if (!this.started) {
      this.started = true;
      this.clock = now;
      for (const lane of this.early) this.metered(lane);
      this.early = [];
    } else if (now > this.clock) {
      this.clock = now;
    }
  }

  meter(m: Meter): void {
    m.best = Math.max(m.best, m.rate * this.clock - m.n);
    this.check(m.n + 1 - m.rate * this.clock + m.best <= m.cap + 1e-6, "more writes than the bucket allows in a window");
    m.n++;
  }

  record(address: string, args: readonly OscArg[], lane: Lane): void {
    this.lastEmit.set(address, { args, at: this.clock });
    this.sent++;
    if (lane === "safety") return;
    if (this.started) this.metered(lane);
    else this.early.push(lane);
  }

  metered(lane: Limited): void {
    this.meter(this.meters[lane]);
    this.meter(this.meters.total);
  }

  drained(skip: string | null): void {
    const seen = new Set<string>();
    for (const c of this.calls) {
      if (c.address === skip) continue;
      this.check(!seen.has(c.address), "an address was written twice in one call");
      seen.add(c.address);
      const owed = this.owed.get(c.address);
      this.check(owed !== undefined, "a write was sent that was not waiting");
      if (owed === undefined) return;
      this.check(sameArgs(c.args, owed.args), "a stale value was sent");
      this.owed.delete(c.address);
      this.record(c.address, c.args, owed.lane);
    }
  }

  submit(lane: Lane, address: string, args: readonly OscArg[], now: number): void {
    const before = this.gov.stats();
    const backlog = this.gov.backlog();
    this.advance(now);
    this.calls = [];
    this.gov.submit(lane, address, args, now);
    const after = this.gov.stats();
    if (lane === "safety") {
      this.safetySubmits++;
      this.check(this.calls.length === 1, "a safety write was not sent alone and at once");
      const c = this.calls[0];
      this.check(c !== undefined && c.address === address && sameArgs(c.args, args), "a safety write was changed");
      const owed = this.owed.get(address);
      const cancel = owed !== undefined && (args.length > 0 || owed.lane === "auto");
      this.check(this.gov.backlog() === backlog - (cancel ? 1 : 0), "a safety write cancelled the wrong queued write");
      if (cancel) {
        this.owed.delete(address);
        this.cancelled++;
        if (args.length === 0) this.cov.cancelledAuto++;
      } else if (owed !== undefined) {
        this.cov.keptManual++;
      }
      this.check(
        after.merged === before.merged && after.skipped === before.skipped && after.queued === before.queued,
        "a safety write was counted as limited",
      );
      this.record(address, args, "safety");
      this.desired.set(address, args.length === 0 && owed !== undefined && !cancel ? owed.args : args);
      return;
    }
    this.limitedSubmits++;
    const merged = after.merged - before.merged;
    const skipped = after.skipped - before.skipped;
    const queued = after.queued - before.queued;
    this.check(merged + skipped + queued <= 1, "one write was counted twice");
    const prior = this.owed.get(address);
    const last = this.lastEmit.get(address);
    const repeat = last !== undefined && this.clock - last.at < this.o.repeatS && sameArgs(last.args, args);
    this.latest.set(address, { args, lane });
    if (prior !== undefined) {
      this.check(merged === 1, "a write to a waiting address was not merged");
      this.owed.set(address, { args, lane });
      this.drained(null);
      this.cov.merged++;
    } else {
      this.check(skipped === (repeat ? 1 : 0), repeat ? "a repeat was not skipped" : "a new value was skipped");
      const own = this.calls.filter((c) => c.address === address);
      this.check(own.length <= 1, "a new write was sent twice");
      const sentNow = own.length === 1;
      this.drained(address);
      if (sentNow) {
        const c = own[0];
        this.check(c !== undefined && sameArgs(c.args, args) && queued === 0 && skipped === 0, "a sent write was also counted as waiting");
        this.record(address, args, lane);
      } else if (queued === 1) {
        this.owed.set(address, { args, lane });
        this.cov.queued++;
      } else {
        this.check(skipped === 1, "a write vanished");
        this.cov.skipped++;
      }
    }
    this.desired.set(address, args);
  }

  pump(now: number): void {
    this.advance(now);
    this.calls = [];
    this.gov.pump(now);
    this.drained(null);
  }

  invariants(): void {
    const st = this.gov.stats();
    let manual = 0;
    for (const p of this.owed.values()) if (p.lane === "manual") manual++;
    this.check(this.gov.backlog() === this.owed.size, "backlog differs from the waiting writes");
    this.check(this.gov.backlog("manual") === manual, "manual backlog differs");
    this.check(this.gov.backlog("auto") === this.owed.size - manual, "auto backlog differs");
    this.check(st.sent === this.sent, "sent count differs from the writes emitted");
    const accounted = this.safetySubmits + this.limitedSubmits - st.merged - st.skipped - this.cancelled - this.owed.size;
    this.check(st.sent === accounted, "counts do not add up");
    if (this.gov.backlog("auto") === 0) this.autoSince = null;
    else if (this.started) this.autoSince ??= this.clock;
    const since = this.autoSince;
    const probes =
      since === null ? [this.clock - 1, this.clock, this.clock + 100] : [this.clock, since + this.o.stormS - 0.25, since + this.o.stormS];
    for (const q of probes) {
      const want = since !== null && Math.max(q, this.clock) - since >= this.o.stormS;
      this.check(this.gov.storming(q) === want, "storming differs from how long the auto backlog has lasted");
    }
    const byClock = since !== null && this.clock - since >= this.o.stormS;
    for (const q of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
      this.check(this.gov.storming(q) === byClock, `storming(${q}) differs from storming by the governor's own clock`);
    if (since !== null && this.gov.storming(this.clock)) this.cov.storming++;
  }

  run(e: Event): void {
    if (e.kind === "wait") {
      this.now += e.dt;
      return;
    }
    if (e.kind === "pump") this.pump(this.now);
    else if (e.kind === "submit") this.submit(e.lane, e.address, e.args, this.now);
    else if (e.kind === "bad") {
      if (e.lane === null) this.pump(e.t);
      else this.submit(e.lane, "/a", X, e.t);
    } else {
      const n = (e.lane === "manual" ? this.o.manualBurst : this.o.autoBurst) + 3;
      for (let i = 0; i < n; i++) {
        this.submit(e.lane, `/fill/${this.floods}/${i}`, X, this.now);
        this.invariants();
      }
      this.floods++;
    }
    this.invariants();
    this.cov.calls++;
  }

  flush(): void {
    for (let i = 1; i <= 20 && this.gov.backlog() > 0; i++) {
      this.pump(this.clock + 100);
      this.invariants();
    }
    this.check(this.gov.backlog() === 0 && this.owed.size === 0, "writes were left waiting after a long pump");
    this.check(!this.gov.storming(this.clock), "still storming with no backlog");
    for (const [address, args] of this.desired) {
      const last = this.lastEmit.get(address);
      this.check(last !== undefined && sameArgs(last.args, args), `the last value for ${address} was lost`);
    }
  }
}

function enumerate(alphabet: readonly Event[], depth: number, visit: (seq: readonly Event[]) => void, prefix: readonly Event[] = []): void {
  const seq: Event[] = [...prefix];
  const limit = prefix.length + depth;
  const go = (): void => {
    visit(seq);
    if (seq.length === limit) return;
    for (const e of alphabet) {
      seq.push(e);
      go();
      seq.pop();
    }
  };
  go();
}

const newCoverage = (): Coverage => ({
  sequences: 0,
  calls: 0,
  merged: 0,
  skipped: 0,
  queued: 0,
  cancelledAuto: 0,
  keptManual: 0,
  storming: 0,
});

function explore(o: GovernorOptions, alphabet: readonly Event[], depth: number, prefix: readonly Event[] = [], start = 0): Coverage {
  const cov = newCoverage();
  enumerate(
    alphabet,
    depth,
    (seq) => {
      const h = new Harness(o, seq, cov);
      h.now = start;
      for (let i = 0; i < seq.length; i++) {
        h.step = i;
        const e = seq[i];
        if (e !== undefined) h.run(e);
      }
      h.flush();
      cov.sequences++;
    },
    prefix,
  );
  return cov;
}

const submits = (lanes: readonly Limited[], addresses: readonly string[]): Event[] =>
  lanes.flatMap((lane) => addresses.flatMap((address) => [X, Y].map((args) => ({ kind: "submit" as const, lane, address, args }))));

const SAFETY: Event[] = [
  { kind: "submit", lane: "safety", address: "/a", args: X },
  { kind: "submit", lane: "safety", address: "/a", args: QUERY },
];

const TIME = (o: GovernorOptions): Event[] => [
  { kind: "pump" },
  { kind: "wait", dt: 1 / o.manualPerS / 2 },
  { kind: "wait", dt: 1 / o.manualPerS },
  { kind: "wait", dt: o.repeatS },
];

const sum = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0);

test("the governor keeps its budget, its latest values, its counts and its storm flag for every sequence up to depth 5 on a tight budget", () => {
  const alphabet = [...submits(["manual", "auto"], ["/a", "/b"]), ...SAFETY, ...TIME(TIGHT)];
  const cov = explore(TIGHT, alphabet, 5);
  assert.equal(alphabet.length, 14);
  assert.equal(cov.sequences, sum([0, 1, 2, 3, 4, 5].map((d) => 14 ** d)));
  assert.ok(cov.merged > 0 && cov.skipped > 0 && cov.queued > 0, JSON.stringify(cov));
  assert.ok(cov.cancelledAuto > 0 && cov.keptManual > 0 && cov.storming > 0, JSON.stringify(cov));
});

test("the governor keeps the same properties on the default budget after floods of each lane", () => {
  const alphabet = [...submits(["manual", "auto"], ["/a"]), ...SAFETY, ...TIME(DEFAULTS)];
  const floods: Event[][] = [
    [{ kind: "flood", lane: "manual" }],
    [{ kind: "flood", lane: "auto" }],
    [
      { kind: "flood", lane: "manual" },
      { kind: "flood", lane: "auto" },
    ],
  ];
  const total = newCoverage();
  for (const prefix of floods) {
    const cov = explore(DEFAULTS, alphabet, 3, prefix);
    total.sequences += cov.sequences;
    total.merged += cov.merged;
    total.queued += cov.queued;
    total.skipped += cov.skipped;
    total.cancelledAuto += cov.cancelledAuto;
    total.keptManual += cov.keptManual;
    total.storming += cov.storming;
  }
  assert.equal(total.sequences, 3 * sum([0, 1, 2, 3].map((d) => alphabet.length ** d)));
  assert.ok(total.queued > 0 && total.merged > 0 && total.skipped > 0, JSON.stringify(total));
  assert.ok(total.cancelledAuto > 0 && total.keptManual > 0 && total.storming > 0, JSON.stringify(total));
});

test("the governor keeps the same properties when time goes backwards or is not a finite number", () => {
  const alphabet: Event[] = [
    ...submits(["manual", "auto"], ["/a"]),
    ...SAFETY,
    { kind: "pump" },
    { kind: "wait", dt: 1 / TIGHT.manualPerS },
    { kind: "wait", dt: -TIGHT.repeatS },
    { kind: "bad", lane: null, t: Number.NaN },
    { kind: "bad", lane: "manual", t: Number.NaN },
    { kind: "bad", lane: null, t: Number.POSITIVE_INFINITY },
    { kind: "bad", lane: "auto", t: Number.NEGATIVE_INFINITY },
  ];
  const cov = explore(TIGHT, alphabet, 5, [], 100);
  assert.equal(cov.sequences, sum([0, 1, 2, 3, 4, 5].map((d) => alphabet.length ** d)));
});
