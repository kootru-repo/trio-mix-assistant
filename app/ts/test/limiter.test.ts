import { defaultConfig } from "../src/core/config.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { CommandBudget, GLOBAL_COMMAND_KEY, globalCommandBudget } from "../src/host/server/limiter.ts";

const testCfg = defaultConfig();

test("a fresh budget lets exactly its burst through at one moment", () => {
  const now = 5;
  const b = new CommandBudget(100, 200, () => now);
  const got = Array.from({ length: 205 }, () => b.allow(GLOBAL_COMMAND_KEY));
  assert.equal(got.filter(Boolean).length, 200);
  assert.deepEqual(got.slice(198), [true, true, false, false, false, false, false]);
  assert.equal(b.dropped, 5);
});

test("the budget refills one command per rate interval at exact times", () => {
  let now = 0;
  const b = new CommandBudget(100, 200, () => now);
  for (let i = 0; i < 200; i++) assert.ok(b.allow("k"));
  assert.equal(b.allow("k"), false);
  now = 0.01;
  assert.equal(b.allow("k"), true);
  assert.equal(b.allow("k"), false);
  now = 0.26;
  assert.equal(Array.from({ length: 60 }, () => b.allow("k")).filter(Boolean).length, 25);
});

test("the budget never refills beyond its burst after a long idle", () => {
  let now = 0;
  const b = new CommandBudget(100, 200, () => now);
  assert.ok(b.allow("k"));
  now = 1_000_000;
  assert.equal(Array.from({ length: 300 }, () => b.allow("k")).filter(Boolean).length, 200);
});

test("refused commands never drive the budget below empty", () => {
  let now = 0;
  const b = new CommandBudget(100, 200, () => now);
  for (let i = 0; i < 10_000; i++) b.allow("k");
  assert.equal(b.dropped, 9_800);
  now = 0.01;
  assert.equal(b.allow("k"), true);
});

test("time going backwards neither drains nor refills the budget", () => {
  let now = 100;
  const b = new CommandBudget(100, 200, () => now);
  for (let i = 0; i < 100; i++) assert.ok(b.allow("k"));
  now = 50;
  assert.equal(Array.from({ length: 150 }, () => b.allow("k")).filter(Boolean).length, 100);
  now = 100;
  assert.equal(b.allow("k"), false);
  now = 100.01;
  assert.equal(b.allow("k"), true);
  assert.equal(b.allow("k"), false);
});

test("the global command budget takes its rate and burst from the safety settings", () => {
  const now = 0;
  const b = globalCommandBudget(testCfg.safety, () => now);
  assert.equal(b.rate, testCfg.safety.commandPerS);
  assert.equal(b.burst, testCfg.safety.commandBurst);
  assert.equal(b.rate, 100);
  assert.equal(b.burst, 200);
});
