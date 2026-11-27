import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RemoteCapture } from "../src/core/capturelink.ts";
import { ManualClock } from "../src/core/clock.ts";
import { channelMapState, defaultConfig } from "../src/core/config.ts";
import { Engine } from "../src/core/engine/index.ts";
import { parseOverride, withTuning } from "../src/core/tuning.ts";
import { NativeAudioInputFactory } from "../src/host/audiodevice.ts";
import { captureThread } from "../src/host/capturethread.ts";
import { SystemClock } from "../src/host/clock.ts";
import { findLayout } from "../src/host/layout.ts";
import type { Io } from "../src/host/main.ts";
import { NodeUdpFactory } from "../src/host/udp.ts";
import { inAppVet } from "../src/host/vet.ts";

const vetIo = (appDir: string): Io => ({
  out: () => undefined,
  clock: new SystemClock(),
  audio: () => NativeAudioInputFactory.create(),
  factory: null,
  connect: captureThread,
  udp: new NodeUdpFactory(),
  waitForStop: () => new Promise(() => undefined),
  layout: { ...findLayout(), appDir },
});

test("the in-app full test leaves the live config and the live engine untouched, during the run and after it", async () => {
  const home = mkdtempSync(join(tmpdir(), "vet-iso-"));
  writeFileSync(join(home, "show.conf"), "MODE=sim\nLAN=no\n");
  const live = withTuning(defaultConfig(), [
    parseOverride("feedback.ringDb=20", "show.conf"),
    parseOverride("manual.holdS=30", "show.conf"),
  ]);
  const engine = new Engine({ sim: true, clock: new ManualClock(100, 1_700_000_000), cfg: live });
  const capture = new RemoteCapture({
    connect: () => {
      throw new Error("not used");
    },
    clock: new ManualClock(),
    stamp: () => 0,
    cfg: live,
  });
  const mapBefore = channelMapState(live);
  const tuningBefore = JSON.stringify({ feedback: live.feedback, manual: live.manual, ride: live.ride });
  const captureBefore = JSON.stringify(capture.config());
  const problems = new Set<string>();
  let checks = 0;
  const look = (): void => {
    checks += 1;
    if (JSON.stringify([...channelMapState(live).channels]) !== JSON.stringify([...mapBefore.channels]))
      problems.add("the live channel map changed");
    if (JSON.stringify(channelMapState(live).stereoLinks) !== JSON.stringify(mapBefore.stereoLinks))
      problems.add("the live stereo links changed");
    if (JSON.stringify({ feedback: live.feedback, manual: live.manual, ride: live.ride }) !== tuningBefore)
      problems.add("the live tuning changed");
    if (JSON.stringify(capture.config()) !== captureBefore) problems.add("the audio worker would be sent another channel map");
    const two = engine.assistant.faderDb.get(2) ?? 0;
    const three = engine.assistant.faderDb.get(3) ?? 0;
    engine.setFader(2, two - 1);
    if (engine.assistant.faderDb.get(3) !== three) problems.add("a fader move on the live engine dragged another channel");
    engine.setFader(2, two);
    engine.setFader(3, three);
  };
  try {
    const io = vetIo(home);
    io.factory = await io.audio();
    const host = inAppVet(io, null, () => Promise.resolve(null), live);
    const out = await host.run(
      { channel: null, gain: false, main: false, identify: false },
      { stopped: () => false, takeover: () => false, progress: () => look() },
    );
    look();
    assert.equal(out.failed, 0, out.text);
    assert.ok(checks > 10);
    assert.deepEqual([...problems], []);
    assert.deepEqual(channelMapState(live), mapBefore);
    assert.equal(live.feedback.ringDb, 20);
    assert.equal(live.manual.holdS, 30);
    assert.equal(live.TUNED.length, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
