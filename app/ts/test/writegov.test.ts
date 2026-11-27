import assert from "node:assert/strict";
import test from "node:test";
import { type OscArg, oscBlob, oscFloat, oscInt, oscStr } from "../src/core/oscwire.ts";
import { type GovernorOptions, sameArgs, WriteGovernor } from "../src/core/writegov.ts";

interface Sent {
  address: string;
  args: readonly OscArg[];
}

const SMALL: GovernorOptions = { manualPerS: 2, manualBurst: 2, autoPerS: 4, autoBurst: 3, totalPerS: 5, repeatS: 1, stormS: 2 };

function rig(opts: Partial<GovernorOptions> = {}): { gov: WriteGovernor; out: Sent[] } {
  const out: Sent[] = [];
  const gov = new WriteGovernor({ ...SMALL, ...opts }, (address, args) => out.push({ address, args }));
  return { gov, out };
}

const f = (v: number): OscArg[] => [oscFloat(v)];
const addrs = (out: Sent[]): string[] => out.map((s) => s.address);

test("a manual lane sends its burst at once and queues the rest", () => {
  const { gov, out } = rig();
  for (let i = 0; i < 4; i++) gov.submit("manual", `/m/${i}`, f(i), 0);
  assert.deepEqual(addrs(out), ["/m/0", "/m/1"]);
  assert.equal(gov.backlog(), 2);
  assert.equal(gov.backlog("manual"), 2);
  assert.equal(gov.backlog("auto"), 0);
  assert.deepEqual(gov.stats(), { sent: 2, merged: 0, skipped: 0, queued: 2 });
});

test("the manual lane refills at its rate at exact times", () => {
  const { gov, out } = rig();
  for (let i = 0; i < 5; i++) gov.submit("manual", `/m/${i}`, f(i), 0);
  gov.pump(0.25);
  assert.equal(out.length, 2);
  gov.pump(0.5);
  assert.equal(out.length, 3);
  gov.pump(1);
  assert.equal(out.length, 4);
  gov.pump(1.5);
  assert.deepEqual(addrs(out), ["/m/0", "/m/1", "/m/2", "/m/3", "/m/4"]);
  assert.equal(gov.backlog(), 0);
});

test("a lane bucket never fills beyond its burst after a long idle time", () => {
  const { gov, out } = rig();
  gov.submit("manual", "/a", f(0), 0);
  gov.pump(1000);
  for (let i = 0; i < 4; i++) gov.submit("manual", `/m/${i}`, f(i), 1000);
  assert.equal(out.length, 3);
});

test("the total bucket limits manual and auto together", () => {
  const { gov, out } = rig({ manualBurst: 5, autoBurst: 5, totalPerS: 4 });
  for (let i = 0; i < 3; i++) gov.submit("manual", `/m/${i}`, f(i), 0);
  for (let i = 0; i < 3; i++) gov.submit("auto", `/a/${i}`, f(i), 0);
  assert.deepEqual(addrs(out), ["/m/0", "/m/1", "/m/2", "/a/0"]);
  assert.equal(gov.backlog("auto"), 2);
  gov.pump(0.25);
  assert.deepEqual(addrs(out), ["/m/0", "/m/1", "/m/2", "/a/0", "/a/1"]);
  gov.pump(0.5);
  assert.equal(gov.backlog(), 0);
});

test("draining stops when the total bucket runs out", () => {
  const { gov, out } = rig({ manualPerS: 10, manualBurst: 10, totalPerS: 2 });
  for (let i = 0; i < 5; i++) gov.submit("manual", `/m/${i}`, f(i), 0);
  assert.equal(out.length, 2);
  gov.pump(0.5);
  assert.equal(out.length, 3);
  assert.equal(gov.backlog(), 2);
});

test("a new write waits behind its own lane's queue even when a token has come back", () => {
  const { gov, out } = rig({ totalPerS: 2, manualBurst: 5, manualPerS: 10 });
  for (let i = 0; i < 4; i++) gov.submit("manual", `/m/${i}`, f(i), 0);
  gov.submit("manual", "/late", f(9), 0.5);
  assert.deepEqual(addrs(out), ["/m/0", "/m/1", "/m/2"]);
  gov.pump(10);
  assert.deepEqual(addrs(out), ["/m/0", "/m/1", "/m/2", "/m/3", "/late"]);
});

