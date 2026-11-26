import assert from "node:assert/strict";
import test from "node:test";
import { ManualClock } from "../src/core/clock.ts";
import { ConsoleBase, dbToFader, eqParamToFreq, faderToDb, freqToEqParam, qToParam, SimConsole } from "../src/core/console.ts";
import {
  decodeMessage,
  decodeMeterBlob,
  decodePacket,
  decodeReply,
  encodeMeterBlob,
  encodeMessage,
  oscBlob,
  oscFloat,
  oscInt,
  oscStr,
  utf8Decode,
  utf8Encode,
} from "../src/core/oscwire.ts";
import type { OscArg } from "../src/core/oscwire.ts";
import { AbleSetReceiver } from "../src/core/showclock.ts";
import type { UdpEndpoint } from "../src/core/transport.ts";
import { close, fixture, recording, saveFixture } from "./helpers.ts";

const fx = fixture("osc");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const unhex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, "hex"));

class Capture extends ConsoleBase {
  sent: { addr: string; args: OscArg[] }[] = [];
  protected override send(addr: string, ...args: OscArg[]): void {
    this.sent.push({ addr, args });
  }
}

function script(c: ConsoleBase): void {
  c.setFaderDb(1, -7.3);
  c.setFaderDb(2, 99.0);
  c.setFaderDb(3, -50.0);
  c.nudgeGainDb(3, 20.0, 3.5);
  c.nudgeGainDb(1, 55.0, 30.0);
  c.nudgeGainDb(0, 0.0, 0.0);
  c.setEqNotch(1, 1, 2500.5);
  c.setEqNotch(2, 2, 10.0, -12.0, 0.1);
  c.setBusEq(2, 250.0, -4.5);
  c.setBusEq(3, 99999.0, 7.0, 20.0);
  c.setEqBand(4, 2, 1000.0, 3.0, 2.0, false);
  c.setEqBand(4, 3, 120.0, -2.0, 4.0);
  c.setSend(2, 1, -12.0);
  c.setFxReturn(1, -3.0);
  c.recallScene(5);
  c.setMainMute(true);
  c.clearChannelEq(3);
  c.setFaderRaw(1, -100.0);
  c.setChannelMute(2, true);
  c.setChannelMute(2, false);
  c.setPolarity(3, true);
  c.setMainFader(4.0);
  c.subscribeMeters();
  c.setEqNotch(1, 4, 800.0);
  c.setEqNotch(1, 4, 900.0);
}

test("scaling helpers match the stored reference", () => {
  const t = fx.tables;
  t.dbs.forEach((d: number, i: number) => close(dbToFader(d), t.db_to_fader[i], 1e-12, 1e-12, `db ${d}`));
  t.fs.forEach((f: number, i: number) => close(faderToDb(f), t.fader_to_db[i], 1e-12, 1e-9, `fader ${f}`));
  t.hz.forEach((h: number, i: number) => {
    close(freqToEqParam(h), t.freq_param[i], 1e-12, 1e-12, `hz ${h}`);
    close(eqParamToFreq(freqToEqParam(h)), t.param_freq[i], 1e-9, 1e-9, `roundtrip ${h}`);
  });
  t.qs.forEach((q: number, i: number) => close(qToParam(q), t.q_param[i], 1e-12, 1e-12, `q ${q}`));
});

test("every console call puts the recorded bytes on the wire", () => {
  const c = new Capture();
  script(c);
  if (recording) {
    fx.wire = c.sent.map((m) => ({ addr: m.addr, args: m.args.map((a) => ({ t: a.t, v: a.v })), hex: hex(encodeMessage(m.addr, m.args)) }));
    saveFixture("osc", fx);
  }
  assert.equal(c.sent.length, fx.wire.length);
  c.sent.forEach((m, i) => {
    const ref = fx.wire[i];
    assert.equal(m.addr, ref.addr, `address ${i}`);
    assert.equal(m.args.length, ref.args.length, `${m.addr} arg count`);
    m.args.forEach((a, j) => {
      assert.equal(a.t, ref.args[j].t, `${m.addr} arg ${j} type`);
      if (a.t === "f") close(a.v as number, ref.args[j].v, 0, 1e-12, `${m.addr} arg ${j}`);
      else assert.equal(a.v, ref.args[j].v, `${m.addr} arg ${j}`);
    });
    assert.equal(hex(encodeMessage(m.addr, m.args)), ref.hex, `${m.addr} bytes`);
  });
});

