import assert from "node:assert/strict";
import test from "node:test";
import type { Clock } from "../src/core/clock.ts";
import { defaultConfig } from "../src/core/config.ts";
import { faderToDb, OscConsole } from "../src/core/console.ts";
import { decodeMessage } from "../src/core/oscwire.ts";
import { TickScheduler } from "../src/core/scheduler.ts";

const cfg = defaultConfig();

class VirtualClock implements Clock {
  now = 0;
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
    this.now += Math.max(0, seconds);
    return Promise.resolve();
  }
}

class TimedSink {
  readonly sent: { t: number; addr: string; db: number | null }[] = [];
  private readonly clock: VirtualClock;
  constructor(clock: VirtualClock) {
    this.clock = clock;
  }
  send(data: Uint8Array): void {
    const m = decodeMessage(data);
    assert.ok(m !== null);
    const v = m.args[0]?.v;
    this.sent.push({ t: this.clock.now, addr: m.address, db: typeof v === "number" && m.address.endsWith("/fader") ? faderToDb(v) : null });
  }
  close(): void {}
}

test("accounting: one fader write is one datagram, and a ramp of n steps is n datagrams to that channel only", async () => {
  const clock = new VirtualClock();
  const sink = new TimedSink(clock);
  const c = new OscConsole(sink, { cfg, clock });
  c.setFaderDb(3, -12);
  assert.equal(sink.sent.length, 1);
  c.rampFaderDb(4, -12, -6, 360, 12);
  await c.flushRamps();
  const ramp = sink.sent.slice(1);
  assert.equal(ramp.length, 12);
  assert.ok(ramp.every((m) => m.addr === "/ch/04/mix/fader"));
});

test("accounting: ramp steps are evenly spaced over the ramp time and move one way to the target", async () => {
  const clock = new VirtualClock();
  const sink = new TimedSink(clock);
  const c = new OscConsole(sink, { cfg, clock });
  c.rampFaderDb(2, -11, 1, 360, 12);
  await c.flushRamps();
  const steps = sink.sent;
  assert.equal(steps.length, 12);
  const gaps = steps.slice(1).map((m, i) => m.t - steps[i]!.t);
  for (const g of gaps) assert.ok(Math.abs(g - 0.03) < 1e-9, `step gap ${g} s, want 0.03 s`);
  const levels = steps.map((m) => m.db ?? Number.NaN);
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i]! >= levels[i - 1]! - 0.05, `step ${i} moved back: ${levels.join(", ")}`);
  assert.ok(Math.abs(levels.at(-1)! - 1) < 0.3, `ends at ${levels.at(-1)}`);
});

test("accounting: the tick schedule keeps its average period under jitter and never drifts", () => {
  const tick = cfg.BLOCK / cfg.SAMPLE_RATE;
  const s = new TickScheduler({ tick, maxLagS: 1 });
  let now = 1000;
  s.start(now);
  let t = now;
  const sleeps: number[] = [];
  for (let i = 0; i < 20_000; i++) {
    const jitter = (((i * 7919) % 13) - 6) * 0.0004;
    const p = s.plan(now);
    sleeps.push(p.sleepS);
    assert.equal(p.resumed, false);
    now += p.sleepS + Math.max(-p.sleepS, jitter);
    t += tick;
  }
  assert.ok(sleeps.every((x) => x >= 0));
  assert.ok(Math.abs(now - t) < tick * 2, `drift ${(now - t).toFixed(4)} s after 20,000 ticks`);
  const mean = sleeps.reduce((a, b) => a + b, 0) / sleeps.length;
  assert.ok(Math.abs(mean - tick) < tick * 0.1, `mean sleep ${mean} s, tick ${tick} s`);
});

test("accounting: after a ten-minute stall there is one resume and no burst of catch-up ticks", () => {
  const tick = cfg.BLOCK / cfg.SAMPLE_RATE;
  const s = new TickScheduler({ tick, maxLagS: 1 });
  let now = 50;
  s.start(now);
  for (let i = 0; i < 10; i++) now += s.plan(now).sleepS;
  now += 600;
  const after = Array.from({ length: 200 }, () => {
    const p = s.plan(now);
    now += p.sleepS;
    return p;
  });
  assert.equal(after.filter((p) => p.resumed).length, 1);
  assert.ok(Math.abs(after[0]!.gapS - 600) < 1, `gap ${after[0]!.gapS}`);
  const immediate = after.filter((p) => p.sleepS === 0).length;
  assert.ok(immediate <= 1, `${immediate} ticks ran back to back after the stall`);
});
