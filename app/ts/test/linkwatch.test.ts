import assert from "node:assert/strict";
import test from "node:test";
import { LinkWatch } from "../src/core/linkwatch.ts";
import type { LinkTick, LinkWatchOptions } from "../src/core/linkwatch.ts";

const opts: LinkWatchOptions = { probeS: 0.75, staleS: 1.5, downS: 5, steadyS: 1 };

const watch = (): LinkWatch => new LinkWatch(opts);

const both = (w: LinkWatch, now: number): LinkTick => {
  w.heard(now);
  return w.tick(now);
};

const upAt = (w: LinkWatch, from: number): number => {
  both(w, from);
  both(w, from + 0.5);
  const t = both(w, from + 1);
  assert.equal(t.state, "up");
  return from + 1;
};

const tickOf = (state: LinkTick["state"], changed: boolean, probe: boolean, recovered: boolean): LinkTick => ({
  state,
  changed,
  probe,
  recovered,
});

test("a new watch is waiting before any tick", () => {
  assert.equal(watch().state, "waiting");
});

test("ticks with nothing heard stay waiting and unchanged", () => {
  const w = watch();
  assert.deepEqual(w.tick(0), tickOf("waiting", false, false, false));
  assert.deepEqual(w.tick(10), tickOf("waiting", false, true, false));
  assert.equal(w.state, "waiting");
});

test("data heard for just under steadyS keeps the link waiting", () => {
  const w = watch();
  both(w, 0);
  assert.deepEqual(both(w, 0.75), tickOf("waiting", false, false, false));
});

test("data heard for exactly steadyS brings the link up without a recovery", () => {
  const w = watch();
  both(w, 0);
  both(w, 0.5);
  assert.deepEqual(both(w, 1), tickOf("up", true, false, false));
  assert.equal(w.state, "up");
  assert.deepEqual(both(w, 1.25), tickOf("up", false, false, false));
});

test("the link comes up on a tick after steadyS even when the last datagram is a little old", () => {
  const w = watch();
  w.heard(0);
  w.heard(0.5);
  assert.deepEqual(w.tick(2), tickOf("up", true, true, false));
});

test("a waiting link with data older than staleS is not up", () => {
  const w = watch();
  w.heard(0);
  w.heard(0.5);
  assert.equal(w.tick(2.25).state, "waiting");
});

test("a gap of exactly staleS while waiting keeps the steadiness clock running", () => {
  const w = watch();
  both(w, 0);
  assert.equal(both(w, 1.5).state, "up");
});

test("a gap over staleS while waiting restarts the steadiness clock at the next datagram", () => {
  const w = watch();
  both(w, 0);
  assert.equal(w.tick(1.75).state, "waiting");
  both(w, 1.75);
  assert.equal(both(w, 2.5).state, "waiting");
  assert.equal(both(w, 2.75).state, "up");
});

test("a link that was heard once and went silent stays waiting rather than down", () => {
  const w = watch();
  both(w, 0);
  assert.equal(w.tick(100).state, "waiting");
});

test("silence of exactly staleS keeps the link up", () => {
  const w = watch();
  const t = upAt(w, 0);
  assert.equal(w.tick(t + 1.5).state, "up");
});

test("silence just over staleS makes the link stale", () => {
  const w = watch();
  const t = upAt(w, 0);
  assert.deepEqual(w.tick(t + 1.75), tickOf("stale", true, true, false));
  assert.equal(w.state, "stale");
});

test("silence of exactly downS leaves a stale link stale", () => {
  const w = watch();
  const t = upAt(w, 0);
  w.tick(t + 2);
  assert.deepEqual(w.tick(t + 5), tickOf("stale", false, true, false));
});

test("silence just over downS makes a stale link down", () => {
  const w = watch();
  const t = upAt(w, 0);
  w.tick(t + 2);
  assert.deepEqual(w.tick(t + 5.25), tickOf("down", true, true, false));
  assert.equal(w.state, "down");
});

test("an up link goes straight to down when the first tick after it is past downS", () => {
  const w = watch();
  const t = upAt(w, 0);
  assert.deepEqual(w.tick(t + 6), tickOf("down", true, true, false));
});

test("brief gaps under staleS never take the link out of up", () => {
  const w = watch();
  let t = upAt(w, 0);
  for (let i = 0; i < 20; i += 1) {
    assert.equal(w.tick(t + 0.5).state, "up");
    assert.equal(w.tick(t + 1.25).state, "up");
    t += 1.5;
    assert.deepEqual(both(w, t), tickOf("up", false, false, false));
  }
});

test("a stale link that hears data again stays stale until steadyS has passed", () => {
  const w = watch();
  const t = upAt(w, 0);
  w.tick(t + 2);
  assert.deepEqual(both(w, t + 2.5), tickOf("stale", false, false, false));
  assert.deepEqual(both(w, t + 3.25), tickOf("stale", false, false, false));
});

test("a stale link returns to up after steadyS of data and reports the recovery once", () => {
  const w = watch();
  const t = upAt(w, 0);
  w.tick(t + 2);
  both(w, t + 2.5);
  assert.deepEqual(both(w, t + 3.5), tickOf("up", true, false, true));
  assert.deepEqual(both(w, t + 3.75), tickOf("up", false, false, false));
});