test("a write that arrives after its lane's queue drains is sent at once", () => {
  const { gov, out } = rig();
  for (let i = 0; i < 3; i++) gov.submit("manual", `/m/${i}`, f(i), 0);
  gov.submit("manual", "/next", f(1), 1);
  assert.deepEqual(addrs(out), ["/m/0", "/m/1", "/m/2", "/next"]);
});

test("a safety write is sent at once without using tokens even when the lanes are empty", () => {
  const { gov, out } = rig();
  for (let i = 0; i < 4; i++) gov.submit("manual", `/m/${i}`, f(i), 0);
  for (let i = 0; i < 10; i++) gov.submit("safety", `/s/${i}`, f(i), 0);
  assert.equal(out.length, 12);
  assert.equal(gov.backlog(), 2);
  gov.pump(0.5);
  assert.equal(out.length, 13);
  assert.deepEqual(gov.stats(), { sent: 13, merged: 0, skipped: 0, queued: 2 });
});

test("a safety write is never skipped as a repeat", () => {
  const { gov, out } = rig();
  gov.submit("safety", "/s", f(1), 0);
  gov.submit("safety", "/s", f(1), 0);
  assert.equal(out.length, 2);
  assert.equal(gov.stats().skipped, 0);
});

test("a safety read cancels a queued automatic write to that address but keeps a queued manual one", () => {
  const { gov, out } = rig();
  for (let i = 0; i < 3; i++) gov.submit("manual", `/fill/${i}`, f(i), 0);
  for (let i = 0; i < 4; i++) gov.submit("auto", `/auto/${i}`, f(i), 0);
  gov.submit("manual", "/m/hand", f(5), 0);
  gov.submit("auto", "/m/job", f(7), 0);
  const queued = gov.backlog();
  gov.submit("safety", "/m/hand", [], 0);
  gov.submit("safety", "/m/job", [], 0);
  assert.equal(gov.backlog(), queued - 1);
  gov.pump(100);
  assert.deepEqual(out.filter((d) => d.address === "/m/hand").at(-1), { address: "/m/hand", args: f(5) });
  assert.deepEqual(
    out.filter((d) => d.address === "/m/job"),
    [{ address: "/m/job", args: [] }],
  );
});

test("a safety write cancels a queued write to the same address and becomes the latest value", () => {
  const { gov, out } = rig();
  for (let i = 0; i < 3; i++) gov.submit("manual", `/m/${i}`, f(i), 0);
  gov.submit("auto", "/m/1", f(7), 0);
  gov.submit("safety", "/m/2", f(-90), 0);
  assert.equal(gov.backlog(), 0);
  gov.pump(0.5);
  assert.deepEqual(out.at(-1), { address: "/m/2", args: f(-90) });
  assert.equal(out.length, 4);
  gov.submit("manual", "/m/2", f(-90), 0.9);
  assert.equal(out.length, 4);
  assert.equal(gov.stats().skipped, 1);
});

test("a repeated identical write within the repeat window is skipped and after it is sent", () => {
  const { gov, out } = rig({ manualBurst: 10, totalPerS: 10 });
  gov.submit("manual", "/a", [oscFloat(0.5), oscInt(3), oscStr("x"), oscBlob(new Uint8Array([1, 2]))], 0);
  gov.submit("manual", "/a", [oscFloat(0.5), oscInt(3), oscStr("x"), oscBlob(new Uint8Array([1, 2]))], 0.999);
  assert.equal(out.length, 1);
  assert.equal(gov.stats().skipped, 1);
  gov.submit("manual", "/a", [oscFloat(0.5), oscInt(3), oscStr("x"), oscBlob(new Uint8Array([1, 2]))], 1);
  assert.equal(out.length, 2);
});

