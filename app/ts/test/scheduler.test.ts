import assert from "node:assert/strict";
import test from "node:test";
import { TickScheduler, WallWatch } from "../src/core/scheduler.ts";
import type { TickPlan } from "../src/core/scheduler.ts";

const tick = 1 / 64;
const maxLagS = 1 / 4;
const step = 1 / 256;

const scheduler = (start: number): TickScheduler => {
  const s = new TickScheduler({ tick, maxLagS });
  s.start(start);
  return s;
};

const normal = (sleepS: number): TickPlan => ({ sleepS, resumed: false, gapS: 0 });

const runSteps = (s: TickScheduler, from: number, count: number): { plans: TickPlan[]; now: number } => {
  const plans: TickPlan[] = [];
  let now = from;
  for (let i = 0; i < count; i++) {
    const plan = s.plan(now + step);
    plans.push(plan);
    now = now + step + plan.sleepS;
  }
  return { plans, now };
};

test("steady ticking sleeps exactly the time left in each tick", () => {
  const s = scheduler(0);
  const { plans } = runSteps(s, 0, 10);
  for (const plan of plans) assert.deepEqual(plan, normal(tick - step));
});

test("a plan with no time spent sleeps one whole tick", () => {
  const s = scheduler(2);
  assert.deepEqual(s.plan(2), normal(tick));
});

test("a small lag is caught up with zero sleeps and then ticking returns to normal", () => {
  const s = scheduler(0);
  const late = 4 * tick + step;
  assert.deepEqual(s.plan(late), normal(0));
  const catchUp: TickPlan[] = [s.plan(late), s.plan(late), s.plan(late)];
  for (const plan of catchUp) assert.deepEqual(plan, normal(0));
  assert.deepEqual(s.plan(late), normal(tick - step));
  const { plans } = runSteps(s, late + tick - step, 5);
  for (const plan of plans) assert.deepEqual(plan, normal(tick - step));
});

test("a lag exactly at the limit is caught up and not reported as a resume", () => {
  const s = scheduler(0);
  const now = tick + maxLagS;
  const first = s.plan(now);
  assert.deepEqual(first, normal(0));
  let zeros = 1;
  for (;;) {
    const plan = s.plan(now);
    if (plan.sleepS > 0) {
      assert.deepEqual(plan, normal(tick));
      break;
    }
    assert.equal(plan.resumed, false);
    zeros++;
  }
  assert.equal(zeros, maxLagS / tick + 1);
});

test("a lag just over the limit reports a resume with the gap and no burst follows", () => {
  const s = scheduler(0);
  const now = tick + maxLagS + 1 / 1024;
  assert.deepEqual(s.plan(now), { sleepS: tick, resumed: true, gapS: maxLagS + 1 / 1024 });
  const { plans } = runSteps(s, now + tick, 20);
  assert.equal(plans.filter((p) => p.sleepS === 0).length, 0);
  assert.equal(plans.filter((p) => p.resumed).length, 0);
  for (const plan of plans) assert.deepEqual(plan, normal(tick - step));
});

test("a long sleep reports the whole gap once and the next plan is one normal tick", () => {
  const s = scheduler(0);
  runSteps(s, 0, 3);
  const wake = 3600;
  const plan = s.plan(wake);
  assert.equal(plan.resumed, true);
  assert.equal(plan.gapS, wake - 4 * tick);
  assert.equal(plan.sleepS, tick);
  assert.deepEqual(s.plan(wake + tick + step), normal(tick - step));
});

test("start resets the schedule to the given time", () => {
  const s = scheduler(0);
  s.start(100);
  assert.deepEqual(s.plan(100 + step), normal(tick - step));
});

test("the first wall watch observation only records the offset", () => {
  const w = new WallWatch({ jumpS: 2 });
  assert.equal(w.observe(10, 1000), null);
});

test("a small drift between the clocks is not reported", () => {
  const w = new WallWatch({ jumpS: 2 });
  w.observe(10, 1000);
  assert.equal(w.observe(20, 1011.5), null);
  assert.equal(w.observe(30, 1020), null);
});

