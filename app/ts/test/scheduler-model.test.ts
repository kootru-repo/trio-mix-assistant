import assert from "node:assert/strict";
import test from "node:test";
import { type TickPlan, TickScheduler, WallWatch } from "../src/core/scheduler.ts";

const tick = 1 / 64;
const maxLagS = 1 / 4;
const work = 1 / 256;
const zeroLimit = maxLagS / tick + 1;

const forEachSequence = (size: number, len: number, visit: (seq: readonly number[]) => void): number => {
  const seq: number[] = new Array<number>(len).fill(0);
  let count = 0;
  for (;;) {
    visit(seq);
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

type TickEv =
  | { k: "after"; w: number; name: string }
  | { k: "back"; dt: number }
  | { k: "bad"; t: number }
  | { k: "badStart"; t: number }
  | { k: "start" };

const tickAlphabet: readonly TickEv[] = [
  { k: "after", w: -1, name: "same instant" },
  { k: "after", w: work, name: "sleep kept plus work" },
  { k: "after", w: tick, name: "sleep kept plus a tick of work" },
  { k: "after", w: tick + maxLagS, name: "lag at the limit" },
  { k: "after", w: tick + maxLagS + 1 / 1024, name: "lag just over the limit" },
  { k: "after", w: 3600, name: "an hour asleep" },
  { k: "back", dt: 1 },
  { k: "start" },
];

const badTicks: readonly TickEv[] = [
  { k: "bad", t: Number.NaN },
  { k: "bad", t: Number.POSITIVE_INFINITY },
  { k: "bad", t: Number.NEGATIVE_INFINITY },
  { k: "badStart", t: Number.NaN },
  { k: "badStart", t: Number.POSITIVE_INFINITY },
];

const tickLabel = (e: TickEv): string => {
  if (e.k === "after") return e.name;
  if (e.k === "back") return `clock back ${e.dt} s`;
  if (e.k === "bad") return `plan(${e.t})`;
  return e.k === "badStart" ? `start(${e.t})` : "start";
};

interface TickTally {
  resumed: number;
  zeroSleeps: number;
  longestFixedRun: number;
  atLimitNoResume: number;
  sequences: number;
  ignored: number;
}

const steadyPlans = 16;

const samePlan = (a: TickPlan, b: TickPlan): boolean => a.sleepS === b.sleepS && a.resumed === b.resumed && a.gapS === b.gapS;

const runTickSequence = (alphabet: readonly TickEv[], seq: readonly number[], tally: TickTally): void => {
  const s = new TickScheduler({ tick, maxLagS });
  const twin = new TickScheduler({ tick, maxLagS });
  const t0 = 1000;
  s.start(t0);
  twin.start(t0);
  let now = t0;
  let due = t0;
  let lastSleep = 0;
  let wake = t0;
  let monotone = true;
  let zeroRun = 0;
  let fixedRun = 0;
  let runFrom = t0;
  let lastAt = t0;
  const trail: TickEv[] = [];
  const fail = (what: string): never => assert.fail(`${what} after start(${t0}) -> ${trail.map(tickLabel).join(" -> ")}`);
  const planBoth = (at: number): TickPlan => {
    const p = s.plan(at);
    const q = twin.plan(at);
    if (!samePlan(p, q)) fail(`plan ${JSON.stringify(p)} differs from ${JSON.stringify(q)} without the bad readings`);
    return p;
  };
  const checkPlan = (p: TickPlan, at: number, w: number | null): void => {
    due += tick;
    const lag = at - due;
    const wantResume = lag > maxLagS;
    if (p.resumed !== wantResume) fail(`resumed is ${p.resumed} with lag ${lag}`);
    if (wantResume) {
      due = at + tick;
      tally.resumed++;
      if (p.sleepS !== tick) fail(`a resume sleeps ${p.sleepS}`);
      if (p.gapS !== lag || !(p.gapS > maxLagS)) fail(`a resume reports gap ${p.gapS}, expected ${lag}`);
    } else {
      if (p.gapS !== 0) fail(`gap ${p.gapS} without a resume`);
      if (p.sleepS !== Math.max(0, due - at)) fail(`sleep ${p.sleepS}, expected ${Math.max(0, due - at)}`);
      if (p.sleepS === 0 && due > at) fail("a step ran ahead of its due time");
    }
    if (!Number.isFinite(p.sleepS) || p.sleepS < 0) fail(`sleep ${p.sleepS} is not a finite non-negative number`);
    if (monotone && at + p.sleepS > Math.max(at, wake) + tick)
      fail(`sleep ${p.sleepS} wakes more than a tick after the last wake-up at ${wake}`);
    if (monotone && at >= wake && p.sleepS > tick) fail(`sleep ${p.sleepS} is longer than a tick after a kept sleep`);
    if (monotone && w !== null && w <= tick && p.resumed) fail("a kept sleep plus at most a tick of work reported a resume");
    if (monotone && w !== null && w > tick + maxLagS && !p.resumed) fail("a gap past the limit was not reported");
    if (!p.resumed && at - due > maxLagS) fail(`catch-up debt ${at - due} is over the limit`);
    if (p.sleepS === 0) {
      if (zeroRun === 0) runFrom = at;
      fixedRun = zeroRun > 0 && at === lastAt ? fixedRun + 1 : 1;
      zeroRun++;
      tally.zeroSleeps++;
      tally.longestFixedRun = Math.max(tally.longestFixedRun, fixedRun);
      if (fixedRun > zeroLimit) fail(`${fixedRun} steps without sleeping at one instant`);
      if (zeroRun > (at - runFrom + maxLagS) / tick + 1) fail(`${zeroRun} steps without sleeping over ${at - runFrom} s`);
    } else zeroRun = 0;
    lastAt = at;
    if (w === tick + maxLagS && lastSleep > 0 && !p.resumed) tally.atLimitNoResume++;
    lastSleep = p.sleepS;
    wake = at + p.sleepS;
  };
  for (const idx of seq) {
    const ev = alphabet[idx]!;
    trail.push(ev);
    if (ev.k === "start") {
      s.start(now);
      twin.start(now);
      due = now;
      wake = now;
      lastSleep = 0;
      zeroRun = 0;
      monotone = true;
    } else if (ev.k === "badStart") {
      s.start(ev.t);
      tally.ignored++;
    } else if (ev.k === "bad") {
      const p = s.plan(ev.t);
      if (!samePlan(p, { sleepS: tick, resumed: false, gapS: 0 })) fail(`plan(${ev.t}) is ${JSON.stringify(p)}, not one quiet tick`);
      tally.ignored++;
    } else if (ev.k === "back") {
      now -= ev.dt;
      monotone = false;
      checkPlan(planBoth(now), now, null);
    } else {
      const w = ev.w < 0 ? null : ev.w;
      if (w !== null) now += lastSleep + w;
      checkPlan(planBoth(now), now, w);
    }
  }
  let drained = 0;
  for (;;) {
    const p = planBoth(now);
    checkPlan(p, now, null);
    if (p.sleepS > 0) break;
    drained++;
    if (drained > zeroLimit) fail("catch-up never ended at a fixed time");
  }
  const from = now + lastSleep;
  for (let i = 0; i < steadyPlans; i++) {
    now += lastSleep + work;
    const p = planBoth(now);
    checkPlan(p, now, work);
    if (p.resumed || p.sleepS !== tick - work) fail(`steady plan ${i} is ${JSON.stringify(p)}`);
  }
  if (now + lastSleep - from !== steadyPlans * tick) fail("steady steps do not match elapsed time over the tick");
};

const tickRuns: readonly { name: string; alphabet: readonly TickEv[]; depth: number }[] = [
  { name: "clock advances, stalls, sleeps, backward steps and restarts", alphabet: tickAlphabet, depth: 6 },
  {
    name: "the same with plans and starts at NaN and infinite times",
    alphabet: [...tickAlphabet.filter((e) => e.k !== "after" || e.w !== work), ...badTicks],
    depth: 5,
  },
];

for (const run of tickRuns) {
  test(`every sequence of ${run.name} plans finite sleeps without a burst`, () => {
    const tally: TickTally = { resumed: 0, zeroSleeps: 0, longestFixedRun: 0, atLimitNoResume: 0, sequences: 0, ignored: 0 };
    tally.sequences = forEachSequence(run.alphabet.length, run.depth, (seq) => runTickSequence(run.alphabet, seq, tally));
    assert.equal(tally.sequences, run.alphabet.length ** run.depth);
    assert.ok(tally.resumed > 0);
    assert.ok(tally.zeroSleeps > 0);
    assert.equal(tally.longestFixedRun, zeroLimit);
    assert.ok(tally.atLimitNoResume > 0);
    assert.equal(
      tally.ignored > 0,
      run.alphabet.some((e) => e.k === "bad" || e.k === "badStart"),
    );
  });
}

const jumpS = 2;

type WallEv =
  | { k: "observe"; dm: number; drift: number; name: string }
  | { k: "bad"; mono: number; wall: number; name: string }
  | { k: "reset" };

const wallAlphabet: readonly WallEv[] = [
  { k: "observe", dm: 0, drift: 0, name: "same instant" },
  { k: "observe", dm: 1, drift: 0, name: "clocks agree" },
  { k: "observe", dm: 1, drift: 1.5, name: "wall drifts ahead by 1.5 s" },
  { k: "observe", dm: 1, drift: -1, name: "wall drifts back by 1 s" },
  { k: "observe", dm: 1, drift: jumpS, name: "wall steps ahead by the limit" },
  { k: "observe", dm: 1, drift: jumpS + 1 / 64, name: "wall jumps ahead past the limit" },
  { k: "observe", dm: 1, drift: -jumpS - 1 / 64, name: "wall jumps back past the limit" },
  { k: "observe", dm: 1 / 2, drift: 3600, name: "an hour the monotonic clock missed" },
  { k: "bad", mono: 0, wall: Number.NaN, name: "a NaN wall reading" },
  { k: "bad", mono: Number.POSITIVE_INFINITY, wall: 0, name: "an infinite monotonic reading" },
  { k: "bad", mono: Number.NaN, wall: Number.NEGATIVE_INFINITY, name: "two bad readings" },
  { k: "reset" },
];

const wallLabel = (e: WallEv): string => (e.k === "reset" ? "reset" : e.name);

interface WallTally {
  reports: number;
  quietAtLimit: number;
  stepAfterDrift: number;
  stepAfterBad: number;
  accumulated: number;
}

const wallDepth = 6;

const runWallSequence = (seq: readonly number[], tally: WallTally): void => {
  const w = new WallWatch({ jumpS });
  let mono = 50;
  let wall = 7000;
  let seen = false;
  let prevDrift = 0;
  let prevBad = false;
  const trail: WallEv[] = [];
  const fail = (what: string): never => assert.fail(`${what} after ${trail.map(wallLabel).join(" -> ")}`);
  for (const idx of seq) {
    const ev = wallAlphabet[idx]!;
    trail.push(ev);
    if (ev.k === "reset") {
      w.reset();
      seen = false;
      continue;
    }
    if (ev.k === "bad") {
      mono += 1;
      wall += 1;
      const got = w.observe(Number.isFinite(ev.mono) ? mono : ev.mono, Number.isFinite(ev.wall) ? wall : ev.wall);
      if (got !== null) fail(`a bad reading was reported as ${got}`);
      prevBad = true;
      continue;
    }
    mono += ev.dm;
    wall += ev.dm + ev.drift;
    const got = w.observe(mono, wall);
    const want = seen && Math.abs(ev.drift) > jumpS ? ev.drift : null;
    if (got !== want) fail(`observe reported ${got}, expected ${want}`);
    if (got !== null) {
      tally.reports++;
      if (Math.abs(ev.drift) <= jumpS) tally.accumulated++;
      if (prevDrift !== 0 && Math.abs(prevDrift) <= jumpS) tally.stepAfterDrift++;
      if (prevBad) tally.stepAfterBad++;
    } else if (seen && ev.drift === jumpS) tally.quietAtLimit++;
    seen = true;
    prevDrift = ev.drift;
    prevBad = false;
  }
};

test("every sequence of wall and monotonic readings, drifts, steps and bad readings reports each step past the limit between readings", () => {
  const tally: WallTally = { reports: 0, quietAtLimit: 0, stepAfterDrift: 0, stepAfterBad: 0, accumulated: 0 };
  const count = forEachSequence(wallAlphabet.length, wallDepth, (seq) => runWallSequence(seq, tally));
  assert.equal(count, wallAlphabet.length ** wallDepth);
  assert.ok(tally.reports > 0);
  assert.ok(tally.quietAtLimit > 0);
  assert.ok(tally.stepAfterDrift > 0);
  assert.ok(tally.stepAfterBad > 0);
  assert.equal(tally.accumulated, 0);
});
