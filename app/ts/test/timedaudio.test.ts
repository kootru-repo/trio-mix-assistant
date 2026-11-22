import assert from "node:assert/strict";
import test from "node:test";
import { C } from "../src/core/config.ts";
import { TimedAudioFactory, TimedAudioStream } from "../src/core/timedaudio.ts";
import { SystemClock } from "../src/host/clock.ts";
import { closeArray, f32, fixture } from "./helpers.ts";
import { StepClock } from "./stepclock.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("the default content matches the recorded frames, including the meas-mic ring column", () => {
  for (const c of fixture<{ channels: number; indexes: number[]; frames: string[]; block: number }[]>("timedaudio")) {
    const ts = new TimedAudioStream(() => undefined, c.channels, new SystemClock());
    c.indexes.forEach((idx, k) => {
      const got = ts.defaultContent(idx);
      assert.equal(got.length, C.BLOCK * c.channels);
      closeArray(got, f32(c.frames[k]!), 1e-5, 1e-7, `channels ${c.channels} block ${idx}`);
    });
  }
});

test("the loop fires the callback at the block rate", async () => {
  const got: Float32Array[] = [];
  const ts = new TimedAudioStream((f) => got.push(f), 8, new SystemClock());
  ts.start();
  await sleep(150);
  ts.stop();
  await ts.settled();
  assert.ok(got.length >= 2);
  assert.equal(got[0]!.length, C.BLOCK * 8);
});

test("deliver=false suppresses callbacks", async () => {
  const got: number[] = [];
  const ts = new TimedAudioStream(() => got.push(1), 8, new SystemClock());
  ts.deliver = false;
  ts.start();
  await sleep(100);
  ts.stop();
  await ts.settled();
  assert.deepEqual(got, []);
});

test("the xrun flag propagates once", async () => {
  const flags: boolean[] = [];
  const ts = new TimedAudioStream((_f, x) => flags.push(x), 8, new SystemClock());
  ts.xrunNext = true;
  ts.start();
  await sleep(150);
  ts.stop();
  await ts.settled();
  assert.equal(flags[0], true);
  assert.ok(flags.slice(1).every((x) => !x));
});

async function countOverOneSecond(restart: boolean): Promise<number> {
  const clock = new StepClock(0);
  let n = 0;
  const ts = new TimedAudioStream(() => void n++, 2, clock);
  ts.start();
  if (restart) {
    await clock.advance(0.05);
    ts.stop();
    ts.start();
    n = 0;
  }
  await clock.advance(1);
  ts.stop();
  await clock.advance(1);
  await ts.settled();
  return n;
}

test("start, stop, start runs exactly one loop", async () => {
  const single = await countOverOneSecond(false);
  const restarted = await countOverOneSecond(true);
  assert.ok(single > 30);
  assert.ok(Math.abs(restarted - single) <= 2, `${restarted} vs ${single}`);
});

test("nothing is delivered after stop", async () => {
  const clock = new StepClock(0);
  let n = 0;
  const ts = new TimedAudioStream(() => void n++, 2, clock);
  ts.start();
  await clock.advance(0.2);
  ts.stop();
  const at = n;
  await clock.advance(1);
  assert.equal(n, at);
  assert.equal(clock.waiting, 0);
});

test("an exception thrown by the callback is recorded and the loop keeps running", async () => {
  const clock = new StepClock(0);
  let calls = 0;
  const ts = new TimedAudioStream(
    () => {
      calls += 1;
      throw new Error("consumer failed");
    },
    2,
    clock,
  );
  ts.start();
  await clock.advance(0.5);
  ts.stop();
  await clock.advance(0.1);
  assert.ok(calls > 3);
  assert.match(String((ts.lastError as Error).message), /consumer failed/);
});

test("the factory keeps only the most recent streams", () => {
  const factory = new TimedAudioFactory(new StepClock(0));
  for (let i = 0; i < 20; i++) factory.open({ device: null, channels: 2, sampleRate: 48000, blockSize: 1024 }, () => undefined);
  assert.equal(factory.streams.length, 8);
});
