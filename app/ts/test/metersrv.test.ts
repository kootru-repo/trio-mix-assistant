import assert from "node:assert/strict";
import test from "node:test";
import { MemNetwork } from "../src/core/memtransport.ts";
import { chFromFaderAddr, decodeMeterBlob, encodeMeterBlob, MeterReceiver } from "../src/core/metersrv.ts";
import { dbToFader, faderToDb } from "../src/core/console.ts";
import { encodeMessage, oscBlob, oscFloat, oscInt, oscStr } from "../src/core/oscwire.ts";
import type { OscArg } from "../src/core/oscwire.ts";
import { NodeUdpFactory } from "../src/host/udp.ts";

function bundle(messages: Uint8Array[]): Uint8Array {
  const parts: number[] = [];
  for (const c of "#bundle") parts.push(c.charCodeAt(0));
  parts.push(0, 0, 0, 0, 0, 0, 0, 0, 1);
  for (const m of messages) {
    parts.push((m.length >>> 24) & 255, (m.length >>> 16) & 255, (m.length >>> 8) & 255, m.length & 255);
    parts.push(...m);
  }
  return Uint8Array.from(parts);
}

function rig() {
  const faders: [number, number][] = [];
  const meters: number[][] = [];
  const net = new MemNetwork();
  const rx = new MeterReceiver(net, {
    onFader: (ch, db) => faders.push([ch, db]),
    onMeters: (v) => meters.push(v),
    port: 0,
  });
  return { faders, meters, net, rx };
}

function msg(addr: string, ...args: OscArg[]): Uint8Array {
  return encodeMessage(addr, args);
}

test("decode of a zero-count blob is empty", () => {
  const b = new Uint8Array(4);
  assert.deepEqual(decodeMeterBlob(b), []);
});

test("meter blob layout and round trip", () => {
  const blob = encodeMeterBlob([0.5, 0.25, -1.0]);
  const want = new Uint8Array(16);
  const dv = new DataView(want.buffer);
  dv.setInt32(0, 3, true);
  [0.5, 0.25, -1.0].forEach((v, i) => dv.setFloat32(4 + i * 4, v, true));
  assert.deepEqual(blob, want);
  assert.deepEqual(decodeMeterBlob(blob), [0.5, 0.25, -1.0]);
});

test("chFromFaderAddr parses only fader addresses", () => {
  assert.equal(chFromFaderAddr("/ch/01/mix/fader"), 1);
  assert.equal(chFromFaderAddr("/ch/12/mix/fader"), 12);
  assert.equal(chFromFaderAddr("/ch/zz/mix/fader"), null);
  assert.equal(chFromFaderAddr("/ch/01/mix/on"), null);
  assert.equal(chFromFaderAddr("/bus/01/mix/fader"), null);
  assert.equal(chFromFaderAddr("/ch/01/mix"), null);
});

test("handlers are no-ops while not running", () => {
  const { faders, meters, rx } = rig();
  rx.running = false;
  rx.handleMeters("/meters/1", [oscBlob(new Uint8Array(4))]);
  rx.handleFader("/ch/01/mix/fader", [oscFloat(0.5)]);
  assert.deepEqual(faders, []);
  assert.deepEqual(meters, []);
});

test("handleFader ignores bad address, missing and non-numeric args", () => {
  const { faders, rx } = rig();
  rx.running = true;
  rx.handleFader("/ch/zz/mix/fader", [oscFloat(0.5)]);
  rx.handleFader("/ch/01/mix/fader", []);
  rx.handleFader("/ch/01/mix/fader", [oscStr("loud")]);
  assert.deepEqual(faders, []);
  rx.handleFader("/ch/02/mix/fader", [oscInt(1)]);
  rx.handleFader("/ch/03/mix/fader", [oscStr("0.5")]);
  assert.deepEqual(faders, [
    [2, faderToDb(1)],
    [3, faderToDb(0.5)],
  ]);
});

test("handleMeters only accepts a blob first argument", () => {
  const { meters, rx } = rig();
  rx.running = true;
  rx.handleMeters("/meters/1", []);
  rx.handleMeters("/meters/1", [oscFloat(1)]);
  assert.deepEqual(meters, []);
  rx.handleMeters("/meters/1", [oscBlob(encodeMeterBlob([0.5, 0.25]))]);
  assert.deepEqual(meters, [[0.5, 0.25]]);
});

