import assert from "node:assert/strict";
import test from "node:test";
import { MemNetwork } from "../src/core/memtransport.ts";
import type { Peer, UdpEndpoint } from "../src/core/transport.ts";

type Got = { data: number[]; from: number };

async function pair() {
  const net = new MemNetwork();
  const a = await net.bind(0, "127.0.0.1");
  const b = await net.bind(0, "127.0.0.1");
  const gotA: Got[] = [];
  const gotB: Got[] = [];
  a.onMessage((data, from) => gotA.push({ data: [...data], from: from.port }));
  b.onMessage((data, from) => gotB.push({ data: [...data], from: from.port }));
  const to = (ep: UdpEndpoint): Peer => ({ host: "127.0.0.1", port: ep.port });
  return { net, a, b, gotA, gotB, to };
}

test("datagrams are delivered in both directions when no filter is set", async () => {
  const r = await pair();
  assert.equal(r.net.filter, null);
  r.a.send(Uint8Array.of(1, 2), r.to(r.b));
  r.b.send(Uint8Array.of(3), r.to(r.a));
  await r.net.settle();
  assert.deepEqual(r.gotB, [{ data: [1, 2], from: r.a.port }]);
  assert.deepEqual(r.gotA, [{ data: [3], from: r.b.port }]);
});

test("a filter can drop one direction while the other still arrives", async () => {
  const r = await pair();
  r.net.filter = (from, to) => !(from.port === r.a.port && to.port === r.b.port);
  r.a.send(Uint8Array.of(1), r.to(r.b));
  r.b.send(Uint8Array.of(2), r.to(r.a));
  await r.net.settle();
  assert.deepEqual(r.gotB, []);
  assert.deepEqual(r.gotA, [{ data: [2], from: r.b.port }]);
});

test("the filter sees the sender, the target and the payload", async () => {
  const r = await pair();
  const seen: [number, number, number[]][] = [];
  r.net.filter = (from, to, data) => {
    seen.push([from.port, to.port, [...data]]);
    return true;
  };
  r.a.send(Uint8Array.of(7, 8), r.to(r.b));
  await r.net.settle();
  assert.deepEqual(seen, [[r.a.port, r.b.port, [7, 8]]]);
  assert.deepEqual(r.gotB, [{ data: [7, 8], from: r.a.port }]);
});

test("a partition drops everything and clearing the filter heals it", async () => {
  const r = await pair();
  r.net.filter = () => false;
  r.a.send(Uint8Array.of(1), r.to(r.b));
  r.b.send(Uint8Array.of(2), r.to(r.a));
  await r.net.settle();
  assert.deepEqual(r.gotA, []);
  assert.deepEqual(r.gotB, []);
  r.net.filter = null;
  r.a.send(Uint8Array.of(3), r.to(r.b));
  r.b.send(Uint8Array.of(4), r.to(r.a));
  await r.net.settle();
  assert.deepEqual(r.gotB, [{ data: [3], from: r.a.port }]);
  assert.deepEqual(r.gotA, [{ data: [4], from: r.b.port }]);
});

test("dropped datagrams are never delivered later", async () => {
  const r = await pair();
  r.net.filter = () => false;
  for (let i = 0; i < 5; i++) r.a.send(Uint8Array.of(i), r.to(r.b));
  r.net.filter = null;
  await r.net.settle();
  await new Promise((done) => setTimeout(done, 20));
  await r.net.settle();
  assert.deepEqual(r.gotB, []);
  r.a.send(Uint8Array.of(9), r.to(r.b));
  await r.net.settle();
  assert.deepEqual(r.gotB, [{ data: [9], from: r.a.port }]);
});

test("a dropping filter does not throw at the sender", async () => {
  const r = await pair();
  r.net.filter = () => false;
  assert.doesNotThrow(() => r.a.send(Uint8Array.of(1), r.to(r.b)));
  await r.net.settle();
  assert.deepEqual(r.gotB, []);
});
