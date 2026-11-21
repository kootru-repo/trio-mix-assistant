import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildModel } from "../src/core/venue.ts";
import { SessionLog } from "../src/host/sessionlog.ts";
import { fixture } from "./helpers.ts";

const fx = fixture("sessionlog");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "trio-sl-"));
}

test("log, summary and recent", async () => {
  const sl = new SessionLog(":memory:");
  try {
    sl.startSession("The Cellar", "Trio", "simulation");
    sl.logEvent({ time: "", kind: "feedback", level: "notice", ch: 1, role: "lead_vox", msg: "2500 Hz" });
    sl.logEvent({ time: "", kind: "clip", level: "warn", ch: 6, role: "cajon", msg: "near clip" });
    sl.logEvent({ time: "", kind: "feedback", level: "notice", ch: 8, role: "meas_mic", msg: "ring" });
    await sl.flush();
    assert.deepEqual(sl.summary(), { feedback: 2, clip: 1 });
    const rec = sl.recent(10);
    assert.equal(rec.length, 3);
    assert.equal(rec[rec.length - 1]!.kind, "feedback");
    assert.equal(rec[0]!.kind, "feedback");
    assert.equal(rec[0]!.role, "lead_vox");
  } finally {
    sl.close();
  }
});

test("log before a session is a no-op", async () => {
  const sl = new SessionLog(":memory:");
  try {
    sl.logEvent({ time: "", kind: "x", ch: null, role: null, msg: "y" });
    await sl.flush();
    assert.deepEqual(sl.recent(5), []);
  } finally {
    sl.close();
  }
});

test("logEvent does not write synchronously", async () => {
  const sl = new SessionLog(":memory:");
  try {
    sl.startSession("V");
    sl.logEvent({ time: "", kind: "a", ch: null, role: null, msg: "m" });
    assert.deepEqual(sl.summary(), {});
    await sl.flush();
    assert.deepEqual(sl.summary(), { a: 1 });
  } finally {
    sl.close();
  }
});

test("venue history", async () => {
  const sl = new SessionLog(":memory:");
  try {
    sl.startSession("Barn", "Trio");
    sl.logEvent({ time: "", kind: "feedback", ch: null, role: null, msg: "a" });
    await sl.flush();
    sl.startSession("Barn", "Trio");
    sl.logEvent({ time: "", kind: "clip", ch: null, role: null, msg: "b" });
    await sl.flush();
    const hist = sl.venueHistory("Barn");
    assert.equal(hist.length, 2);
    assert.deepEqual(hist[0]!.counts, { clip: 1 });
    assert.deepEqual(hist[1]!.counts, { feedback: 1 });
    assert.ok(hist[0]!.session_id > hist[1]!.session_id);
    assert.equal(sl.venueHistory("Barn", 1).length, 1);
  } finally {
    sl.close();
  }
});

test("venue queries on an empty database", () => {
  const sl = new SessionLog(":memory:");
  try {
    assert.deepEqual(sl.venueFeedback("Nope"), []);
    assert.equal(sl.venueShows("Nope"), 0);
    assert.deepEqual(sl.summary(), {});
    assert.deepEqual(sl.recent(), []);
  } finally {
    sl.close();
  }
});

test("a full queue drops events and counts them", async () => {
  const sl = new SessionLog(":memory:");
  try {
    sl.startSession("V");
    for (let i = 0; i < 4100; i++) sl.logEvent({ time: "", kind: "k", ch: null, role: null, msg: String(i) });
    assert.equal(sl.dropped, 4);
    await sl.flush();
    assert.deepEqual(sl.summary(), { k: 4096 });
  } finally {
    sl.close();
  }
});

test("close writes everything still queued", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "s.db");
    const sl = new SessionLog(path);
    sl.startSession("V");
    sl.logEvent({ time: "", kind: "k", ch: null, role: null, msg: "m" });
    sl.close();
    const db = new DatabaseSync(path);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get()!["n"], 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file database persists across opens", async () => {
  const dir = tempDir();
  try {
    const path = join(dir, "s.db");
    const a = new SessionLog(path);
    const sid = a.startSession("Barn", "Trio", "simulation");
    a.logEvent({ time: "", kind: "feedback", ch: 3, role: "gtr", msg: "1000 Hz" });
    await a.flush();
    a.close();
    const b = new SessionLog(path);
    assert.deepEqual(b.summary(sid), { feedback: 1 });
    assert.deepEqual(b.venueFeedback("Barn"), ["1000 Hz"]);
    const sid2 = b.startSession("Barn");
    assert.equal(sid2, sid + 1);
    assert.equal(b.venueShows("Barn"), 2);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the first write failure warns once and the log keeps going", async () => {
  const dir = tempDir();
  try {
    const path = join(dir, "s.db");
    const warnings: string[] = [];
    const sl = new SessionLog(path, { warn: (m) => warnings.push(m) });
    sl.startSession("V");
    const other = new DatabaseSync(path);
    other.exec("DROP TABLE events");
    other.close();
    sl.logEvent({ time: "", kind: "a", ch: null, role: null, msg: "1" });
    await sl.flush();
    sl.logEvent({ time: "", kind: "a", ch: null, role: null, msg: "2" });
    await sl.flush();
    assert.equal(warnings.length, 1);
    sl.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a database recorded by the Python SessionLog reads identically", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "py.db");
    writeFileSync(path, Buffer.from(fx.db, "base64"));
    const sl = new SessionLog(path);
    try {
      for (const sid of fx.sids as number[]) {
        assert.deepEqual(sl.summary(sid), fx.summaries[String(sid)], `summary ${sid}`);
        assert.deepEqual(sl.recent(50, sid), fx.recent[String(sid)], `recent ${sid}`);
      }
      assert.deepEqual(sl.recent(2, fx.sids[0]), fx.recent2);
      for (const v of Object.keys(fx.feedback)) {
        assert.deepEqual(sl.venueFeedback(v), fx.feedback[v], `feedback ${v}`);
        assert.equal(sl.venueShows(v), fx.shows[v], `shows ${v}`);
      }
      for (const v of Object.keys(fx.history)) assert.deepEqual(sl.venueHistory(v), fx.history[v], `history ${v}`);
      for (const v of Object.keys(fx.models)) {
        assert.deepEqual(buildModel(sl, v, 1700000000.5), fx.models[v], `model ${v}`);
      }
    } finally {
      sl.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a database written by TypeScript has the Python schema", async () => {
  const dir = tempDir();
  try {
    const path = join(dir, "ts.db");
    const sl = new SessionLog(path);
    sl.startSession("Barn", "Trio", "simulation");
    sl.logEvent({ time: "", kind: "feedback", level: "notice", ch: 1, role: "lead", msg: "2500 Hz" });
    await sl.flush();
    sl.close();
    const db = new DatabaseSync(path);
    const cols = (t: string): string[] => db.prepare(`PRAGMA table_info(${t})`).all().map((r) => String(r["name"]));
    assert.deepEqual(cols("sessions"), ["id", "started", "venue", "template", "mode"]);
    assert.deepEqual(cols("events"), ["session_id", "t", "kind", "level", "ch", "role", "msg"]);
    const row = db.prepare("SELECT typeof(started) AS a, typeof(ch) AS b FROM sessions, events").get()!;
    assert.equal(row["a"], "real");
    assert.equal(row["b"], "integer");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