test("dispatch routes by pattern like the python dispatcher", async () => {
  const { faders, meters, net, rx } = rig();
  await rx.start();
  rx.dispatch(msg("/meters/1", oscBlob(encodeMeterBlob([0.5]))));
  rx.dispatch(msg("/meters", oscBlob(encodeMeterBlob([0.25]))));
  rx.dispatch(msg("/metersX", oscBlob(encodeMeterBlob([0.125]))));
  rx.dispatch(msg("/ch/01/mix/fader", oscFloat(0.75)));
  rx.dispatch(msg("/ch/02/mix/fader", oscFloat(0.5)));
  rx.dispatch(msg("/ch/03/mix/on", oscInt(0)));
  rx.dispatch(msg("/other/thing", oscFloat(0.5)));
  rx.dispatch(msg("/ch/*/mix/fader", oscFloat(0.5)));
  rx.dispatch(Uint8Array.from([1, 2, 3]));
  await net.settle();
  assert.deepEqual(meters, [[0.5], [0.25], [0.125]]);
  assert.deepEqual(faders, [
    [1, faderToDb(0.75)],
    [2, faderToDb(0.5)],
  ]);
  rx.stop();
});

test("bundles are unpacked and every message handled", async () => {
  const { faders, meters, rx } = rig();
  await rx.start();
  rx.dispatch(
    bundle([
      msg("/ch/04/mix/fader", oscFloat(dbToFader(-5))),
      msg("/meters/1", oscBlob(encodeMeterBlob([0.1, 0.2]))),
      bundle([msg("/ch/05/mix/fader", oscFloat(0.0))]),
    ]),
  );
  assert.equal(faders.length, 2);
  assert.equal(faders[0]![0], 4);
  assert.ok(Math.abs(faders[0]![1] - -5) < 1e-3);
  assert.equal(faders[1]![0], 5);
  assert.equal(meters.length, 1);
  assert.equal(meters[0]!.length, 2);
  rx.stop();
});

test("start binds, receives datagrams, and stop closes and silences", async () => {
  const { faders, net, rx } = rig();
  await rx.start();
  assert.ok(rx.port >= 49152);
  const sender = await net.bind(0, "127.0.0.1");
  sender.send(msg("/ch/07/mix/fader", oscFloat(0.75)), { host: "127.0.0.1", port: rx.port });
  await net.settle();
  assert.equal(faders.length, 1);
  assert.equal(faders[0]![0], 7);
  assert.ok(Math.abs(faders[0]![1]) < 1e-3);
  const port = rx.port;
  rx.stop();
  assert.equal(rx.running, false);
  sender.send(msg("/ch/07/mix/fader", oscFloat(0.75)), { host: "127.0.0.1", port });
  await net.settle();
  assert.equal(faders.length, 1);
  rx.stop();
  const again = await net.bind(port, "127.0.0.1");
  again.close();
});

test("a second receiver on the same port fails to bind", async () => {
  const net = new MemNetwork();
  const a = new MeterReceiver(net, { port: 0 });
  await a.start();
  const b = new MeterReceiver(net, { port: a.port });
  await assert.rejects(b.start());
  a.stop();
});

test("receiver works over a real UDP socket", async () => {
  const udp = new NodeUdpFactory();
  const got: [number, number][] = [];
  const meters: number[][] = [];
  const rx = new MeterReceiver(udp, {
    ip: "127.0.0.1",
    port: 0,
    onFader: (ch, db) => got.push([ch, db]),
    onMeters: (v) => meters.push(v),
  });
  await rx.start();
  const sender = await udp.bind(0, "127.0.0.1");
  try {
    sender.send(msg("/ch/09/mix/fader", oscFloat(0.5)), { host: "127.0.0.1", port: rx.port });
    sender.send(msg("/meters/1", oscBlob(encodeMeterBlob([0.5, 0.25]))), { host: "127.0.0.1", port: rx.port });
    for (let i = 0; i < 100 && (got.length < 1 || meters.length < 1); i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(got, [[9, faderToDb(0.5)]]);
    assert.deepEqual(meters, [[0.5, 0.25]]);
  } finally {
    sender.close();
    rx.stop();
  }
});