test("SimConsole ends in the recorded state", () => {
  const c = new SimConsole();
  script(c);
  const s = fx.sim;
  const obj = (m: Map<number, any>) => Object.fromEntries([...m].map(([k, v]) => [String(k), v]));
  for (const [k, v] of Object.entries(s.fader_db)) close(c.faderDb.get(Number(k))!, v as number, 0, 1e-12, `fader ${k}`);
  assert.equal(c.faderDb.size, Object.keys(s.fader_db).length);
  for (const [k, v] of Object.entries(s.gain_db)) close(c.gainDb.get(Number(k))!, v as number, 0, 1e-12, `gain ${k}`);
  assert.deepEqual(
    Object.fromEntries([...c.notches].map(([k, v]) => [String(k), v.map((n) => [n.band, n.hz, n.gainDb, n.q])])),
    Object.fromEntries(
      Object.entries(s.notches).map(([k, v]: [string, any]) => [k, v.map((n: any) => [n.band, n.hz, n.gain_db, n.q])]),
    ),
  );
  assert.deepEqual(
    Object.fromEntries([...c.busEq].map(([k, v]) => [String(k), [v.hz, v.gainDb, v.q]])),
    Object.fromEntries(Object.entries(s.bus_eq).map(([k, v]: [string, any]) => [k, [v.hz, v.gain_db, v.q]])),
  );
  assert.equal(c.mainMuted, s.main_muted);
  assert.deepEqual(obj(c.chMuted), s.ch_muted);
  assert.equal(c.masterDb, s.master_db);
  assert.equal(c.lastScene, s.last_scene);
  assert.deepEqual(
    Object.fromEntries([...c.eqBands].map(([k, v]) => [String(k), Object.fromEntries([...v].map(([b, d]) => [String(b), [d.hz, d.gainDb, d.q, d.on]]))])),
    Object.fromEntries(
      Object.entries(s.eq_bands).map(([k, v]: [string, any]) => [
        k,
        Object.fromEntries(Object.entries(v).map(([b, d]: [string, any]) => [b, [d.hz, d.gain_db, d.q, d.on]])),
      ]),
    ),
  );
  assert.deepEqual(Object.fromEntries(c.sends), s.sends);
  assert.deepEqual(obj(c.fxReturns), s.fx_returns);
  assert.deepEqual(obj(c.polarity), s.polarity);
  assert.deepEqual(c.notchFreqs(1), s.notch_freqs_1);
  assert.deepEqual(c.predipFreqs(), s.predip);
  assert.deepEqual([c.isTamed(1, 900), c.isTamed(1, 1500), c.isTamed(2, 250), c.isTamed(1, 0)], s.tamed);
});

test("encoded messages decode back to the same arguments", () => {
  for (const ref of fx.wire) {
    const m = decodeMessage(unhex(ref.hex));
    assert.ok(m, ref.addr);
    assert.equal(m.address, ref.addr);
    assert.equal(m.args.length, ref.args.length);
    m.args.forEach((a, j) => {
      if (a.t === "s") assert.equal(a.v, ref.args[j].v);
      else close(a.v as number, ref.args[j].v, 1e-6, 1e-6, `${ref.addr} ${j}`);
    });
  }
  const withBlob = encodeMessage("/meters/1", [oscStr("x"), oscBlob(Uint8Array.of(1, 2, 3, 4, 5)), oscInt(-7), oscFloat(0.5)]);
  const back = decodeMessage(withBlob)!;
  assert.deepEqual(back.args.map((a) => a.t), ["s", "b", "i", "f"]);
  assert.deepEqual([...(back.args[1] as { v: Uint8Array }).v], [1, 2, 3, 4, 5]);
  assert.equal(withBlob.length % 4, 0);
});

test("garbled datagrams are rejected, not thrown on", () => {
  assert.equal(decodeMessage(Uint8Array.of(1, 2, 3)), null);
  assert.equal(decodeMessage(new Uint8Array(0)), null);
  assert.equal(decodeMessage(unhex("2f61000000000000")), null);
  assert.equal(decodeMessage(unhex("2f61")), null);
  assert.deepEqual(decodeMessage(unhex("2f61000000")), { address: "/a", args: [] });
  const trunc = encodeMessage("/a", [oscFloat(1)]).slice(0, 10);
  assert.equal(decodeMessage(trunc), null);
  assert.deepEqual(decodePacket(unhex("00")), []);
});

