import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManualClock } from "../src/core/clock.ts";
import { defaultConfig } from "../src/core/config.ts";
import { SimConsole } from "../src/core/console.ts";
import { RunLedger, parseRunRecord, uncleanBanner } from "../src/core/runledger.ts";
import { RunMarker } from "../src/host/runmarker.ts";

test("the ledger keeps the last value per channel of what the run changed on the console", () => {
  const l = new RunLedger("2026-11-27T20:00:00Z", 42);
  assert.equal(l.changed(), false);
  l.note({ kind: "fader", ch: 3, db: -8 });
  l.note({ kind: "fader", ch: 3, db: -6.5 });
  l.note({ kind: "gain", ch: 1, db: 31 });
  l.note({ kind: "notch", ch: 2, band: 3, hz: 2500, gainDb: -6, q: 8 });
  l.note({ kind: "notch", ch: 2, band: 3, hz: 2400, gainDb: -6, q: 8 });
  l.note({ kind: "scene", index: 4 });
  l.note({ kind: "ch_mute", ch: 7, muted: true });
  l.note({ kind: "main_mute", muted: true });
  assert.equal(l.changed(), true);
  const r = l.snapshot(false);
  assert.deepEqual(r.changes.faders, { "3": -6.5 });
  assert.deepEqual(r.changes.gains, { "1": 31 });
  assert.equal(r.changes.notches, 1, "the same band counted once");
  assert.equal(r.changes.scene, 4);
  assert.deepEqual(r.changes.mutes, { "7": true });
  assert.equal(r.changes.mainMuted, true);
  assert.equal(r.clean, false);
});

test("a run that stopped cleanly, or a broken file, gives no banner; an unclean one lists its changes", () => {
  const l = new RunLedger("2026-11-27T20:00:00Z", 42);
  l.note({ kind: "fader", ch: 3, db: -6.5 });
  l.note({ kind: "gain", ch: 1, db: 31 });
  l.note({ kind: "notch", ch: 2, band: 1, hz: 2500, gainDb: -6, q: 8 });
  l.note({ kind: "main_mute", muted: true });
  assert.deepEqual(uncleanBanner(l.snapshot(true)), []);
  assert.equal(parseRunRecord("{not json"), null);
  assert.equal(parseRunRecord(JSON.stringify({ started: 1 })), null);
  const text = uncleanBanner(parseRunRecord(JSON.stringify(l.snapshot(false)))!).join("\n");
  assert.match(text, /did not stop cleanly/);
  assert.match(text, /2026-11-27T20:00:00Z/);
  assert.match(text, /ch3 fader -6\.5 dB/);
  assert.match(text, /ch1 preamp 31 dB/);
  assert.match(text, /1 EQ notch/);
  assert.match(text, /main output MUTED/);
  assert.match(text, /check the console/i);
  const quiet = new RunLedger("t", 1).snapshot(false);
  assert.match(uncleanBanner(quiet).join("\n"), /changed nothing on the console/);
});

test("the console reports every change it makes to whoever listens, and a broken listener does not stop the write", () => {
  const con = new SimConsole({ cfg: defaultConfig() });
  const heard: string[] = [];
  con.onRecorded = (e) => heard.push(e.kind);
  con.setFaderDb(2, -10);
  con.nudgeGainDb(2, 20, 2);
  assert.deepEqual(heard, ["fader", "gain"]);
  con.onRecorded = () => {
    throw new Error("listener broke");
  };
  assert.equal(con.setFaderDb(2, -9), -9);
});

test("the run marker: a live run is unclean until it ends, the next start shows the banner once, and a running copy is not reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "trio-run-"));
  const path = join(dir, "last-run.json");
  const clock = new ManualClock(100, 1_764_273_600);
  try {
    const first = new RunMarker(path, clock, 1001, () => false);
    assert.deepEqual(first.previousBanner(), []);
    const con = new SimConsole({ cfg: defaultConfig() });
    first.begin(con);
    con.setFaderDb(4, -7);
    first.flush();
    assert.equal(JSON.parse(readFileSync(path, "utf8")).clean, false);
    const second = new RunMarker(path, clock, 1002, () => false);
    assert.match(second.previousBanner().join("\n"), /ch4 fader -7 dB/);
    const stillRunning = new RunMarker(path, clock, 1003, (pid) => pid === 1001);
    assert.deepEqual(stillRunning.previousBanner(), [], "another copy still running is not an unclean stop");
    first.end();
    assert.equal(JSON.parse(readFileSync(path, "utf8")).clean, true);
    assert.deepEqual(new RunMarker(path, clock, 1004, () => false).previousBanner(), []);
    writeFileSync(path, "garbage");
    assert.deepEqual(new RunMarker(path, clock, 1005, () => false).previousBanner(), []);
    rmSync(path);
    assert.ok(!existsSync(path));
    assert.deepEqual(new RunMarker(path, clock, 1006, () => false).previousBanner(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