test("a different value or a different address is not a repeat", () => {
  const { gov, out } = rig({ manualBurst: 10, totalPerS: 10 });
  gov.submit("manual", "/a", f(1), 0);
  gov.submit("manual", "/a", f(2), 0);
  gov.submit("manual", "/b", f(2), 0);
  assert.equal(out.length, 3);
  assert.equal(gov.stats().skipped, 0);
});

test("a repeat of the last sent value is not skipped while a different value for that address is queued", () => {
  const { gov, out } = rig();
  gov.submit("manual", "/a", f(1), 0);
  gov.submit("manual", "/b", f(1), 0);
  gov.submit("manual", "/a", f(2), 0);
  gov.submit("manual", "/a", f(1), 0.1);
  assert.equal(gov.stats().skipped, 0);
  assert.equal(gov.stats().merged, 1);
  gov.pump(0.5);
  assert.deepEqual(out.at(-1), { address: "/a", args: f(1) });
});

test("clearing the repeat memory lets an identical write through again", () => {
  const { gov, out } = rig();
  gov.submit("manual", "/a", f(1), 0);
  gov.clearRepeats();
  gov.submit("manual", "/a", f(1), 0);
  assert.equal(out.length, 2);
  assert.equal(gov.stats().skipped, 0);
});

test("argument comparison checks count, type tag and value including blob bytes", () => {
  assert.equal(sameArgs([], []), true);
  assert.equal(sameArgs(f(1), []), false);
  assert.equal(sameArgs([oscInt(1)], [oscFloat(1)]), false);
  assert.equal(sameArgs([oscStr("a")], [oscStr("b")]), false);
  assert.equal(sameArgs([oscFloat(Number.NaN)], [oscFloat(Number.NaN)]), true);
  assert.equal(sameArgs([oscBlob(new Uint8Array([1, 2]))], [oscBlob(new Uint8Array([1, 2]))]), true);
  assert.equal(sameArgs([oscBlob(new Uint8Array([1, 2]))], [oscBlob(new Uint8Array([1, 3]))]), false);
  assert.equal(sameArgs([oscBlob(new Uint8Array([1, 2]))], [oscBlob(new Uint8Array([1]))]), false);
  assert.equal(sameArgs([oscFloat(1), oscInt(2)], [oscFloat(1), oscInt(3)]), false);
});

test("a newer write to a queued address replaces its value in place and keeps its place in line", () => {
  const { gov, out } = rig();
  for (let i = 0; i < 2; i++) gov.submit("manual", `/x/${i}`, f(i), 0);
  gov.submit("manual", "/a", f(1), 0);
  gov.submit("manual", "/b", f(1), 0);
  gov.submit("manual", "/a", f(2), 0);
  gov.submit("manual", "/a", f(3), 0);
  assert.equal(gov.backlog(), 2);
  gov.pump(10);
  assert.deepEqual(out.slice(2), [
    { address: "/a", args: f(3) },
    { address: "/b", args: f(1) },
  ]);
  assert.deepEqual(gov.stats(), { sent: 4, merged: 2, skipped: 0, queued: 2 });
});

test("a merged write moves to the lane of the newer write and drains on that lane's tokens", () => {
  const { gov, out } = rig({ autoBurst: 1, autoPerS: 4, totalPerS: 10 });
  for (let i = 0; i < 3; i++) gov.submit("manual", `/m/${i}`, f(i), 0);
  gov.submit("auto", "/a/0", f(0), 0);
  assert.equal(gov.backlog("manual"), 1);
  gov.submit("auto", "/m/2", f(9), 0);
  assert.equal(gov.backlog("manual"), 0);
  assert.equal(gov.backlog("auto"), 1);
  gov.pump(0.25);
  assert.deepEqual(out.at(-1), { address: "/m/2", args: f(9) });
  assert.equal(gov.backlog(), 0);
});

test("a newer write replaces a queued one even when a token has just come back", () => {
  const { gov, out } = rig();
  gov.submit("manual", "/a", f(0), 0);
  gov.submit("manual", "/b", f(0), 0);
  gov.submit("manual", "/c", f(1), 0);
  gov.submit("manual", "/c", f(2), 0.5);
  assert.deepEqual(out.slice(2), [{ address: "/c", args: f(2) }]);
  assert.equal(gov.backlog(), 0);
  assert.deepEqual(gov.stats(), { sent: 3, merged: 1, skipped: 0, queued: 1 });
});

