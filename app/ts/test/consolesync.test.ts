import assert from "node:assert/strict";
import test from "node:test";
import { dbToFader } from "../src/core/console.ts";
import { ConsoleSync } from "../src/core/consolesync.ts";
import type { SyncValues } from "../src/core/consolesync.ts";
import { oscFloat, oscInt, oscStr } from "../src/core/oscwire.ts";
import type { OscArg } from "../src/core/oscwire.ts";

interface Rig {
  sync: ConsoleSync;
  sent: string[];
}

const rig = (channels: readonly number[], retryS = 0.5, tries = 3): Rig => {
  const sent: string[] = [];
  const sync = new ConsoleSync({ channels, send: (a) => sent.push(a), retryS, tries });
  return { sync, sent };
};

const addrs = (ch: number): string[] => {
  const two = String(ch).padStart(2, "0");
  const three = String(ch - 1).padStart(3, "0");
  return [`/ch/${two}/mix/fader`, `/headamp/${three}/gain`, `/ch/${two}/preamp/invert`];
};

const empty: SyncValues = { faderDb: null, gainDb: null, inverted: null };

const answerAll = (sync: ConsoleSync, ch: number): void => {
  const [f, g, i] = addrs(ch);
  assert.equal(sync.handle(f!, [oscFloat(0.75)]), true);
  assert.equal(sync.handle(g!, [oscFloat(32 / 72)]), true);
  assert.equal(sync.handle(i!, [oscInt(0)]), true);
};

test("poll reports idle and nothing is active before begin", () => {
  const { sync, sent } = rig([1]);
  assert.equal(sync.poll(100), "idle");
  assert.equal(sync.active, false);
  assert.equal(sync.handle("/ch/01/mix/fader", [oscFloat(0.5)]), false);
  assert.deepEqual(sent, []);
  assert.deepEqual(sync.missing(), []);
  assert.deepEqual([...sync.result()], [[1, empty]]);
});

test("begin sends fader, gain and invert reads per channel in channel order with zero padding", () => {
  const { sync, sent } = rig([1, 9, 10, 32]);
  sync.begin(0);
  assert.deepEqual(sent, [
    "/ch/01/mix/fader",
    "/headamp/000/gain",
    "/ch/01/preamp/invert",
    "/ch/09/mix/fader",
    "/headamp/008/gain",
    "/ch/09/preamp/invert",
    "/ch/10/mix/fader",
    "/headamp/009/gain",
    "/ch/10/preamp/invert",
    "/ch/32/mix/fader",
    "/headamp/031/gain",
    "/ch/32/preamp/invert",
  ]);
  assert.equal(sync.active, true);
  assert.equal(sync.poll(0), "pending");
  assert.deepEqual(sync.missing(), sent);
});

test("fader and gain replies convert to decibels at known points", () => {
  const { sync } = rig([1, 2]);
  sync.begin(0);
  assert.equal(sync.handle("/ch/01/mix/fader", [oscFloat(0.75)]), true);
  assert.equal(sync.handle("/ch/02/mix/fader", [oscFloat(0)]), true);
  assert.equal(sync.handle("/headamp/000/gain", [oscFloat((20 + 12) / 72)]), true);
  assert.equal(sync.handle("/headamp/001/gain", [oscFloat(0)]), true);
  assert.equal(sync.handle("/ch/01/preamp/invert", [oscInt(1)]), true);
  assert.equal(sync.handle("/ch/02/preamp/invert", [oscInt(0)]), true);
  const r = sync.result();
  assert.equal(r.get(1)!.faderDb, 0);
  assert.equal(r.get(2)!.faderDb, -90);
  assert.ok(Math.abs(r.get(1)!.gainDb! - 20) < 1e-9);
  assert.equal(r.get(2)!.gainDb, -12);
  assert.equal(r.get(1)!.inverted, true);
  assert.equal(r.get(2)!.inverted, false);
});

test("fader and gain accept the inclusive range ends", () => {
  const { sync } = rig([1]);
  sync.begin(0);
  assert.equal(sync.handle("/ch/01/mix/fader", [oscFloat(1)]), true);
  assert.equal(sync.handle("/headamp/000/gain", [oscFloat(1)]), true);
  assert.equal(sync.result().get(1)!.faderDb, 10);
  assert.equal(sync.result().get(1)!.gainDb, 60);
});

test("a fader reply round trips a decibel value written by the app", () => {
  const { sync } = rig([5]);
  sync.begin(0);
  sync.handle("/ch/05/mix/fader", [oscFloat(dbToFader(-20))]);
  assert.ok(Math.abs(sync.result().get(5)!.faderDb! + 20) < 1e-9);
});

const invalidFloats: [string, OscArg[]][] = [
  ["NaN", [oscFloat(Number.NaN)]],
  ["Infinity", [oscFloat(Number.POSITIVE_INFINITY)]],
  ["negative infinity", [oscFloat(Number.NEGATIVE_INFINITY)]],
  ["below zero", [oscFloat(-0.01)]],
  ["above one", [oscFloat(1.01)]],
  ["an int", [oscInt(0)]],
  ["a string", [oscStr("0.5")]],
  ["no argument", []],
];

