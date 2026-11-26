import assert from "node:assert/strict";
import test from "node:test";
import { MAX_WRITES_PER_CHANNEL, type OutsideEditOptions, OutsideEdits } from "../src/core/outsideedits.ts";

const opts: OutsideEditOptions = { echoTolDb: 0.25, echoWindowS: 2, lockMoves: 3, lockWindowS: 60 };

test("a report of the exact value the app wrote is an echo", () => {
  const e = new OutsideEdits(opts);
  e.noteWrite(1, -10, 100);
  assert.equal(e.classify(1, -10, 100.5), "echo");
});

test("a report close to the value the app wrote is an echo", () => {
  const e = new OutsideEdits(opts);
  e.noteWrite(1, -10, 100);
  assert.equal(e.classify(1, -10.125, 100.5), "echo");
  assert.equal(e.classify(1, -9.875, 100.5), "echo");
});

test("a report exactly at the tolerance is an echo and just beyond it is an outside move", () => {
  const e = new OutsideEdits(opts);
  e.noteWrite(1, -10, 100);
  assert.equal(e.classify(1, -10.25, 100.5), "echo");
  assert.equal(e.classify(1, -9.75, 100.5), "echo");
  assert.equal(e.classify(1, -10.375, 100.5), "outside");
  assert.equal(e.classify(1, -9.5, 100.5), "outside");
});

test("a report matching an intermediate step of a ramp is an echo", () => {
  const e = new OutsideEdits(opts);
  e.noteWrite(1, -20, 100);
  e.noteWrite(1, -16, 100.25);
  e.noteWrite(1, -12, 100.5);
  e.noteWrite(1, -8, 100.75);
  assert.equal(e.classify(1, -16, 101), "echo");
  assert.equal(e.classify(1, -20, 101), "echo");
  assert.equal(e.classify(1, -14, 101), "outside");
});

test("a write stops counting as an echo once the window has passed", () => {
  const e = new OutsideEdits(opts);
  e.noteWrite(1, -10, 100);
  assert.equal(e.classify(1, -10, 102), "echo");
  assert.equal(e.classify(1, -10, 102.0078125), "outside");
});

test("a channel with no writes reports every move as outside", () => {
  const e = new OutsideEdits(opts);
  assert.equal(e.classify(4, -10, 100), "outside");
});

test("writes on one channel do not make echoes on another", () => {
  const e = new OutsideEdits(opts);
  e.noteWrite(1, -10, 100);
  assert.equal(e.classify(2, -10, 100.5), "outside");
  assert.equal(e.classify(1, -10, 100.5), "echo");
});

test("old writes are dropped when a later write arrives after the window", () => {
  const e = new OutsideEdits(opts);
  e.noteWrite(1, -10, 100);
  e.noteWrite(1, -5, 102);
  assert.equal(e.classify(1, -10, 102), "echo");
  e.noteWrite(1, -5, 102.5);
  assert.equal(e.classify(1, -10, 100), "outside");
  assert.equal(e.classify(1, -5, 102.5), "echo");
});

test("a report with no finite value is treated as an echo so it never counts as a person", () => {
  const e = new OutsideEdits(opts);
  assert.equal(e.classify(1, Number.NaN, 100), "echo");
  assert.equal(e.classify(1, Number.POSITIVE_INFINITY, 100), "echo");
  assert.equal(e.classify(1, Number.NEGATIVE_INFINITY, 100), "echo");
});

test("a write with no finite value is not remembered", () => {
  const e = new OutsideEdits(opts);
  e.noteWrite(1, Number.NaN, 100);
  e.noteWrite(1, Number.NEGATIVE_INFINITY, 100);
  assert.equal(e.classify(1, -10, 100), "outside");
  e.noteWrite(1, -10, 100);
  e.noteWrite(1, Number.POSITIVE_INFINITY, 100.5);
  assert.equal(e.classify(1, -10, 100.5), "echo");
});

test("only the newest writes are kept per channel", () => {
  const full = new OutsideEdits(opts);
  full.noteWrite(1, 0, 100);
  for (let i = 1; i < MAX_WRITES_PER_CHANNEL; i++) full.noteWrite(1, -50, 100);
  assert.equal(full.classify(1, 0, 100), "echo");

  const over = new OutsideEdits(opts);
  over.noteWrite(1, 0, 100);
  for (let i = 0; i < MAX_WRITES_PER_CHANNEL; i++) over.noteWrite(1, -50, 100);
  assert.equal(over.classify(1, 0, 100), "outside");
  assert.equal(over.classify(1, -50, 100), "echo");
});