test("a lane without tokens does not block queued writes of the other lane", () => {
  const { gov, out } = rig({ manualBurst: 1, manualPerS: 1, autoBurst: 1, autoPerS: 4, totalPerS: 10 });
  gov.submit("manual", "/m/0", f(0), 0);
  gov.submit("manual", "/m/1", f(1), 0);
  gov.submit("manual", "/m/2", f(2), 0);
  gov.submit("auto", "/a/0", f(0), 0);
  gov.submit("auto", "/a/1", f(1), 0);
  gov.submit("auto", "/a/2", f(2), 0);
  assert.deepEqual(addrs(out), ["/m/0", "/a/0"]);
  gov.pump(0.25);
  assert.deepEqual(addrs(out), ["/m/0", "/a/0", "/a/1"]);
  gov.pump(0.5);
  assert.deepEqual(addrs(out), ["/m/0", "/a/0", "/a/1", "/a/2"]);
  assert.equal(gov.backlog("manual"), 2);
  gov.pump(1);
  assert.deepEqual(addrs(out).slice(4), ["/m/1"]);
  gov.pump(1.5);
  assert.deepEqual(addrs(out).slice(4), ["/m/1"]);
  gov.pump(2);
  assert.deepEqual(addrs(out).slice(4), ["/m/1", "/m/2"]);
});

test("storming starts once the auto backlog has lasted the storm time", () => {
  const { gov } = rig({ autoBurst: 1, autoPerS: 0.1 });
  assert.equal(gov.storming(0), false);
  gov.submit("auto", "/a/0", f(0), 0);
  assert.equal(gov.storming(0), false);
  gov.submit("auto", "/a/1", f(1), 1);
  gov.submit("auto", "/a/2", f(2), 1.5);
  assert.equal(gov.storming(2.999), false);
  assert.equal(gov.storming(3), true);
  gov.pump(4);
  assert.equal(gov.storming(4), true);
});

test("storming resets when the auto backlog empties and a manual backlog never storms", () => {
  const { gov } = rig({ autoBurst: 1, autoPerS: 1 });
  gov.submit("auto", "/a/0", f(0), 0);
  gov.submit("auto", "/a/1", f(1), 0);
  for (let i = 0; i < 5; i++) gov.submit("manual", `/m/${i}`, f(i), 0);
  gov.pump(1);
  assert.equal(gov.backlog("auto"), 0);
  assert.equal(gov.storming(5), false);
  gov.submit("auto", "/a/2", f(2), 1);
  gov.submit("auto", "/a/3", f(3), 1);
  assert.equal(gov.storming(2.5), false);
  assert.equal(gov.storming(3), true);
});

test("a safety write that clears the only queued auto write ends a storm", () => {
  const { gov } = rig({ autoBurst: 1, autoPerS: 0.01 });
  gov.submit("auto", "/a/0", f(0), 0);
  gov.submit("auto", "/a/1", f(1), 0);
  assert.equal(gov.storming(2), true);
  gov.submit("safety", "/a/1", f(5), 2);
  assert.equal(gov.storming(10), false);
});

test("a governor whose first time is not a finite number still starts at the first real time", () => {
  const { gov, out } = rig();
  gov.submit("manual", "/a", f(0), Number.NaN);
  gov.submit("manual", "/b", f(0), 0);
  gov.submit("manual", "/c", f(0), 0);
  gov.pump(0.5);
  assert.deepEqual(addrs(out), ["/a", "/b", "/c"]);
});