for (const [label, args] of invalidFloats) {
  test(`a fader or gain reply with ${label} is not stored and stays missing`, () => {
    const { sync } = rig([1]);
    sync.begin(0);
    assert.equal(sync.handle("/ch/01/mix/fader", args), false);
    assert.equal(sync.handle("/headamp/000/gain", args), false);
    assert.deepEqual(sync.result().get(1), empty);
    assert.deepEqual(sync.missing(), addrs(1));
    assert.equal(sync.active, true);
  });
}

const invalidFlags: [string, OscArg[]][] = [
  ["2", [oscInt(2)]],
  ["-1", [oscInt(-1)]],
  ["a float 1", [oscFloat(1)]],
  ["a float 0", [oscFloat(0)]],
  ["a string", [oscStr("1")]],
  ["no argument", []],
];

for (const [label, args] of invalidFlags) {
  test(`an invert reply with ${label} is not stored and stays missing`, () => {
    const { sync } = rig([1]);
    sync.begin(0);
    assert.equal(sync.handle("/ch/01/preamp/invert", args), false);
    assert.equal(sync.result().get(1)!.inverted, null);
    assert.ok(sync.missing().includes("/ch/01/preamp/invert"));
  });
}

test("a rejected reply can be followed by a valid one on the same address", () => {
  const { sync } = rig([1]);
  sync.begin(0);
  assert.equal(sync.handle("/ch/01/mix/fader", [oscFloat(2)]), false);
  assert.equal(sync.handle("/ch/01/mix/fader", [oscFloat(0.75)]), true);
  assert.equal(sync.result().get(1)!.faderDb, 0);
});

test("replies for addresses it did not ask for are ignored", () => {
  const { sync } = rig([1]);
  sync.begin(0);
  assert.equal(sync.handle("/ch/02/mix/fader", [oscFloat(0.5)]), false);
  assert.equal(sync.handle("/headamp/001/gain", [oscFloat(0.5)]), false);
  assert.equal(sync.handle("/main/st/mix/fader", [oscFloat(0.5)]), false);
  assert.equal(sync.handle("/ch/01/mix/on", [oscInt(1)]), false);
  assert.deepEqual(sync.missing(), addrs(1));
});

test("a duplicate reply is ignored and does not overwrite the first", () => {
  const { sync } = rig([1]);
  sync.begin(0);
  assert.equal(sync.handle("/ch/01/mix/fader", [oscFloat(0.75)]), true);
  assert.equal(sync.handle("/ch/01/mix/fader", [oscFloat(0)]), false);
  assert.equal(sync.result().get(1)!.faderDb, 0);
});

test("retries resend only missing addresses exactly when retryS has passed", () => {
  const { sync, sent } = rig([1, 2], 0.5, 3);
  sync.begin(10);
  answerAll(sync, 1);
  sync.handle("/ch/02/mix/fader", [oscFloat(0.75)]);
  sent.length = 0;
  assert.equal(sync.poll(10.49), "pending");
  assert.deepEqual(sent, []);
  assert.equal(sync.poll(10.5), "pending");
  assert.deepEqual(sent, ["/headamp/001/gain", "/ch/02/preamp/invert"]);
  sent.length = 0;
  assert.equal(sync.poll(10.75), "pending");
  assert.deepEqual(sent, []);
  sync.handle("/headamp/001/gain", [oscFloat(0.5)]);
  assert.equal(sync.poll(11), "pending");
  assert.deepEqual(sent, ["/ch/02/preamp/invert"]);
});

test("the retry clock restarts from the poll that resent, not from begin", () => {
  const { sync, sent } = rig([1], 0.5, 3);
  sync.begin(0);
  sent.length = 0;
  assert.equal(sync.poll(0.7), "pending");
  assert.equal(sent.length, 3);
  assert.equal(sync.poll(1.0), "pending");
  assert.equal(sent.length, 3);
  assert.equal(sync.poll(1.2), "pending");
  assert.equal(sent.length, 6);
});

test("sync is done as soon as every address is answered, before any retry", () => {
  const { sync, sent } = rig([1, 2]);
  sync.begin(0);
  answerAll(sync, 1);
  assert.equal(sync.active, true);
  answerAll(sync, 2);
  assert.equal(sync.active, false);
  assert.equal(sync.poll(0), "done");
  assert.equal(sync.poll(100), "done");
  assert.equal(sent.length, 6);
  assert.deepEqual(sync.missing(), []);
});

