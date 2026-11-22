import assert from "node:assert/strict";
import test from "node:test";
import { loopbackPort } from "../src/core/capturelink.ts";
import { C } from "../src/core/config.ts";
import type { AudioDeviceInfo, AudioInputCallback, AudioInputFactory, AudioInputOptions, AudioInputStream } from "../src/core/devicecapture.ts";
import { SystemClock, threadStamp } from "../src/host/clock.ts";
import { autodetectSource } from "../src/host/main.ts";

interface Fake {
  name: string;
  channels: number;
  level: number | null;
}

class LevelFactory implements AudioInputFactory {
  readonly fakes: Fake[];
  readonly opened: number[] = [];

  constructor(fakes: Fake[]) {
    this.fakes = fakes;
  }

  listDevices(): AudioDeviceInfo[] {
    return this.fakes.map((f) => ({ name: f.name, max_input_channels: f.channels, default_samplerate: 48000, hostapi: 0 }));
  }
  listHostApis(): { name: string }[] {
    return [{ name: "Windows WASAPI" }];
  }
  defaultInputIndex(): number | null {
    return 0;
  }
  queryDevice(device: number | string | null): AudioDeviceInfo {
    return this.listDevices()[Number(device)]!;
  }
  open(options: AudioInputOptions, cb: AudioInputCallback): AudioInputStream {
    const index = Number(options.device);
    this.opened.push(index);
    const fake = this.fakes[index]!;
    const feed = (): void => {
      if (fake.level !== null) cb(new Float32Array(C.BLOCK * options.channels).fill(fake.level), false);
    };
    let mine: ReturnType<typeof setInterval> | null = null;
    return {
      start: () => {
        mine = setInterval(feed, (1000 * C.BLOCK) / C.SAMPLE_RATE);
      },
      stop: () => undefined,
      close: () => {
        if (mine !== null) clearInterval(mine);
      },
    };
  }
}

const detect = async (fakes: Fake[]) => {
  const factory = new LevelFactory(fakes);
  const clock = new SystemClock();
  const lines: string[] = [];
  const source = await autodetectSource({ factory, clock, out: (l) => lines.push(l), connect: () => loopbackPort(factory, clock, threadStamp) });
  return { source, factory, text: lines.join("\n") };
};

test("auto input passes over a completely silent small device for one that has signal", async () => {
  const { source, text } = await detect([
    { name: "Unplugged headset", channels: 1, level: 0 },
    { name: "Room mic", channels: 2, level: 0.05 },
  ]);
  assert.ok(source !== null);
  assert.equal(source.device, 1);
  assert.match(text, /Unplugged headset is completely silent/);
  assert.match(text, /Auto input: \[1\] Room mic/);
  source.stop();
  await source.settled();
});

test("auto input falls back to a silent device with a warning when nothing has signal", async () => {
  const { source, text } = await detect([
    { name: "Quiet one", channels: 1, level: 0 },
    { name: "Quiet two", channels: 2, level: 0 },
  ]);
  assert.ok(source !== null);
  assert.equal(source.device, 0);
  assert.match(text, /every input was silent/);
  source.stop();
  await source.settled();
});

test("auto input keeps a silent multichannel device, since a console may simply have nothing playing", async () => {
  const { source, factory, text } = await detect([
    { name: "Console USB", channels: 32, level: 0 },
    { name: "Laptop mic", channels: 2, level: 0.05 },
  ]);
  assert.ok(source !== null);
  assert.equal(source.device, 0);
  assert.deepEqual(factory.opened, [0]);
  assert.doesNotMatch(text, /silent/);
  source.stop();
  await source.settled();
});

test("auto input skips a device that delivers nothing and reports when none works", async () => {
  const one = await detect([
    { name: "Busy", channels: 2, level: null },
    { name: "Works", channels: 2, level: 0.05 },
  ]);
  assert.ok(one.source !== null);
  assert.equal(one.source.device, 1);
  assert.match(one.text, /Busy.*delivered no audio/);
  one.source.stop();
  await one.source.settled();
  const none = await detect([{ name: "Busy", channels: 2, level: null }]);
  assert.equal(none.source, null);
  assert.match(none.text, /no input delivered audio/);
});
