import assert from "node:assert/strict";
import test from "node:test";
import { C } from "../src/core/config.ts";
import { TimedAudioStream } from "../src/core/timedaudio.ts";
import { SystemClock } from "../src/host/clock.ts";
import { closeArray, f32, fixture } from "./helpers.ts";

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