test("bundles are unpacked into their messages", () => {
  const one = encodeMessage("/a", [oscInt(1)]);
  const two = encodeMessage("/b", [oscInt(2)]);
  const head = new Uint8Array([...Buffer.from("#bundle\0"), 0, 0, 0, 0, 0, 0, 0, 1]);
  const len = (n: number) => new Uint8Array([0, 0, 0, n]);
  const bundle = new Uint8Array([...head, ...len(one.length), ...one, ...len(two.length), ...two]);
  assert.deepEqual(decodePacket(bundle).map((m) => m.address), ["/a", "/b"]);
});

test("meter blobs match the recorded encoder and decoder, including bad input", () => {
  const b = fx.blobs;
  assert.equal(hex(encodeMeterBlob(b.values)), b.good_hex);
  for (const c of b.cases) {
    const got = decodeMeterBlob(unhex(c.hex));
    assert.equal(got.length, c.decoded.length, c.hex);
    got.forEach((v, i) => close(v, c.decoded[i], 0, 1e-12, `${c.hex} ${i}`));
  }
});

test("a ramp glides in steps through the injected clock and the simulator jumps straight to the end", async () => {
  const clock = new ManualClock();
  class Ramp extends Capture {
    constructor() {
      super({ clock });
    }
  }
  const c = new Ramp();
  assert.equal(c.rampFaderDb(1, -10, -4, 350, 6), -4);
  await c.flushRamps();
  assert.equal(c.sent.length, 6);
  close(clock.monotonic(), 0.35, 1e-9, 1e-9, "ramp duration");
  const first = c.sent[0]!.args[0]!.v as number;
  const last = c.sent[5]!.args[0]!.v as number;
  assert.ok(first < last);
  close(last, dbToFader(-4), 0, 1e-12);

  const sim = new SimConsole();
  assert.equal(sim.rampFaderDb(1, -10, 50), 6);
  assert.equal(sim.faderDb.get(1), 6);
  assert.equal(sim.wireLog.length, 1);
});

test("closing a console stops a ramp that is still running", async () => {
  const clock = new ManualClock();
  const c = new (class extends Capture {
    constructor() {
      super({ clock });
    }
  })();
  c.rampFaderDb(1, -10, -4, 350, 12);
  c.close();
  await c.flushRamps();
  assert.ok(c.sent.length < 12);
});

