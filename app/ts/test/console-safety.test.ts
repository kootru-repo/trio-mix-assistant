import { defaultConfig } from "../src/core/config.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { Clock } from "../src/core/clock.ts";
import { eqParamToFreq, faderToDb, OscConsole, SimConsole } from "../src/core/console.ts";
import { decodeMessage } from "../src/core/oscwire.ts";
import type { OscArg } from "../src/core/oscwire.ts";
import { close } from "./helpers.ts";
import { StepClock } from "./stepclock.ts";

const testCfg = defaultConfig();

class Sink {
  readonly sent: { addr: string; args: OscArg[] }[] = [];
  send(data: Uint8Array): void {
    const m = decodeMessage(data);
    assert.ok(m !== null);
    this.sent.push({ addr: m.address, args: m.args });
  }
  close(): void {}
  addrs(): string[] {
    return this.sent.map((m) => m.addr);
  }
  faders(ch: string): number[] {
    return this.sent.filter((m) => m.addr === `/ch/${ch}/mix/fader`).map((m) => faderToDb(m.args[0]!.v as number));
  }
}

class SlipClock implements Clock {
  now = 0;
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

function setup<T extends Clock>(clock: T): { sink: Sink; c: OscConsole; aborts: [number, number | null][] } {
  const sink = new Sink();
  const c = new OscConsole(sink, { cfg: testCfg, clock });
  const aborts: [number, number | null][] = [];
  c.onRampAbort = (ch, lastDb) => {
    aborts.push([ch, lastDb]);
  };
  return { sink, c, aborts };
}

async function drain(clock: StepClock, c: OscConsole, seconds: number): Promise<void> {
  const done = c.flushRamps();
  for (let t = 0; t < seconds; t += 0.01) await clock.advance(0.01);
  await done;
}

test("a ramp that waited too long behind another is dropped and reports the last written level", async () => {
  const clock = new StepClock();
  const { sink, c, aborts } = setup(clock);
  c.setFaderDb(2, -9);
  c.rampFaderDb(1, -10, -4, 2000, 4);
  c.rampFaderDb(2, -9, -5, 300, 3);
  await drain(clock, c, 5);
  assert.equal(sink.faders("01").length, 4);
  assert.equal(sink.faders("02").length, 1);
  assert.equal(aborts.length, 1);
  assert.equal(aborts[0]![0], 2);
  close(aborts[0]![1]!, -9, 0, 1e-9);
});

test("a dropped ramp on a channel never written reports no last level", async () => {
  const clock = new StepClock();
  const { sink, c, aborts } = setup(clock);
  c.rampFaderDb(1, -10, -4, 2000, 4);
  c.rampFaderDb(3, -20, -5, 300, 3);
  await drain(clock, c, 5);
  assert.equal(sink.faders("03").length, 0);
  assert.deepEqual(aborts, [[3, null]]);
});

test("a ramp that waited just over its own length plus the grace is dropped", async () => {
  const clock = new StepClock();
  const { sink, c, aborts } = setup(clock);
  c.rampFaderDb(1, -10, -4, 900, 3);
  c.rampFaderDb(2, -20, -5, 300, 3);
  await drain(clock, c, 2);
  assert.equal(sink.faders("01").length, 3);
  assert.equal(sink.faders("02").length, 0);
  assert.deepEqual(aborts, [[2, null]]);
});

test("a ramp that waited no longer than its own length plus the grace still runs", async () => {
  const clock = new StepClock();
  const { sink, c, aborts } = setup(clock);
  c.rampFaderDb(1, -10, -4, 600, 3);
  c.rampFaderDb(2, -20, -5, 300, 3);
  await drain(clock, c, 2);
  assert.equal(sink.faders("01").length, 3);
  assert.equal(sink.faders("02").length, 3);
  assert.deepEqual(aborts, []);
});

test("a step that oversleeps aborts the rest of the ramp", async () => {
  const clock = new SlipClock();
  clock.extra = [0, 0.3];
  const { sink, c, aborts } = setup(clock);
  c.rampFaderDb(1, -10, -4, 300, 6);
  await c.flushRamps();
  const written = sink.faders("01");
  assert.equal(written.length, 2);
  assert.equal(aborts.length, 1);
  assert.equal(aborts[0]![0], 1);
  close(aborts[0]![1]!, written[1]!, 0, 1e-6);
  close(c.lastWritten(1)!, -8, 0, 1e-6);
});

test("a small slip within the overrun allowance keeps the ramp going", async () => {
  const clock = new SlipClock();
  clock.extra = [0.2, 0.2, 0.2];
  const { sink, c, aborts } = setup(clock);
  c.rampFaderDb(1, -10, -4, 300, 6);
  await c.flushRamps();
  assert.equal(sink.faders("01").length, 6);
  assert.deepEqual(aborts, []);
});

test("an oversleep after the last step does not count as an abort", async () => {
  const clock = new SlipClock();
  clock.extra = [0, 0, 5];
  const { sink, c, aborts } = setup(clock);
  c.rampFaderDb(1, -10, -4, 300, 3);
  await c.flushRamps();
  assert.equal(sink.faders("01").length, 3);
  assert.deepEqual(aborts, []);
});

test("normal ramps glide every step and reach their end", async () => {
  const clock = new StepClock();
  const { sink, c, aborts } = setup(clock);
  c.rampFaderDb(1, -10, -4, 350, 6);
  c.rampFaderDb(2, -12, -6, 350, 6);
  await drain(clock, c, 1);
  assert.equal(sink.faders("01").length, 6);
  assert.equal(sink.faders("02").length, 6);
  close(c.lastWritten(1)!, -4, 0, 1e-9);
  close(c.lastWritten(2)!, -6, 0, 1e-9);
  assert.deepEqual(aborts, []);
});

test("a ramp without a clock writes every step at once", async () => {
  const sink = new Sink();
  const c = new OscConsole(sink, { cfg: testCfg });
  c.rampFaderDb(1, -10, -4, 350, 4);
  await c.flushRamps();
  assert.equal(sink.faders("01").length, 4);
});

test("cancelling one channel's ramp stops it and leaves other channels gliding", async () => {
  const clock = new StepClock();
  const { sink, c, aborts } = setup(clock);
  c.rampFaderDb(1, -10, -4, 600, 6);
  c.rampFaderDb(2, -12, -6, 600, 6);
  const done = c.flushRamps();
  await clock.advance(0.25);
  const before = sink.faders("01").length;
  assert.ok(before >= 1 && before < 6);
  c.cancelRamp(1);
  await clock.advance(2);
  await done;
  assert.equal(sink.faders("01").length, before);
  assert.equal(sink.faders("02").length, 6);
  assert.deepEqual(aborts, []);
});

test("cancelling a queued ramp's channel keeps it from ever writing", async () => {
  const clock = new StepClock();
  const { sink, c } = setup(clock);
  c.rampFaderDb(1, -10, -4, 300, 3);
  c.rampFaderDb(2, -12, -6, 300, 3);
  c.cancelRamp(2);
  await drain(clock, c, 1);
  assert.equal(sink.faders("01").length, 3);
  assert.equal(sink.faders("02").length, 0);
});

test("the last written level follows fader writes, raw writes and ramp steps", async () => {
  const sink = new Sink();
  const c = new OscConsole(sink, { cfg: testCfg });
  assert.equal(c.lastWritten(5), null);
  assert.equal(c.setFaderDb(1, 99), 6);
  assert.equal(c.lastWritten(1), 6);
  c.setFaderRaw(1, -100);
  assert.equal(c.lastWritten(1), -90);
  c.rampFaderDb(2, -10, -4, 350, 2);
  await c.flushRamps();
  close(c.lastWritten(2)!, -4, 0, 1e-9);
  assert.equal(c.lastWritten(5), null);
  const sim = new SimConsole({ cfg: testCfg });
  sim.rampFaderDb(3, -10, -2);
  assert.equal(sim.lastWritten(3), -2);
});

test("a level that failed to send is not taken as written", () => {
  const c = new OscConsole(
    {
      send: () => {
        throw new Error("socket closed");
      },
      close: () => {},
    },
    { cfg: testCfg },
  );
  assert.throws(() => c.setFaderDb(1, -3));
  assert.equal(c.lastWritten(1), null);
});

test("a first EQ write sends the gain first", () => {
  const sink = new Sink();
  const c = new OscConsole(sink, { cfg: testCfg });
  c.setEqNotch(1, 2, 2500);
  assert.deepEqual(sink.addrs(), ["/ch/01/eq/2/g", "/ch/01/eq/2/type", "/ch/01/eq/2/f", "/ch/01/eq/2/q", "/ch/01/eq/on"]);
});

test("a cut sends the gain first and a boost sends it last", () => {
  const sink = new Sink();
  const c = new OscConsole(sink, { cfg: testCfg });
  c.setBusEq(3, 250, -2);
  sink.sent.length = 0;
  c.setBusEq(3, 400, -6);
  assert.deepEqual(sink.addrs(), ["/main/st/eq/3/g", "/main/st/eq/3/type", "/main/st/eq/3/f", "/main/st/eq/3/q", "/main/st/eq/on"]);
  sink.sent.length = 0;
  c.setBusEq(3, 600, 4);
  assert.deepEqual(sink.addrs(), ["/main/st/eq/3/type", "/main/st/eq/3/f", "/main/st/eq/3/q", "/main/st/eq/3/g", "/main/st/eq/on"]);
  sink.sent.length = 0;
  c.setBusEq(3, 700, 4);
  assert.equal(sink.addrs()[0], "/main/st/eq/3/g");
});

test("EQ bands keep their gain history apart and a scene recall forgets it", () => {
  const sink = new Sink();
  const c = new OscConsole(sink, { cfg: testCfg });
  c.setEqBand(4, 1, 100, -3, 1);
  c.setEqBand(4, 2, 1000, -3, 1, false);
  sink.sent.length = 0;
  c.setEqBand(4, 1, 120, 3, 1);
  c.setEqBand(5, 1, 120, 3, 1);
  c.setEqBand(4, 2, 1000, 3, 1, false);
  assert.deepEqual(sink.addrs(), [
    "/ch/04/eq/1/type",
    "/ch/04/eq/1/f",
    "/ch/04/eq/1/q",
    "/ch/04/eq/1/g",
    "/ch/04/eq/on",
    "/ch/05/eq/1/g",
    "/ch/05/eq/1/type",
    "/ch/05/eq/1/f",
    "/ch/05/eq/1/q",
    "/ch/05/eq/on",
    "/ch/04/eq/2/g",
    "/ch/04/eq/2/type",
    "/ch/04/eq/2/f",
    "/ch/04/eq/2/q",
  ]);
  c.recallScene(1);
  sink.sent.length = 0;
  c.setEqBand(4, 1, 120, 9, 1);
  assert.equal(sink.addrs()[0], "/ch/04/eq/1/g");
});

test("an EQ write that failed part way leaves the next write gain first", () => {
  let fail = false;
  const sent: string[] = [];
  const c = new OscConsole(
    {
      send: (data) => {
        const addr = decodeMessage(data)?.address ?? "";
        if (fail && addr.endsWith("/f")) throw new Error("socket closed");
        sent.push(addr);
      },
      close: () => {},
    },
    { cfg: testCfg },
  );
  c.setEqNotch(1, 1, 1000, -9, 4);
  fail = true;
  assert.throws(() => c.setEqNotch(1, 1, 2000, 6, 4));
  fail = false;
  sent.length = 0;
  c.setEqNotch(1, 1, 2000, 6, 4);
  assert.equal(sent[0], "/ch/01/eq/1/g");
});

interface BandState {
  hz: number;
  gain: number;
}

const gainOf = (v: number): number => v * 30 - 15;

test("no prefix of a recorded EQ sequence leaves a band louder at its new frequency than intended", () => {
  const sim = new SimConsole({ cfg: testCfg });
  const moves: [number, number, number][] = [
    [1000, -12, 8],
    [1000, 6, 2],
    [3150, -9, 8],
    [500, 9, 1],
    [500, 9, 1],
    [2000, 3, 2],
    [2000, -15, 10],
    [8000, 12, 1],
    [250, -3, 4],
    [250, 15, 4],
    [4000, -15, 8],
  ];
  const steps: { old: BandState | null; next: BandState; wire: [string, ...OscArg[]][] }[] = [];
  let prev: BandState | null = null;
  for (const [i, [hz, gain, q]] of moves.entries()) {
    const start = sim.wireLog.length;
    if (i % 2 === 0) sim.setEqNotch(2, 3, hz, gain, q);
    else sim.setEqBand(2, 3, hz, gain, q);
    const next = { hz, gain };
    steps.push({ old: prev, next, wire: sim.wireLog.slice(start) });
    prev = next;
  }
  for (const { old, next, wire } of steps) {
    const band: { hz: number | null; gain: number | null } = old ? { hz: old.hz, gain: old.gain } : { hz: null, gain: null };
    for (let k = 0; k <= wire.length; k++) {
      if (k > 0) {
        const [addr, arg] = wire[k - 1]!;
        if (addr.endsWith("/f")) band.hz = eqParamToFreq(arg!.v as number);
        if (addr.endsWith("/g")) band.gain = gainOf(arg!.v as number);
      }
      if (band.hz === null || band.gain === null) continue;
      const atNew = Math.abs(band.hz - next.hz) / next.hz < 1e-6;
      const atOld = old !== null && Math.abs(band.hz - old.hz) / old.hz < 1e-6;
      if (atNew && !atOld) assert.ok(band.gain <= next.gain + 1e-9, `prefix ${k} of ${next.hz} Hz holds ${band.gain} dB`);
      if (atOld && old !== null) assert.ok(band.gain <= Math.max(old.gain, next.gain) + 1e-9, `prefix ${k} at old ${old.hz} Hz`);
    }
  }
  assert.equal(steps.length, moves.length);
});
