import assert from "node:assert/strict";
import test from "node:test";
import { type EditKind, type OutsideEditOptions, OutsideEdits } from "../src/core/outsideedits.ts";

const opts: OutsideEditOptions = { echoTolDb: 0.25, echoWindowS: 2, lockMoves: 3, lockWindowS: 4 };
const eps = 1 / 128;
const start = 100;
const depth = 5;

type Ev =
  | { k: "write"; ch: number; db: number }
  | { k: "report"; ch: number; db: number }
  | { k: "wait"; dt: number }
  | { k: "unlock"; ch: number };

const alphabet: readonly Ev[] = [
  { k: "write", ch: 1, db: -10 },
  { k: "write", ch: 1, db: -9.5 },
  { k: "write", ch: 2, db: -10 },
  { k: "report", ch: 1, db: -10.25 },
  { k: "report", ch: 1, db: -9.75 },
  { k: "report", ch: 1, db: -9.625 },
  { k: "report", ch: 1, db: -10.375 },
  { k: "report", ch: 1, db: Number.NaN },
  { k: "report", ch: 2, db: -10.25 },
  { k: "report", ch: 2, db: -10.375 },
  { k: "wait", dt: opts.echoWindowS - eps },
  { k: "wait", dt: opts.echoWindowS },
  { k: "wait", dt: opts.echoWindowS + eps },
  { k: "unlock", ch: 1 },
];

const probes: readonly number[] = [-10.375, -10.25, -9.75, -9.375];

const label = (e: Ev): string => {
  if (e.k === "wait") return `wait(${e.dt})`;
  if (e.k === "unlock") return `unlock(ch${e.ch})`;
  return `${e.k}(ch${e.ch}, ${e.db})`;
};

const forEachSequence = (size: number, len: number, visit: (seq: readonly number[]) => void): number => {
  const seq: number[] = new Array<number>(len).fill(0);
  let count = 0;
  for (;;) {
    visit(seq);
    count++;
    let i = len - 1;
    while (i >= 0 && seq[i] === size - 1) {
      seq[i] = 0;
      i--;
    }
    if (i < 0) return count;
    seq[i] = (seq[i] ?? 0) + 1;
  }
};

interface Oracle {
  now: number;
  writes: { ch: number; db: number; t: number }[];
  moves: Map<number, number[]>;
  locks: Set<number>;
}

const expectedKind = (o: Oracle, ch: number, db: number): EditKind => {
  if (!Number.isFinite(db)) return "echo";
  const match = o.writes.some((w) => w.ch === ch && o.now - w.t <= opts.echoWindowS && Math.abs(db - w.db) <= opts.echoTolDb);
  return match ? "echo" : "outside";
};

interface Tally {
  echo: number;
  outside: number;
  locks: number;
  lockAtWindowEdge: number;
  echoAtWindowEdge: number;
  movesWhileLocked: number;
}

const runSequence = (seq: readonly number[], tally: Tally): void => {
  const e = new OutsideEdits(opts);
  const o: Oracle = { now: start, writes: [], moves: new Map(), locks: new Set() };
  const trail: string[] = [];
  const fail = (what: string): never => assert.fail(`${what} after ${trail.join(" -> ")}`);
  for (const idx of seq) {
    const ev = alphabet[idx]!;
    trail.push(label(ev));
    if (ev.k === "wait") o.now += ev.dt;
    else if (ev.k === "write") {
      e.noteWrite(ev.ch, ev.db, o.now);
      o.writes.push({ ch: ev.ch, db: ev.db, t: o.now });
    } else if (ev.k === "unlock") {
      e.unlock(ev.ch);
      o.locks.delete(ev.ch);
      o.moves.delete(ev.ch);
    } else {
      const lockedBefore = o.locks.has(ev.ch);
      const want = expectedKind(o, ev.ch, ev.db);
      const got = e.classify(ev.ch, ev.db, o.now);
      if (got !== want) fail(`classify(ch${ev.ch}, ${ev.db}) gave ${got}, expected ${want}`);
      if (want === "echo") {
        tally.echo++;
        if (o.writes.some((w) => w.ch === ev.ch && o.now - w.t === opts.echoWindowS && Math.abs(ev.db - w.db) <= opts.echoTolDb)) {
          tally.echoAtWindowEdge++;
        }
      } else {
        tally.outside++;
        const lockedNow = e.noteOutside(ev.ch, o.now);
        let wantLock = false;
        if (lockedBefore) tally.movesWhileLocked++;
        else {
          const kept = [...(o.moves.get(ev.ch) ?? []), o.now];
          o.moves.set(ev.ch, kept);
          const inWindow = kept.filter((t) => o.now - t <= opts.lockWindowS);
          if (inWindow.length > opts.lockMoves) fail(`${inWindow.length} hand moves inside the window without a lock`);
          if (inWindow.length === opts.lockMoves) {
            wantLock = true;
            o.locks.add(ev.ch);
            tally.locks++;
            if (o.now - inWindow[0]! === opts.lockWindowS) tally.lockAtWindowEdge++;
          }
        }
        if (lockedNow !== wantLock) fail(`noteOutside(ch${ev.ch}) returned ${lockedNow}, expected ${wantLock}`);
      }
      if (want === "echo" && e.locked(ev.ch) !== lockedBefore) fail("an echo changed the lock");
    }
    for (const ch of [1, 2]) {
      if (e.locked(ch) !== o.locks.has(ch)) fail(`locked(ch${ch}) is ${e.locked(ch)}`);
      for (const db of probes) {
        const want = expectedKind(o, ch, db);
        if (e.classify(ch, db, o.now) !== want) fail(`probe classify(ch${ch}, ${db}) is not ${want}`);
      }
    }
    const listed = e.lockedChannels();
    const wantList = [...o.locks].sort((a, b) => a - b);
    if (listed.join(",") !== wantList.join(",")) fail(`lockedChannels() is [${listed.join(",")}]`);
  }
};

test("every sequence of app writes, console reports, waits and unlocks on two channels matches the echo and lock rules", () => {
  const tally: Tally = { echo: 0, outside: 0, locks: 0, lockAtWindowEdge: 0, echoAtWindowEdge: 0, movesWhileLocked: 0 };
  const count = forEachSequence(alphabet.length, depth, (seq) => runSequence(seq, tally));
  assert.equal(count, alphabet.length ** depth);
  assert.ok(tally.echo > 0);
  assert.ok(tally.outside > 0);
  assert.ok(tally.locks > 0);
  assert.ok(tally.lockAtWindowEdge > 0);
  assert.ok(tally.echoAtWindowEdge > 0);
  assert.ok(tally.movesWhileLocked > 0);
});
