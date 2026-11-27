import assert from "node:assert/strict";
import test from "node:test";
import { C, configWith } from "../src/core/config.ts";
import type { Config } from "../src/core/config.ts";
import { autoLane, ConsoleBase, OscConsole, SimConsole } from "../src/core/console.ts";
import type { ConsoleOptions } from "../src/core/console.ts";
import { EmulatedDesk } from "../src/core/emulator.ts";
import { MemNetwork } from "../src/core/memtransport.ts";
import { MeterReceiver } from "../src/core/metersrv.ts";
import type { OscArg } from "../src/core/oscwire.ts";
import { perChannel } from "../src/core/util.ts";
import { StepClock } from "./stepclock.ts";

class Capture extends ConsoleBase {
  sent: { addr: string; args: OscArg[] }[] = [];
  constructor(opts: ConsoleOptions = {}) {
    super(opts);
  }
  protected override send(addr: string, ...args: OscArg[]): void {
    this.sent.push({ addr, args });
  }
}

class Sink {
  count = 0;
  send(_data: Uint8Array): void {
    this.count++;
  }
  close(): void {}
}

function custom(): Config {
  return configWith({
    MAIN_BUS: "bus/07",
    limits: { ...C.limits, faderMinDb: -20, faderMaxDb: 2, headampMinDb: 5, headampMaxDb: 30 },
    feedback: { ...C.feedback, notchGainDb: -4, notchQ: 2.5 },
    safety: { ...C.safety, manualBurst: 2, manualPerS: 1, rampLateS: 30 },
    ride: { ...C.ride, rampMs: 2000 },
    CHANNELS: new Map([
      [3, "kick"],
      [5, "snare"],
      [7, "meas_mic"],
    ]),
    MEAS_MIC_CH: 7,
    ROLE_LABELS: new Map([["kick", "Bass Drum"]]),
    X32_NAME: "InjectedDesk",
    CONSOLE_PORT: 0,
    LOCAL_PORT: 0,
  });
}

function snapshot(): Config {
  return structuredClone(C);
}

test("a console clamps faders and gains to the injected limits", () => {
  const before = snapshot();
  const cfg = custom();
  const con = new SimConsole({ cfg });
  assert.equal(con.setFaderDb(1, 10), 2);
  assert.equal(con.setFaderDb(1, -60), -20);
  assert.equal(con.nudgeGainDb(1, 20, 40), 30);
  assert.equal(con.nudgeGainDb(1, 20, -40), 5);
  const plain = new SimConsole();
  assert.equal(plain.setFaderDb(1, 10), C.limits.faderMaxDb);
  assert.deepEqual(snapshot(), before);
});

test("a console uses the injected main bus and notch defaults", () => {
  const before = snapshot();
  const con = new Capture({ cfg: custom() });
  con.setMainMute(true);
  con.setMainFader(-3);
  con.setBusEq(2, 250, -3);
  assert.ok(con.sent.some((m) => m.addr === "/bus/07/mix/on"));
  assert.ok(con.sent.some((m) => m.addr === "/bus/07/mix/fader"));
  assert.ok(con.sent.some((m) => m.addr === "/bus/07/eq/2/f"));
  assert.ok(!con.sent.some((m) => m.addr.startsWith(`/${C.MAIN_BUS}/`)));
  const sim = new SimConsole({ cfg: custom() });
  autoLane(sim).setEqNotch(1, 1, 2500);
  assert.deepEqual(sim.notches.get(1), [{ band: 1, hz: 2500, gainDb: -4, q: 2.5 }]);
  assert.deepEqual(snapshot(), before);
});

async function rampAt(seconds: number, cfg?: Config): Promise<number | null> {
  const clock = new StepClock();
  const con = new Capture(cfg === undefined ? { clock } : { clock, cfg });
  autoLane(con).rampFaderDb(1, 0, -10);
  for (let k = 0; k < 10; k++) await Promise.resolve();
  await clock.advance(seconds);
  const at = con.lastWritten(1);
  await clock.advance(5);
  await con.flushRamps();
  return at;
}

test("a ramp takes its default time from the injected config", async () => {
  assert.equal(await rampAt(0.4), -10);
  const mid = await rampAt(0.4, custom());
  assert.ok(mid !== null && mid > -5 && mid < 0, String(mid));
});

async function queuedRamp(cfg?: Config): Promise<number[]> {
  const clock = new StepClock();
  const con = new Capture(cfg === undefined ? { clock } : { clock, cfg });
  const aborts: number[] = [];
  con.onRampAbort = (ch) => aborts.push(ch);
  con.rampFaderDb(2, 0, -1, 1000, 1);
  con.rampFaderDb(1, 0, -10, 100, 2);
  for (let i = 0; i < 4; i++) await clock.advance(1);
  await con.flushRamps();
  return aborts;
}

test("a queued ramp is judged late by the injected late limit", async () => {
  const before = snapshot();
  assert.deepEqual(await queuedRamp(), [1]);
  assert.deepEqual(await queuedRamp(custom()), []);
  assert.deepEqual(snapshot(), before);
});

test("an OSC console builds its write governor from the injected safety config", () => {
  const before = snapshot();
  const clock = new StepClock();
  const sink = new Sink();
  const con = new OscConsole(sink, { clock, cfg: custom() });
  for (let ch = 1; ch <= 5; ch++) con.setChannelMute(ch, true);
  assert.equal(sink.count, 2);
  const plainSink = new Sink();
  const plain = new OscConsole(plainSink, { clock });
  for (let ch = 1; ch <= 5; ch++) plain.setChannelMute(ch, true);
  assert.equal(plainSink.count, 5);
  assert.deepEqual(snapshot(), before);
});

test("the emulator seeds names and picks moves from the injected config", () => {
  const before = snapshot();
  const cfg = custom();
  const desk = new EmulatedDesk(new MemNetwork(), new StepClock(), { cfg });
  assert.equal(desk.params.get("/-prefs/name")![0]!.v, "InjectedDesk");
  assert.equal(desk.params.get("/ch/03/config/name")![0]!.v, "Bass Drum");
  assert.equal(desk.params.get("/ch/01/config/name")![0]!.v, "");
  assert.equal(desk.listenPort, 0);
  assert.equal(desk.appPort, 0);
  assert.equal(EmulatedDesk.extPick(0, cfg), 3);
  assert.equal(EmulatedDesk.extPick(1, cfg), 5);
  assert.equal(EmulatedDesk.extPick(2, cfg), 3);
  const plain = new EmulatedDesk(new MemNetwork(), new StepClock());
  assert.equal(plain.listenPort, C.CONSOLE_PORT);
  assert.equal(plain.params.get("/-prefs/name")![0]!.v, C.X32_NAME);
  assert.deepEqual(snapshot(), before);
});

test("the meter receiver takes its port from the injected config", () => {
  const before = snapshot();
  const rx = new MeterReceiver(new MemNetwork(), { cfg: configWith({ LOCAL_PORT: 12345 }) });
  assert.equal(rx.port, 12345);
  assert.equal(new MeterReceiver(new MemNetwork(), { cfg: configWith({ LOCAL_PORT: 12345 }), port: 7 }).port, 7);
  assert.equal(new MeterReceiver(new MemNetwork()).port, C.LOCAL_PORT);
  assert.deepEqual(snapshot(), before);
});

test("perChannel keys by the injected channel map", () => {
  const before = snapshot();
  assert.deepEqual([...perChannel(0, custom()).keys()], [3, 5, 7]);
  assert.deepEqual([...perChannel(0).keys()], [...C.CHANNELS.keys()]);
  assert.deepEqual(snapshot(), before);
});
