import assert from "node:assert/strict";
import test from "node:test";
import { defaultConfig } from "../src/core/config.ts";
import { type LinkState, type LinkTick, LinkWatch, type LinkWatchOptions } from "../src/core/linkwatch.ts";

type Action = "heard" | "tick" | "both" | "reset";

interface Step {
  dt: number;
  action: Action;
  bad?: number;
}

const LEGAL: Record<LinkState, readonly LinkState[]> = {
  waiting: ["waiting", "up"],
  up: ["up", "stale", "down"],
  stale: ["stale", "up", "down"],
  down: ["down", "up"],
};

const link = defaultConfig().link;
const OPTS: LinkWatchOptions = { probeS: link.probeS, staleS: link.staleS, downS: link.downS, steadyS: link.steadyS };

class Oracle {
  readonly o: LinkWatchOptions;
  now = 0;
  runStart: number | null = null;
  lastHeard: number | null = null;
  firstTick: number | null = null;
  lastProbe: number | null = null;
  state: LinkState = "waiting";

  constructor(o: LinkWatchOptions) {
    this.o = o;
  }

  heard(now: number): void {
    if (this.lastHeard === null || now - this.lastHeard > this.o.staleS) this.runStart = now;
    this.lastHeard = now;
  }

  reset(): void {
    this.runStart = null;
    this.lastHeard = null;
    this.firstTick = null;
    this.lastProbe = null;
    this.state = "waiting";
  }

  steady(now: number): boolean {
    if (this.lastHeard === null || this.runStart === null) return false;
    return now - this.lastHeard <= this.o.staleS && now - this.runStart >= this.o.steadyS;
  }

  expectState(now: number): LinkState {
    const prev = this.state;
    if (this.lastHeard === null) return "waiting";
    if (this.steady(now)) return "up";
    if (prev === "waiting") return "waiting";
    if (now - this.lastHeard > this.o.downS) return "down";
    return prev === "down" ? "down" : "stale";
  }

  key(): string {
    const rel = (t: number | null): string => (t === null ? "-" : String(this.now - t));
    return [this.state, rel(this.runStart), rel(this.lastHeard), rel(this.firstTick), rel(this.lastProbe)].join("|");
  }
}

interface Coverage {
  states: Set<LinkState>;
  recovered: number;
  downToUp: number;
  probes: number;
  sequences: number;
  steps: number;
  keys: Set<string>;
}

function check(ok: boolean, seq: readonly Step[], i: number, msg: string): void {
  if (!ok)
    assert.fail(`${msg} at step ${i} of ${seq.map((s) => `${s.action}${s.bad === undefined ? "+" : `@${s.bad}+`}${s.dt}`).join(", ")}`);
}

function checkTick(seq: readonly Step[], i: number, oracle: Oracle, prev: LinkState, t: LinkTick, w: LinkWatch, cov: Coverage): void {
  const now = oracle.now;
  check(t.state === w.state, seq, i, "tick state differs from the watch state");
  check(t.changed === (t.state !== prev), seq, i, "changed flag wrong");
  check(LEGAL[prev].includes(t.state), seq, i, "illegal edge");
  check(t.state === oracle.expectState(now), seq, i, "state differs from the intent");
  if (t.state === "up") check(oracle.steady(now), seq, i, "up without steadyS of hearing");
  if (t.changed && t.state === "down") {
    check(oracle.lastHeard !== null && now - oracle.lastHeard > OPTS.downS, seq, i, "down before downS of silence");
  }
  const recovered = t.changed && t.state === "up" && (prev === "stale" || prev === "down");
  check(t.recovered === recovered, seq, i, "recovered flag wrong");
  oracle.firstTick ??= now;
  const since = oracle.lastHeard ?? oracle.firstTick;
  const quiet = now - since > OPTS.probeS;
  const spaced = oracle.lastProbe === null || now - oracle.lastProbe >= OPTS.probeS;
  check(t.probe === (quiet && spaced), seq, i, "probe flag wrong");
  if (t.probe) {
    oracle.lastProbe = now;
    cov.probes++;
  }
  if (t.recovered) cov.recovered++;
  if (t.recovered && prev === "down") cov.downToUp++;
  oracle.state = t.state;
  cov.states.add(t.state);
}

function runSane(seq: readonly Step[], cov: Coverage): void {
  const w = new LinkWatch(OPTS);
  const oracle = new Oracle(OPTS);
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i];
    if (s === undefined) continue;
    oracle.now += s.dt;
    const now = oracle.now;
    if (s.action === "reset") {
      w.reset();
      oracle.reset();
      check(w.state === "waiting", seq, i, "reset did not return to waiting");
    }
    if (s.action === "heard" || s.action === "both") {
      w.heard(now);
      oracle.heard(now);
    }
    if (s.action === "tick" || s.action === "both") {
      const prev = w.state;
      checkTick(seq, i, oracle, prev, w.tick(now), w, cov);
    }
    cov.steps++;
    if (i === seq.length - 1) cov.keys.add(oracle.key());
  }
  cov.sequences++;
}

