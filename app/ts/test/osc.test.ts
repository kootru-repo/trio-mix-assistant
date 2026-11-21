import assert from "node:assert/strict";
import test from "node:test";
import { ManualClock } from "../src/core/clock.ts";
import { ConsoleBase, dbToFader, eqParamToFreq, faderToDb, freqToEqParam, qToParam, SimConsole } from "../src/core/console.ts";
import {
  decodeMessage,
  decodeMeterBlob,
  decodePacket,
  encodeMeterBlob,
  encodeMessage,
  oscBlob,
  oscFloat,
  oscInt,
  oscStr,
} from "../src/core/oscwire.ts";
import type { OscArg } from "../src/core/oscwire.ts";
import { close, fixture } from "./helpers.ts";

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

test("scaling helpers match the recorded reference", () => {
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
