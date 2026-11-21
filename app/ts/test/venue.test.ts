import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildModel, slug, watchFreqs } from "../src/core/venue.ts";
import type { VenueModel } from "../src/core/venue.ts";
import { SessionLog } from "../src/host/sessionlog.ts";
import { VenueStore } from "../src/host/venuestore.ts";
import { fixture } from "./helpers.ts";

const fx = fixture("sessionlog");

function model(over: Partial<VenueModel> = {}): VenueModel {
  return { venue: "", shows: 0, feedback_freqs: [], confidence: 0, updated: 0, ...over };
}

test("buildModel buckets freqs and counts shows", async () => {
  const sl = new SessionLog(":memory:");
  try {
    sl.startSession("Barn");
    for (const msg of [
      "2500 Hz on lead_vox → notch",
      "2480 Hz on lead_vox → notch",
      "2510 Hz on lead_vox → notch",
      "180 Hz on bass → notch",
    ]) {
      sl.logEvent({ time: "", kind: "feedback", ch: null, role: null, msg });
    }
    await sl.flush();
    sl.startSession("Barn");
    sl.logEvent({ time: "", kind: "feedback", ch: null, role: null, msg: "2495 Hz on lead → notch" });
    await sl.flush();
    const m = buildModel(sl, "Barn");
    assert.equal(m.shows, 2);
    assert.ok(m.confidence > 0);
    const top = m.feedback_freqs[0]!;
    assert.ok(top.hz >= 2400 && top.hz <= 2600);
    assert.ok(top.count >= 4);
    assert.ok(m.feedback_freqs.some((f) => f.hz >= 120 && f.hz <= 220));
  } finally {
    sl.close();
  }
});

test("buildModel with no feedback", () => {
  const sl = new SessionLog(":memory:");
  try {
    const m = buildModel(sl, "Empty");
    assert.deepEqual(m.feedback_freqs, []);
    assert.equal(m.confidence, 0);
  } finally {
    sl.close();
  }
});

test("watchFreqs respects min count", () => {
  const m = model({
    feedback_freqs: [
      { hz: 2500, count: 4 },
      { hz: 180, count: 1 },
    ],
  });
  assert.deepEqual(watchFreqs(m, 2), [2500]);
});

test("slug", () => {
  assert.equal(slug("The Cellar!"), "the-cellar");
  assert.equal(slug(""), "venue");
});

test("save and load round trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "trio-venue-"));
  try {
    const store = new VenueStore(join(dir, "nested", "venues"));
    const m = model({ venue: "The Barn", shows: 3, feedback_freqs: [{ hz: 2500, count: 5 }], confidence: 1 });
    const path = store.save(m);
    assert.ok(existsSync(path));
    assert.ok(path.endsWith("the-barn.json"));
    const m2 = store.load("The Barn");
    assert.equal(m2!.shows, 3);
    assert.equal(m2!.feedback_freqs[0]!.hz, 2500);
    assert.equal(store.load("Unknown Place"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("load tolerates damaged files and fills defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "trio-venue-"));
  try {
    const store = new VenueStore(dir);
    writeFileSync(join(dir, "a.json"), "{not json");
    assert.equal(store.load("a"), null);
    writeFileSync(join(dir, "b.json"), "[1]");
    assert.equal(store.load("b"), null);
    writeFileSync(join(dir, "c.json"), '{"shows": "x"}');
    assert.equal(store.load("c"), null);
    writeFileSync(join(dir, "d.json"), '{"shows": "4", "confidence": 1, "feedback_freqs": null}');
    assert.equal(store.load("d"), null);
    writeFileSync(join(dir, "e.json"), "{}");
    assert.deepEqual(store.load("e"), model({ venue: "e" }));
    writeFileSync(join(dir, "f.json"), '{"venue": "F!", "shows": 2.9, "confidence": "0.5"}');
    assert.deepEqual(store.load("f"), model({ venue: "F!", shows: 2, confidence: 0.5 }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saved files are byte-identical to the recorded files", () => {
  const dir = mkdtempSync(join(tmpdir(), "trio-venue-"));
  try {
    const store = new VenueStore(dir);
    for (const rec of fx.model_json) {
      const path = store.save(rec.model as VenueModel);
      assert.equal(path, join(dir, rec.file));
      assert.equal(readFileSync(path, "utf8"), rec.text);
      assert.deepEqual(store.load((rec.model as VenueModel).venue), rec.model);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
