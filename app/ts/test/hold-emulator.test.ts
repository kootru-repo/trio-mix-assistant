import { defaultConfig } from "../src/core/config.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { ChannelFeatures } from "../src/core/dsp.ts";
import { OscConsole, dbToFader, faderToDb } from "../src/core/console.ts";
import { EmulatedDesk } from "../src/core/emulator.ts";
import { Engine } from "../src/core/engine/index.ts";
import { MemNetwork } from "../src/core/memtransport.ts";
import { MeterReceiver, SharedPortSink } from "../src/core/metersrv.ts";
import { argFloat } from "../src/core/oscargs.ts";
import { encodeMessage, oscFloat } from "../src/core/oscwire.ts";
import { zeroPad } from "../src/core/util.ts";
import { StepClock } from "./stepclock.ts";

const testCfg = defaultConfig();

const feat = (over: Partial<ChannelFeatures>): ChannelFeatures => ({
  rmsDbfs: -30,
  peakDbfs: -20,
  fbFreq: null,
  contrastDb: 0,
  harmonicity: 0,
  spectrum: new Float64Array(0),
  ...over,
});

const block = (ch: number, f: ChannelFeatures) => ({ feats: new Map([[ch, f]]), phases: [] });

interface Rig {
  net: MemNetwork;
  clock: StepClock;
  desk: EmulatedDesk;
  engine: Engine;
  run: (seconds: number) => Promise<void>;
  deskFader: (ch: number) => number;
  deskGain: (ch: number) => number;
  stop: () => Promise<void>;
}

async function rig(seed: (desk: EmulatedDesk, write: (addr: string, v: number) => Promise<void>) => Promise<void>): Promise<Rig> {
  const net = new MemNetwork();
  const clock = new StepClock(100, 1_700_000_000);
  const rx = new MeterReceiver(net, { cfg: testCfg, ip: "127.0.0.1", port: 0, allowFrom: "127.0.0.1" });
  await rx.start();
  const desk = new EmulatedDesk(net, clock, { cfg: testCfg, listenPort: 0, appIp: "127.0.0.1", appPort: rx.port, meterHz: 20 });
  await desk.start();
  const editor = await net.bind(0, "127.0.0.1");
  const write = async (addr: string, v: number): Promise<void> => {
    editor.send(encodeMessage(addr, [oscFloat(v)]), { host: "127.0.0.1", port: desk.listenPort });
    await net.settle();
  };
  await seed(desk, write);
  const sink = new SharedPortSink(rx, { host: "127.0.0.1", port: desk.listenPort }, { send: () => undefined, close: () => undefined });
  const con = new OscConsole(sink, { cfg: testCfg, clock, ip: "127.0.0.1" });
  const engine = new Engine({ cfg: testCfg, clock, sim: false, console: con, tick: 0.05 });
  rx.onFader = (ch, db) => engine.reconcileFader(ch, db);
  rx.onMeters = (vals) => engine.setConsoleMeters(vals);
  rx.onHeard = () => engine.consoleHeard();
  rx.onParam = (address, args) => engine.consoleParam(address, args);
  engine.meterRx = { start: () => Promise.resolve(), stop: () => undefined };
  await engine.start();
  const run = async (seconds: number): Promise<void> => {
    const n = Math.round(seconds / 0.05);
    for (let i = 0; i < n; i++) {
      await clock.advance(0.05);
      await net.settle();
    }
  };
  const read = (addr: string): number => argFloat((desk.params.get(addr) ?? [oscFloat(0)])[0]!) ?? Number.NaN;
  return {
    net,
    clock,
    desk,
    engine,
    run,
    deskFader: (ch) => faderToDb(desk.fader.get(ch) ?? read(`/ch/${zeroPad(ch, 2)}/mix/fader`)),
    deskGain: (ch) => read(`/headamp/${zeroPad(ch - 1, 3)}/gain`) * 72 - 12,
    stop: async () => {
      await engine.stop();
      desk.stop();
      rx.stop();
      editor.close();
    },
  };
}

const held = (e: Engine): boolean => Boolean((e.snapshot()["hold"] as { held: boolean }).held);

test("against the emulator the app reads the desk first, so the first trim starts from the desk's real preamp gain", async () => {
  const r = await rig(async (_desk, write) => {
    await write("/headamp/001/gain", (35 + 12) / 72);
  });
  try {
    assert.ok(held(r.engine), "the jobs start on hold");
    await r.run(3);
    assert.ok(!held(r.engine), "the desk was read and the jobs re-armed");
    assert.ok(Math.abs((r.engine.assistant.gainDb.get(2) ?? 0) - 35) < 0.01);
    r.engine.onPushedBlock(block(2, feat({ peakDbfs: -0.2 })), 0);
    await r.run(0.2);
    assert.ok(Math.abs(r.deskGain(2) - 33) < 0.05, `desk gain ${r.deskGain(2)}`);
  } finally {
    await r.stop();
  }
});

test("against the emulator the first vocal ride starts from the desk's real fader, one step at most", async () => {
  const r = await rig(async (_desk, write) => {
    await write("/ch/01/mix/fader", dbToFader(-10));
  });
  try {
    await r.run(3);
    assert.ok(!held(r.engine));
    assert.ok(Math.abs((r.engine.assistant.faderDb.get(testCfg.LEAD_VOCAL_CH) ?? 0) + 10) < 0.05);
    r.engine.command({ type: "toggle", job: "vocal_ride", on: true });
    r.engine.onPushedBlock(block(testCfg.LEAD_VOCAL_CH, feat({ rmsDbfs: -40 })), 0);
    await r.run(1);
    const now = r.deskFader(testCfg.LEAD_VOCAL_CH);
    assert.ok(now > -10 && now <= -10 + testCfg.ride.maxStepDb + 0.05, `desk fader ${now}`);
  } finally {
    await r.stop();
  }
});

test("against the emulator a cut network holds the jobs, and after it heals nothing moves until the desk is read again", async () => {
  const r = await rig(async () => undefined);
  try {
    await r.run(3);
    assert.ok(!held(r.engine));
    r.engine.command({ type: "toggle", job: "vocal_ride", on: true });
    r.net.filter = () => false;
    await r.run(2);
    assert.ok(held(r.engine), "the jobs are on hold while the link is down");
    const before = r.deskFader(testCfg.LEAD_VOCAL_CH);
    for (let i = 0; i < 10; i++) {
      r.engine.onPushedBlock(block(testCfg.LEAD_VOCAL_CH, feat({ rmsDbfs: -40 })), 0);
      await r.run(0.05);
    }
    assert.equal(r.engine.assistant.faderDb.get(testCfg.LEAD_VOCAL_CH), 0, "no belief drift while held");
    r.net.filter = null;
    await r.desk.handleAny({ host: "127.0.0.1", port: 1 }, "/ch/01/mix/fader", [oscFloat(dbToFader(-6))]);
    await r.run(3);
    assert.ok(!held(r.engine), "the jobs re-armed after the link came back and the desk was read");
    assert.ok(
      Math.abs((r.engine.assistant.faderDb.get(testCfg.LEAD_VOCAL_CH) ?? 0) + 6) < 0.05,
      "the belief follows the desk after the read",
    );
    assert.equal(before, 0);
    const events = r.engine.events.map((e) => e.msg);
    assert.ok(events.some((m) => m.includes("automatic jobs on hold")));
    assert.ok(events.some((m) => m.includes("console link back")));
    assert.ok(events.some((m) => m.includes("re-armed")));
  } finally {
    await r.stop();
  }
});
