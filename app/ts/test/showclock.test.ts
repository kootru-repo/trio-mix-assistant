import assert from "node:assert/strict";
import test from "node:test";
import { MemNetwork } from "../src/core/memtransport.ts";
import { encodeMessage, oscStr } from "../src/core/oscwire.ts";
import { AbleSetReceiver, SimShowClock } from "../src/core/showclock.ts";
import { fromObject } from "../src/core/template.ts";
import type { ShowState } from "../src/core/showclock.ts";
import { StepClock } from "./stepclock.ts";

test("a start that is stopped before it binds leaves the port free and the receiver stopped", async () => {
  const net = new MemNetwork();
  const rx = new AbleSetReceiver(net, null, "127.0.0.1", 50210);
  const p = rx.start();
  rx.stop();
  await p;
  const probe = await net.bind(50210, "127.0.0.1");
  probe.close();
  const seen: string[] = [];
  const rx2 = new AbleSetReceiver(net, (s) => seen.push(s.songName), "127.0.0.1", 50210);
  await rx2.start();
  rx2.stop();
  rx2.handle("/setlist/activeSongName", [oscStr("Late")]);
  assert.deepEqual(seen, []);
});

test("starting twice binds once and the last start wins", async () => {
  const net = new MemNetwork();
  const seen: string[] = [];
  const rx = new AbleSetReceiver(net, (s) => seen.push(s.songName), "127.0.0.1", 50211);
  const a = rx.start();
  const b = rx.start();
  await Promise.all([a, b]);
  const sender = await net.bind(0, "127.0.0.1");
  sender.send(encodeMessage("/setlist/activeSongName", [oscStr("One")]), { host: "127.0.0.1", port: 50211 });
  await net.settle();
  assert.deepEqual(seen, ["One"]);
  rx.stop();
  sender.close();
  const probe = await net.bind(50211, "127.0.0.1");
  probe.close();
});

test("restarting the simulated show clock does not double its loop", async () => {
  const clock = new StepClock(0, 0);
  const template = fromObject({ songs: [{ name: "A" }, { name: "B" }, { name: "C" }] });
  const states: ShowState[] = [];
  const sc = new SimShowClock(template, clock, (s) => states.push(s), 1.0);
  await sc.start();
  sc.stop();
  await sc.start();
  states.length = 0;
  await clock.advance(5.0);
  sc.stop();
  assert.ok(states.length <= 5, String(states.length));
  await clock.advance(5.0);
  assert.ok(states.length <= 5, String(states.length));
});