test("sync is done after the last retry window when faders answered but gain and invert did not", () => {
  const { sync, sent } = rig([1, 2], 0.5, 3);
  sync.begin(0);
  sync.handle("/ch/01/mix/fader", [oscFloat(0.75)]);
  sync.handle("/ch/02/mix/fader", [oscFloat(0.5)]);
  assert.equal(sync.poll(0.5), "pending");
  assert.equal(sync.poll(1.0), "pending");
  assert.equal(sent.length, 6 + 4 + 4);
  assert.equal(sync.poll(1.49), "pending");
  assert.equal(sync.active, true);
  assert.equal(sync.poll(1.5), "done");
  assert.equal(sent.length, 14);
  assert.equal(sync.active, false);
  assert.deepEqual(sync.missing(), ["/headamp/000/gain", "/ch/01/preamp/invert", "/headamp/001/gain", "/ch/02/preamp/invert"]);
  assert.deepEqual(sync.result().get(1), { faderDb: 0, gainDb: null, inverted: null });
  assert.deepEqual(sync.result().get(2), { faderDb: -10, gainDb: null, inverted: null });
});

test("sync fails after the last retry window when a fader is still missing", () => {
  const { sync, sent } = rig([1, 2], 0.5, 3);
  sync.begin(0);
  answerAll(sync, 1);
  sync.handle("/headamp/001/gain", [oscFloat(0.5)]);
  sync.handle("/ch/02/preamp/invert", [oscInt(1)]);
  assert.equal(sync.poll(0.5), "pending");
  assert.equal(sync.poll(1.0), "pending");
  assert.equal(sync.poll(1.5), "failed");
  assert.deepEqual(sent.slice(6), ["/ch/02/mix/fader", "/ch/02/mix/fader"]);
  assert.equal(sync.active, false);
  assert.equal(sync.poll(99), "failed");
  assert.deepEqual(sync.missing(), ["/ch/02/mix/fader"]);
  assert.deepEqual(sync.result().get(2), { faderDb: null, gainDb: 24, inverted: true });
});

test("a single try fails one retry window after begin with no resend", () => {
  const { sync, sent } = rig([3], 2, 1);
  sync.begin(5);
  assert.equal(sync.poll(6.99), "pending");
  assert.equal(sync.poll(7), "failed");
  assert.equal(sent.length, 3);
});

test("nothing is handled after the sync finished", () => {
  const { sync } = rig([1], 0.5, 1);
  sync.begin(0);
  assert.equal(sync.poll(0.5), "failed");
  assert.equal(sync.handle("/ch/01/mix/fader", [oscFloat(0.75)]), false);
  assert.deepEqual(sync.result().get(1), empty);
});

test("begin again clears earlier answers and restarts the tries", () => {
  const { sync, sent } = rig([1], 0.5, 2);
  sync.begin(0);
  answerAll(sync, 1);
  assert.equal(sync.poll(0), "done");
  sent.length = 0;
  sync.begin(10);
  assert.equal(sync.active, true);
  assert.equal(sync.poll(10), "pending");
  assert.deepEqual(sent, addrs(1));
  assert.deepEqual(sync.result().get(1), empty);
  assert.deepEqual(sync.missing(), addrs(1));
  assert.equal(sync.poll(10.5), "pending");
  assert.equal(sent.length, 6);
  assert.equal(sync.poll(11), "failed");
});

test("result has one entry per channel and never invents defaults", () => {
  const { sync } = rig([4, 7]);
  sync.begin(0);
  sync.handle("/headamp/003/gain", [oscFloat(0.5)]);
  const r = sync.result();
  assert.deepEqual([...r.keys()], [4, 7]);
  assert.deepEqual(r.get(4), { faderDb: null, gainDb: 24, inverted: null });
  assert.deepEqual(r.get(7), empty);
});

test("result returns copies that callers cannot use to change stored values", () => {
  const { sync } = rig([1]);
  sync.begin(0);
  sync.handle("/ch/01/mix/fader", [oscFloat(0.75)]);
  sync.result().get(1)!.faderDb = 5;
  assert.equal(sync.result().get(1)!.faderDb, 0);
});

test("an empty channel list is done at begin without sending anything", () => {
  const { sync, sent } = rig([], 0.5, 3);
  sync.begin(0);
  assert.deepEqual(sent, []);
  assert.equal(sync.active, false);
  assert.equal(sync.poll(0), "done");
  assert.equal(sync.result().size, 0);
});

test("a poll at a time that is not a finite number is ignored and later retries keep their timing", () => {
  const { sync, sent } = rig([1], 0.5, 3);
  sync.begin(10);
  sent.length = 0;
  for (const t of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) assert.equal(sync.poll(t), "pending");
  assert.deepEqual(sent, []);
  assert.equal(sync.poll(10.25), "pending");
  assert.deepEqual(sent, []);
  assert.equal(sync.poll(10.5), "pending");
  assert.equal(sent.length, 3);
  assert.equal(sync.poll(Number.NaN), "pending");
  assert.equal(sync.poll(11), "pending");
  assert.equal(sent.length, 6);
  assert.equal(sync.poll(11.5), "failed");
});