function enumerate(alphabet: readonly Step[], depth: number, visit: (seq: readonly Step[]) => void): void {
  const seq: Step[] = [];
  const go = (): void => {
    visit(seq);
    if (seq.length === depth) return;
    for (const s of alphabet) {
      seq.push(s);
      go();
      seq.pop();
    }
  };
  go();
}

const newCoverage = (): Coverage => ({
  states: new Set(),
  recovered: 0,
  downToUp: 0,
  probes: 0,
  sequences: 0,
  steps: 0,
  keys: new Set(),
});

const SANE_DTS = [0, 0.25, OPTS.probeS, OPTS.staleS, OPTS.downS];
const SANE: Step[] = [
  ...SANE_DTS.flatMap((dt) => (["heard", "tick", "both"] as const).map((action) => ({ dt, action }))),
  { dt: 0, action: "reset" },
];

test("the link watch keeps its intended states, edges, recoveries and probes for every sequence up to depth 5", () => {
  const cov = newCoverage();
  enumerate(SANE, 5, (seq) => runSane(seq, cov));
  assert.equal(cov.sequences, 1118481);
  assert.deepEqual([...cov.states].sort(), ["down", "stale", "up", "waiting"]);
  assert.ok(cov.recovered > 0 && cov.downToUp > 0 && cov.probes > 0);
  assert.ok(cov.keys.size > 1000, `distinct states ${cov.keys.size}`);
});

test("the link watch reaches recovery from a long silence within depth 7 of a smaller alphabet", () => {
  const cov = newCoverage();
  const steps: Step[] = [
    { dt: 0, action: "both" },
    { dt: OPTS.steadyS, action: "both" },
    { dt: OPTS.downS + 0.25, action: "tick" },
    { dt: OPTS.steadyS - 0.25, action: "both" },
    { dt: OPTS.staleS + 0.25, action: "heard" },
    { dt: 0, action: "reset" },
  ];
  enumerate(steps, 7, (seq) => runSane(seq, cov));
  assert.equal(cov.sequences, 335923);
  assert.ok(cov.downToUp > 0);
});

const HOSTILE: Step[] = [
  { dt: 0, action: "both" },
  { dt: 0.25, action: "tick" },
  { dt: OPTS.staleS, action: "both" },
  { dt: OPTS.downS, action: "tick" },
  { dt: -1, action: "both" },
  { dt: -1, action: "tick" },
  { dt: 0, action: "reset" },
  { dt: 0, action: "heard", bad: Number.NaN },
  { dt: 0, action: "tick", bad: Number.NaN },
  { dt: 0.25, action: "heard", bad: Number.POSITIVE_INFINITY },
  { dt: 0.25, action: "tick", bad: Number.NEGATIVE_INFINITY },
  { dt: OPTS.staleS, action: "both", bad: Number.POSITIVE_INFINITY },
];

const sameTick = (a: LinkTick, b: LinkTick): boolean =>
  a.state === b.state && a.changed === b.changed && a.probe === b.probe && a.recovered === b.recovered;

test("backwards time never makes an illegal edge, an inconsistent tick or a probe burst, and a time that is not a finite number changes nothing", () => {
  let sequences = 0;
  let ignored = 0;
  enumerate(HOSTILE, 5, (seq) => {
    sequences++;
    const w = new LinkWatch(OPTS);
    const twin = new LinkWatch(OPTS);
    let now = 0;
    let lastProbe: number | null = null;
    for (let i = 0; i < seq.length; i++) {
      const s = seq[i];
      if (s === undefined) continue;
      now += s.dt;
      if (s.bad !== undefined) {
        const before = w.state;
        if (s.action === "heard" || s.action === "both") w.heard(s.bad);
        if (s.action === "tick" || s.action === "both") {
          const t = w.tick(s.bad);
          check(sameTick(t, { state: before, changed: false, probe: false, recovered: false }), seq, i, "a bad time changed the tick");
        }
        check(w.state === before, seq, i, "a bad time changed the state");
        ignored++;
        continue;
      }
      if (s.action === "reset") {
        w.reset();
        twin.reset();
        lastProbe = null;
        check(w.state === "waiting", seq, i, "reset did not return to waiting");
      }
      if (s.action === "heard" || s.action === "both") {
        w.heard(now);
        twin.heard(now);
      }
      if (s.action === "tick" || s.action === "both") {
        const prev = w.state;
        const t = w.tick(now);
        check(sameTick(t, twin.tick(now)), seq, i, "a bad time earlier changed a later tick");
        check(t.state === w.state, seq, i, "tick state differs from the watch state");
        check(t.changed === (t.state !== prev), seq, i, "changed flag wrong");
        check(LEGAL[prev].includes(t.state), seq, i, "illegal edge");
        check(t.recovered === (t.changed && t.state === "up" && prev !== "waiting"), seq, i, "recovered flag wrong");
        if (t.probe) {
          check(lastProbe === null || Math.abs(now - lastProbe) >= OPTS.probeS, seq, i, "probe burst");
          lastProbe = now;
        }
      }
    }
  });
  assert.equal(sequences, 271453);
  assert.ok(ignored > 0);
});