class Gate {
  private waiters: (() => void)[] = [];
  readonly clock = {
    monotonic: () => 0,
    highResolution: () => 0,
    time: () => 0,
    hhmmss: () => "",
    sleep: (): Promise<void> => new Promise<void>((resolve) => this.waiters.push(resolve)),
  };
  release(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("a manual fader move ends a ramp that is still gliding", async () => {
  const gate = new Gate();
  const c = new Capture({ clock: gate.clock });
  c.rampFaderDb(1, -10, -4, 350, 6);
  await tick();
  assert.equal(c.sent.length, 1);
  c.setFaderRaw(1, 0);
  assert.equal(c.sent.length, 2);
  gate.release();
  await tick();
  gate.release();
  await c.flushRamps();
  assert.equal(c.sent.length, 2);
});

test("a public fader write and a cancel also stop a ramp, and a later ramp still runs", async () => {
  const gate = new Gate();
  const c = new Capture({ clock: gate.clock });
  c.rampFaderDb(1, -10, -4, 350, 6);
  await tick();
  c.setFaderDb(1, -2);
  c.rampFaderDb(2, -10, -4, 350, 3);
  c.cancelRamps();
  gate.release();
  await tick();
  gate.release();
  await c.flushRamps();
  assert.equal(c.sent.length, 2);
  c.rampFaderDb(3, -10, -4, 350, 3);
  gate.release();
  const done = c.flushRamps();
  for (let i = 0; i < 4; i++) {
    await tick();
    gate.release();
  }
  await done;
  assert.equal(c.sent.filter((m) => m.addr === "/ch/03/mix/fader").length, 3);
});

test("a failed send inside a ramp does not wedge later ramps", async () => {
  const clock = new ManualClock();
  let fail = true;
  class Flaky extends Capture {
    protected override send(addr: string, ...args: OscArg[]): void {
      if (fail) throw new Error("socket closed");
      super.send(addr, ...args);
    }
  }
  const c = new Flaky({ clock });
  c.rampFaderDb(1, -10, -4, 350, 3);
  await c.flushRamps();
  assert.ok(c.lastRampError instanceof Error);
  fail = false;
  c.rampFaderDb(2, -10, -4, 350, 3);
  await c.flushRamps();
  assert.equal(c.sent.length, 3);
});

test("the console never sends a non-finite number and leaves no trace when it refuses", () => {
  const c = new SimConsole();
  const bad = [Number.NaN, Infinity, -Infinity];
  for (const v of bad) {
    assert.throws(() => c.setFaderDb(1, v), RangeError);
    assert.throws(() => c.setFaderRaw(1, v), RangeError);
    assert.throws(() => c.setMainFader(v), RangeError);
    assert.throws(() => c.nudgeGainDb(1, 20, v), RangeError);
    assert.throws(() => c.nudgeGainDb(1, v, 1), RangeError);
    assert.throws(() => c.setSend(1, 1, v), RangeError);
    assert.throws(() => c.setFxReturn(1, v), RangeError);
    assert.throws(() => c.setEqNotch(1, 1, v), RangeError);
    assert.throws(() => c.setEqNotch(1, 1, 1000, v), RangeError);
    assert.throws(() => c.setEqNotch(1, 1, 1000, -9, v), RangeError);
    assert.throws(() => c.setBusEq(1, 1000, v), RangeError);
    assert.throws(() => c.setEqBand(1, 1, 1000, v, 2), RangeError);
  }
  assert.equal(c.wireLog.length, 0);
  assert.equal(c.faderDb.size, 0);
  assert.equal(c.gainDb.size, 0);
  assert.equal(c.masterDb, 0);
  assert.equal(c.notches.size, 0);
});

test("switching one EQ band off zeroes its gain and leaves the channel EQ switch alone", () => {
  const c = new Capture();
  c.setEqBand(4, 2, 1000, 6, 2, false);
  assert.deepEqual(c.sent.map((m) => m.addr), ["/ch/04/eq/2/g", "/ch/04/eq/2/type", "/ch/04/eq/2/f", "/ch/04/eq/2/q"]);
  close(c.sent[0]!.args[0]!.v as number, 0.5, 0, 1e-12);
  const s = new SimConsole();
  s.setEqBand(4, 2, 1000, 6, 2, false);
  assert.deepEqual(s.eqBands.get(4)!.get(2), { hz: 1000, gainDb: 0, q: 2, on: false });
  c.sent.length = 0;
  c.setEqBand(4, 2, 1000, 6, 2, true);
  assert.equal(c.sent.at(-1)!.addr, "/ch/04/eq/on");
});

test("the simulator's wire log keeps only the latest 5000 messages", () => {
  const c = new SimConsole();
  for (let i = 0; i < 5200; i++) c.setFaderDb(1, (i % 10) - 5);
  assert.equal(c.wireLog.length, 5000);
  c.setMainMute(true);
  assert.equal(c.wireLog.length, 5000);
  assert.equal(c.wireLog.at(-1)![0], "/main/st/mix/on");
});

test("the show clock reads OSC arguments as plain text and survives a handler that throws", async () => {
  let handler: ((data: Uint8Array, from: { host: string; port: number }) => void) | null = null;
  const factory = {
    bind: (): Promise<UdpEndpoint> =>
      Promise.resolve({
        port: 1,
        send: () => {},
        onMessage: (h) => {
          handler = h;
        },
        close: () => {},
      }),
  };
  const seen: string[] = [];
  let boom = false;
  const rx = new AbleSetReceiver(factory, (st) => {
    seen.push(st.songName);
    if (boom) throw new Error("listener failed");
  });
  await rx.start();
  const feed = (addr: string, ...args: OscArg[]): void => handler!(encodeMessage(addr, args), { host: "x", port: 1 });
  feed("/setlist/activeSongName", oscFloat(120));
  feed("/setlist/activeSongName", oscBlob(new TextEncoder().encode("Café Song")));
  feed("/setlist/activeSongName", oscInt(7));
  assert.deepEqual(seen, ["120", "Café Song", "7"]);
  boom = true;
  assert.doesNotThrow(() => feed("/setlist/activeSongName", oscStr("Other")));
  assert.doesNotThrow(() => handler!(Uint8Array.of(1, 2, 3), { host: "x", port: 1 }));
});

const crashDatagram = (): Uint8Array => unhex("2ff7bfbfbf0000002c000000");

test("a datagram with a lead byte beyond U+10FFFF decodes without throwing", () => {
  assert.doesNotThrow(() => decodeMessage(crashDatagram()));
  assert.doesNotThrow(() => decodePacket(crashDatagram()));
  const m = decodeMessage(crashDatagram());
  assert.ok(m);
  assert.equal(m.address, "/����");
});

test("utf8Decode replaces overlongs, surrogates, stray continuations and truncation with U+FFFD", () => {
  assert.equal(utf8Decode(unhex("c080")), "��");
  assert.equal(utf8Decode(unhex("eda080")), "���");
  assert.equal(utf8Decode(unhex("f4908080")), "����");
  assert.equal(utf8Decode(unhex("41e282")), "A��");
  assert.equal(utf8Decode(unhex("e2 41 42".replaceAll(" ", ""))), "�AB");
  assert.equal(utf8Decode(unhex("80")), "�");
  assert.equal(utf8Decode(utf8Encode("aé€\u{1f3a4}z")), "aé€\u{1f3a4}z");
});

test("random bytes never make the decoders throw", () => {
  let seed = 12345;
  const next = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let n = 0; n < 10000; n++) {
    const len = next() % 80;
    const b = new Uint8Array(len);
    for (let i = 0; i < len; i++) b[i] = next() & 255;
    if (n % 3 === 0 && len > 4) b[0] = 0x2f;
    if (n % 7 === 0 && len > 12) b.set(Buffer.from("#bundle\0"), 0);
    assert.doesNotThrow(() => decodeMessage(b));
    assert.doesNotThrow(() => decodeReply(b));
    assert.doesNotThrow(() => decodePacket(b));
  }
});

test("deeply nested bundles are cut off instead of overflowing the stack", () => {
  let inner: Uint8Array = encodeMessage("/a", [oscInt(1)]);
  for (let d = 0; d < 3000; d++) {
    const head = new Uint8Array([...Buffer.from("#bundle\0"), 0, 0, 0, 0, 0, 0, 0, 1]);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setInt32(0, inner.length, false);
    inner = new Uint8Array([...head, ...len, ...inner]);
    if (inner.length > 60000) break;
  }
  assert.doesNotThrow(() => decodePacket(inner));
});

test("an address followed by a truncated type-tag string is rejected, not read as a GET", () => {
  const addr = new Uint8Array(20);
  addr.set(Buffer.from("/ch/03/mix/fader"), 0);
  const truncated = new Uint8Array([...addr, 0x2c, 0x66]);
  assert.equal(decodeMessage(truncated), null);
  assert.equal(decodeMessage(new Uint8Array([...addr, 0x2c, 0x66, 0x00, 0x00])), null);
  assert.deepEqual(decodeMessage(addr), { address: "/ch/03/mix/fader", args: [] });
});

test("decodeReply accepts the desk's bare node address and decodeMessage does not", () => {
  const body = new Uint8Array([...Buffer.from("node\0\0\0\0,s\0\0"), ...Buffer.from("hi\0\0")]);
  assert.equal(decodeMessage(body), null);
  assert.deepEqual(decodeReply(body), { address: "node", args: [{ t: "s", v: "hi" }] });
  assert.equal(decodeReply(unhex("6e6f6465")), null);
  assert.equal(decodeReply(unhex("6e6f7065000000002c000000")), null);
  assert.deepEqual(decodeReply(encodeMessage("/a", [oscInt(1)]))?.address, "/a");
});

test("recallScene accepts only integers 0 to 99 and sends nothing otherwise", () => {
  const c = new Capture();
  for (const bad of [-1, 100, 1.5, NaN, Infinity, 1e9]) assert.throws(() => c.recallScene(bad), RangeError);
  assert.equal(c.sent.length, 0);
  c.recallScene(0);
  c.recallScene(99);
  assert.equal(c.sent.length, 2);
  const s = new SimConsole();
  assert.throws(() => s.recallScene(100), RangeError);
  assert.equal(s.lastScene, null);
});

test("rampFaderDb refuses a non-finite duration without ramping", async () => {
  const c = new Capture({ clock: new ManualClock() });
  assert.throws(() => c.rampFaderDb(1, -10, -4, NaN, 6), RangeError);
  assert.throws(() => c.rampFaderDb(1, -10, -4, 350, NaN), RangeError);
  await c.flushRamps();
  assert.equal(c.sent.length, 0);
});

test("EQ gain on the wire is clamped to the 0 to 1 range", () => {
  const c = new Capture();
  c.setEqBand(1, 1, 1000, 40, 2);
  c.setEqBand(1, 2, 1000, -40, 2);
  const gains = c.sent.filter((m) => m.addr.endsWith("/g")).map((m) => m.args[0]!.v as number);
  assert.deepEqual(gains, [1, 0]);
});

test("a ramp error is reported through the onError hook", async () => {
  class Flaky extends Capture {
    protected override send(): void {
      throw new Error("socket closed");
    }
  }
  const c = new Flaky({ clock: new ManualClock() });
  const seen: unknown[] = [];
  c.onError = (e) => seen.push(e);
  c.rampFaderDb(1, -10, -4, 350, 3);
  await c.flushRamps();
  assert.equal(seen.length, 1);
});