test("the third outside move within the window locks the channel", () => {
  const e = new OutsideEdits(opts);
  assert.equal(e.noteOutside(3, 100), false);
  assert.equal(e.locked(3), false);
  assert.equal(e.noteOutside(3, 110), false);
  assert.equal(e.locked(3), false);
  assert.equal(e.noteOutside(3, 120), true);
  assert.equal(e.locked(3), true);
  assert.deepEqual(e.lockedChannels(), [3]);
});

test("outside moves spread beyond the window do not lock the channel", () => {
  const e = new OutsideEdits(opts);
  assert.equal(e.noteOutside(3, 100), false);
  assert.equal(e.noteOutside(3, 140), false);
  assert.equal(e.noteOutside(3, 180), false);
  assert.equal(e.noteOutside(3, 220), false);
  assert.equal(e.locked(3), false);
});

test("a move exactly the window length after the first still counts", () => {
  const e = new OutsideEdits(opts);
  e.noteOutside(3, 100);
  e.noteOutside(3, 130);
  assert.equal(e.noteOutside(3, 160), true);
  assert.equal(e.locked(3), true);
});

test("a move just past the window length after the first does not lock", () => {
  const e = new OutsideEdits(opts);
  e.noteOutside(3, 100);
  e.noteOutside(3, 130);
  assert.equal(e.noteOutside(3, 160.0078125), false);
  assert.equal(e.locked(3), false);
  assert.equal(e.noteOutside(3, 170), true);
});

test("locking reports true only once and later moves report false", () => {
  const e = new OutsideEdits(opts);
  e.noteOutside(3, 100);
  e.noteOutside(3, 101);
  assert.equal(e.noteOutside(3, 102), true);
  assert.equal(e.noteOutside(3, 103), false);
  assert.equal(e.noteOutside(3, 104), false);
  assert.equal(e.locked(3), true);
});

test("outside moves on one channel do not lock another", () => {
  const e = new OutsideEdits(opts);
  e.noteOutside(3, 100);
  e.noteOutside(3, 101);
  e.noteOutside(4, 102);
  assert.equal(e.locked(3), false);
  assert.equal(e.locked(4), false);
  assert.equal(e.noteOutside(3, 103), true);
  assert.equal(e.locked(4), false);
});

test("unlocking clears the lock and the move history", () => {
  const e = new OutsideEdits(opts);
  e.noteOutside(3, 100);
  e.noteOutside(3, 101);
  e.noteOutside(3, 102);
  e.unlock(3);
  assert.equal(e.locked(3), false);
  assert.deepEqual(e.lockedChannels(), []);
  assert.equal(e.noteOutside(3, 103), false);
  assert.equal(e.noteOutside(3, 104), false);
  assert.equal(e.noteOutside(3, 105), true);
});

test("unlocking a channel that is not locked clears its move history", () => {
  const e = new OutsideEdits(opts);
  e.noteOutside(3, 100);
  e.noteOutside(3, 101);
  e.unlock(3);
  assert.equal(e.noteOutside(3, 102), false);
  assert.equal(e.locked(3), false);
});

test("locked channels are listed in ascending order", () => {
  const e = new OutsideEdits(opts);
  for (const ch of [12, 2, 7]) {
    e.noteOutside(ch, 100);
    e.noteOutside(ch, 101);
    e.noteOutside(ch, 102);
  }
  assert.deepEqual(e.lockedChannels(), [2, 7, 12]);
});

test("reset forgets writes, moves and locks", () => {
  const e = new OutsideEdits(opts);
  e.noteWrite(1, -10, 100);
  e.noteOutside(3, 100);
  e.noteOutside(3, 101);
  e.noteOutside(3, 102);
  e.noteOutside(4, 100);
  e.noteOutside(4, 101);
  e.reset();
  assert.equal(e.classify(1, -10, 100), "outside");
  assert.deepEqual(e.lockedChannels(), []);
  assert.equal(e.locked(3), false);
  assert.equal(e.noteOutside(4, 102), false);
});

test("the options are copied so later changes to the caller's object have no effect", () => {
  const mine: OutsideEditOptions = { ...opts };
  const e = new OutsideEdits(mine);
  mine.echoTolDb = 10;
  e.noteWrite(1, -10, 100);
  assert.equal(e.classify(1, -15, 100), "outside");
});

test("the safety defaults lock on the third move within a minute", () => {
  const e = new OutsideEdits({ echoTolDb: 0.3, echoWindowS: 2.0, lockMoves: 3, lockWindowS: 60.0 });
  e.noteWrite(5, -6, 10);
  assert.equal(e.classify(5, -6.25, 11.5), "echo");
  assert.equal(e.classify(5, -7, 11.5), "outside");
  assert.equal(e.noteOutside(5, 0), false);
  assert.equal(e.noteOutside(5, 30), false);
  assert.equal(e.noteOutside(5, 60), true);
});