test("time going backwards neither adds nor removes tokens and does not undo the repeat window", () => {
  const { gov, out } = rig();
  gov.submit("manual", "/a", f(1), 10);
  gov.submit("manual", "/b", f(1), 10);
  gov.submit("manual", "/c", f(1), 10);
  gov.pump(5);
  gov.pump(10);
  gov.pump(Number.NaN);
  gov.pump(Number.POSITIVE_INFINITY);
  assert.equal(out.length, 2);
  gov.submit("manual", "/a", f(1), 3);
  assert.equal(gov.stats().skipped, 1);
  gov.pump(10.5);
  assert.equal(out.length, 3);
  gov.submit("manual", "/a", f(1), 11);
  assert.equal(out.length, 4);
  assert.equal(gov.storming(-100), false);
});

test("a flood of a thousand writes in one second to ten faders stays in budget and ends on each fader's last value", () => {
  const opts: GovernorOptions = { manualPerS: 100, manualBurst: 50, autoPerS: 150, autoBurst: 75, totalPerS: 250, repeatS: 1, stormS: 2 };
  const out: Sent[] = [];
  const gov = new WriteGovernor(opts, (address, args) => out.push({ address, args }));
  const lastSubmitted = new Map<string, number>();
  for (let i = 0; i < 1000; i++) {
    const address = `/ch/${String((i % 10) + 1).padStart(2, "0")}/mix/fader`;
    const v = ((i * 37) % 1000) / 1000;
    lastSubmitted.set(address, v);
    gov.submit("manual", address, f(v), i / 1000);
  }
  assert.ok(out.length <= opts.manualBurst + opts.manualPerS * 1, `sent ${out.length}`);
  assert.ok(gov.backlog("manual") <= 10);
  for (let t = 1; t <= 3; t += 0.01) gov.pump(t);
  assert.equal(gov.backlog(), 0);
  const finalSent = new Map<string, number>();
  for (const s of out) finalSent.set(s.address, Number(s.args[0]?.v));
  assert.equal(finalSent.size, 10);
  assert.deepEqual([...finalSent.entries()].sort(), [...lastSubmitted.entries()].sort());
  const st = gov.stats();
  assert.equal(st.sent + st.merged + st.skipped, 1000);
});

test("storming at a time that is not a finite number answers by the governor's own clock", () => {
  const { gov } = rig({ autoBurst: 1, autoPerS: 0.01 });
  gov.submit("auto", "/a/0", f(0), 0);
  gov.submit("auto", "/a/1", f(1), 0);
  assert.equal(gov.storming(Number.NaN), false);
  assert.equal(gov.storming(Number.POSITIVE_INFINITY), false);
  assert.equal(gov.storming(Number.NEGATIVE_INFINITY), false);
  gov.pump(2);
  assert.equal(gov.storming(Number.NaN), true);
  assert.equal(gov.storming(Number.POSITIVE_INFINITY), true);
  assert.equal(gov.storming(Number.NEGATIVE_INFINITY), true);
});

test("an auto backlog built before the first real time does not count as an old storm", () => {
  const { gov } = rig({ autoBurst: 1, autoPerS: 0.01 });
  gov.submit("auto", "/a/0", f(0), Number.NaN);
  gov.submit("auto", "/a/1", f(1), Number.NaN);
  assert.equal(gov.backlog("auto"), 1);
  gov.pump(1000);
  assert.equal(gov.storming(1000), false);
  assert.equal(gov.storming(1001.5), false);
  assert.equal(gov.storming(1002), true);
});

test("submits and pumps at times that are not finite numbers neither refill tokens nor move the clock", () => {
  for (const t of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const { gov, out } = rig();
    for (let i = 0; i < 3; i++) gov.submit("manual", `/m/${i}`, f(i), 10);
    gov.submit("manual", "/m/9", f(9), t);
    gov.pump(t);
    assert.equal(out.length, 2);
    gov.submit("manual", "/m/0", f(0), t);
    assert.equal(gov.stats().skipped, 1);
    gov.pump(10.25);
    assert.equal(out.length, 2);
    gov.pump(10.5);
    assert.equal(out.length, 3);
    gov.submit("manual", "/m/0", f(0), 10.75);
    assert.equal(gov.stats().skipped, 2);
    gov.submit("manual", "/m/0", f(0), 11);
    gov.pump(12);
    assert.equal(out.filter((s) => s.address === "/m/0").length, 2);
  }
});