test("a drift exactly at the limit is not reported in either direction", () => {
  const w = new WallWatch({ jumpS: 2 });
  w.observe(10, 1000);
  assert.equal(w.observe(20, 1012), null);
  assert.equal(w.observe(30, 1020), null);
});

test("a forward wall jump just over the limit is reported once and then it is quiet", () => {
  const w = new WallWatch({ jumpS: 2 });
  w.observe(10, 1000);
  assert.equal(w.observe(20, 1012 + 1 / 64), 2 + 1 / 64);
  assert.equal(w.observe(30, 1022 + 1 / 64), null);
  assert.equal(w.observe(40, 1032 + 1 / 64), null);
});

test("a backward wall jump just over the limit is reported as negative once", () => {
  const w = new WallWatch({ jumpS: 2 });
  w.observe(10, 1000);
  assert.equal(w.observe(20, 1008 - 1 / 64), -2 - 1 / 64);
  assert.equal(w.observe(30, 1018 - 1 / 64), null);
});

test("a sleep the monotonic clock did not count is reported as the hidden time", () => {
  const w = new WallWatch({ jumpS: 2 });
  w.observe(10, 1000);
  assert.equal(w.observe(10.5, 1000.5 + 3600), 3600);
  assert.equal(w.observe(11, 1001 + 3600), null);
});

test("reset forgets the offset so the next observation is a fresh start", () => {
  const w = new WallWatch({ jumpS: 2 });
  w.observe(10, 1000);
  w.reset();
  assert.equal(w.observe(20, 5000), null);
  assert.equal(w.observe(30, 5010), null);
  assert.equal(w.observe(40, 5030), 10);
});

const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

test("a plan at a time that is not a finite number sleeps one tick and changes nothing", () => {
  for (const t of bad) {
    const s = scheduler(0);
    const twin = scheduler(0);
    s.plan(step);
    twin.plan(step);
    assert.deepEqual(s.plan(t), normal(tick));
    assert.deepEqual(s.plan(t), normal(tick));
    for (const now of [tick + step, 2 * tick + step, 3600]) assert.deepEqual(s.plan(now), twin.plan(now));
  }
});

test("a plan at infinity does not jam later plans", () => {
  const s = scheduler(0);
  s.plan(Number.POSITIVE_INFINITY);
  const { plans } = runSteps(s, 0, 10);
  for (const plan of plans) assert.ok(Number.isFinite(plan.sleepS) && plan.sleepS <= tick);
});

test("a start at a time that is not a finite number is ignored", () => {
  for (const t of bad) {
    const s = scheduler(100);
    s.start(t);
    assert.deepEqual(s.plan(100 + step), normal(tick - step));
    const { plans } = runSteps(s, 100 + tick, 5);
    for (const plan of plans) assert.deepEqual(plan, normal(tick - step));
  }
});

test("a wall reading that is not a finite number is ignored and does not become the baseline", () => {
  const w = new WallWatch({ jumpS: 2 });
  assert.equal(w.observe(0, Number.NaN), null);
  assert.equal(w.observe(1, 1), null);
  assert.equal(w.observe(2, 3602), 3600);
});

test("a monotonic reading that is not a finite number is ignored", () => {
  for (const t of bad) {
    const w = new WallWatch({ jumpS: 2 });
    assert.equal(w.observe(0, 100), null);
    assert.equal(w.observe(t, 100), null);
    assert.equal(w.observe(1, 101), null);
    assert.equal(w.observe(2, 105), 3);
  }
});

test("a step between two readings is reported even after a slow drift the other way", () => {
  const w = new WallWatch({ jumpS: 2 });
  assert.equal(w.observe(0, 0), null);
  assert.equal(w.observe(1, 2.5), null);
  assert.equal(w.observe(2, 0.5), -3);
});

test("two small drifts in a row are not reported as one jump", () => {
  const w = new WallWatch({ jumpS: 2 });
  w.observe(0, 0);
  assert.equal(w.observe(1, 2.5), null);
  assert.equal(w.observe(2, 5), null);
  assert.equal(w.observe(3, 7.5), null);
});