test("a down link that hears data again stays down until steadyS has passed", () => {
  const w = watch();
  const t = upAt(w, 0);
  w.tick(t + 6);
  assert.deepEqual(both(w, t + 7), tickOf("down", false, false, false));
  assert.deepEqual(both(w, t + 7.75), tickOf("down", false, false, false));
});

test("a down link returns to up after steadyS of data and reports the recovery once", () => {
  const w = watch();
  const t = upAt(w, 0);
  w.tick(t + 6);
  both(w, t + 7);
  assert.deepEqual(both(w, t + 8), tickOf("up", true, false, true));
  assert.deepEqual(both(w, t + 8.5), tickOf("up", false, false, false));
});

test("a down link whose resumed data stops again stays down rather than stale", () => {
  const w = watch();
  const t = upAt(w, 0);
  w.tick(t + 6);
  both(w, t + 7);
  assert.equal(w.tick(t + 9).state, "down");
});

test("a recovering link whose data gaps over staleS restarts its steadiness clock", () => {
  const w = watch();
  const t = upAt(w, 0);
  w.tick(t + 6);
  both(w, t + 7);
  both(w, t + 7.5);
  w.heard(t + 9.25);
  assert.equal(w.tick(t + 9.25).state, "down");
  assert.equal(both(w, t + 10).state, "down");
  assert.deepEqual(both(w, t + 10.25), tickOf("up", true, false, true));
});

test("an up link that missed a long gap between ticks drops to stale and must recover", () => {
  const w = watch();
  const t = upAt(w, 0);
  w.heard(t + 3);
  assert.deepEqual(w.tick(t + 3), tickOf("stale", true, false, false));
  assert.equal(both(w, t + 3.5).state, "stale");
  assert.deepEqual(both(w, t + 4), tickOf("up", true, false, true));
});

test("an up link probes once silence passes probeS", () => {
  const w = watch();
  const t = upAt(w, 0);
  assert.equal(w.tick(t + 0.75).probe, false);
  assert.equal(w.tick(t + 1).probe, true);
});

test("an up link probes at most once per probeS while silent", () => {
  const w = watch();
  const t = upAt(w, 0);
  assert.equal(w.tick(t + 1).probe, true);
  assert.equal(w.tick(t + 1.25).probe, false);
  assert.equal(w.tick(t + 1.5).probe, false);
  assert.equal(w.tick(t + 1.75).probe, true);
});

test("a stale link probes at most once per probeS", () => {
  const w = watch();
  const t = upAt(w, 0);
  assert.equal(w.tick(t + 2).probe, true);
  assert.equal(w.state, "stale");
  assert.equal(w.tick(t + 2.5).probe, false);
  assert.equal(w.tick(t + 2.75).probe, true);
  assert.equal(w.tick(t + 3).probe, false);
});

test("a down link probes at most once per probeS", () => {
  const w = watch();
  const t = upAt(w, 0);
  assert.equal(w.tick(t + 6).probe, true);
  assert.equal(w.state, "down");
  assert.equal(w.tick(t + 6.5).probe, false);
  assert.equal(w.tick(t + 6.75).probe, true);
  assert.equal(w.tick(t + 7).probe, false);
});

test("a waiting link probes once per probeS starting probeS after its first tick", () => {
  const w = watch();
  assert.equal(w.tick(2).probe, false);
  assert.equal(w.tick(2.75).probe, false);
  assert.equal(w.tick(3).probe, true);
  assert.equal(w.tick(3.5).probe, false);
  assert.equal(w.tick(3.75).probe, true);
});

test("a waiting link that heard data once probes by the time since that datagram", () => {
  const w = watch();
  w.tick(0);
  w.heard(5);
  assert.deepEqual(w.tick(5.75), tickOf("waiting", false, false, false));
  assert.deepEqual(w.tick(5.875), tickOf("waiting", false, true, false));
});

test("a single datagram followed by silence no longer than staleS brings the link up after steadyS", () => {
  const w = watch();
  w.heard(5);
  assert.equal(w.tick(5.875).state, "waiting");
  assert.equal(w.tick(6).state, "up");
});

test("a link that keeps hearing data never probes", () => {
  const w = watch();
  for (let t = 0; t <= 10; t += 0.5) {
    assert.equal(both(w, t).probe, false);
  }
});

test("reset returns an up link to waiting and forgets what it heard", () => {
  const w = watch();
  const t = upAt(w, 0);
  w.reset();
  assert.equal(w.state, "waiting");
  assert.deepEqual(w.tick(t + 0.25), tickOf("waiting", false, false, false));
  assert.equal(w.tick(t + 2).state, "waiting");
});

test("reset forgets the probe history and the first tick time", () => {
  const w = watch();
  w.tick(0);
  assert.equal(w.tick(1).probe, true);
  w.reset();
  assert.equal(w.tick(1.25).probe, false);
  assert.equal(w.tick(2).probe, false);
  assert.equal(w.tick(2.25).probe, true);
});

test("after reset a fresh run comes up without reporting a recovery", () => {
  const w = watch();
  const t = upAt(w, 0);
  w.tick(t + 6);
  w.reset();
  both(w, 20);
  assert.deepEqual(both(w, 21), tickOf("up", true, false, false));
});

test("changing the options object after construction does not change the watch", () => {
  const mine: LinkWatchOptions = { ...opts };
  const w = new LinkWatch(mine);
  mine.staleS = 100;
  const t = upAt(w, 0);
  assert.equal(w.tick(t + 2).state, "stale");
});
