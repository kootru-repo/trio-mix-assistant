import assert from "node:assert/strict";
import test from "node:test";
import { RemoteCapture } from "../../src/core/capturelink.ts";
import { defaultConfig } from "../../src/core/config.ts";
import { Engine } from "../../src/core/engine/index.ts";
import { captureThread } from "../../src/host/capturethread.ts";
import { SystemClock, threadStamp } from "../../src/host/clock.ts";

const testCfg = defaultConfig();
const realClock = new SystemClock();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const busy = (ms: number): void => {
  const until = performance.now() + ms;
  while (performance.now() < until);
};

test("smoke, real threads: the audio thread keeps capturing while the main thread is frozen, and the engine does not restart it", async () => {
  const source = new RemoteCapture({ cfg: testCfg, connect: () => captureThread("timed"), clock: realClock, stamp: threadStamp });
  const engine = new Engine({ cfg: testCfg, clock: realClock, source, sim: true, tick: testCfg.BLOCK / testCfg.SAMPLE_RATE });
  let handled = 0;
  const onPushed = engine.onPushedBlock.bind(engine);
  engine.onPushedBlock = (block, age) => {
    handled += 1;
    onPushed(block, age);
  };
  await engine.start();
  try {
    assert.equal(source.status()["link"], "open");
    for (let i = 0; i < 200 && handled <= 15; i++) await sleep(50);
    const before = handled;
    const countBefore = handled + source.stale;
    const t0 = performance.now();
    assert.ok(before > 15, `blocks before the freeze: ${before}`);
    busy(1000);
    for (let i = 0; i < 200 && handled <= before + 15; i++) await sleep(50);
    const seconds = (performance.now() - t0) / 1000;
    const produced = handled + source.stale - countBefore;
    const expected = seconds * (testCfg.SAMPLE_RATE / testCfg.BLOCK);
    assert.ok(source.stale > 20, `blocks captured during the freeze must arrive afterwards (stale ${source.stale})`);
    assert.ok(
      produced > expected * 0.4,
      `captured ${produced}, expected about ${expected.toFixed(0)}: the capture thread stalled with the main thread`,
    );
    assert.ok(handled > before + 15, "fresh blocks are handled again after the freeze");
    assert.equal(source.dead(), false);
    const trouble = engine.events.filter((e) => /recover|could not restart|capture off/.test(e.msg)).map((e) => e.msg);
    assert.deepEqual(trouble, []);
  } finally {
    await engine.stop();
  }
});
