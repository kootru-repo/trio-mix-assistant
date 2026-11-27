import assert from "node:assert/strict";
import test from "node:test";
import { ManualClock } from "../src/core/clock.ts";
import { applyChannelMap, configWith, copyConfig, defaultConfig } from "../src/core/config.ts";
import type { Config } from "../src/core/config.ts";
import { SimConsole } from "../src/core/console.ts";
import { Engine } from "../src/core/engine/index.ts";
import { fromObject } from "../src/core/template.ts";

function custom(): Config {
  const base = defaultConfig();
  const cfg = configWith({
    ride: Object.freeze({ ...base.ride, leadTargetMinDb: -20, leadTargetMaxDb: 3 }),
    limits: Object.freeze({ ...base.limits, faderMinDb: -30, faderMaxDb: 2 }),
    manual: Object.freeze({ ...base.manual, holdS: 42 }),
    unmask: Object.freeze({ ...base.unmask, freq: 2500 }),
    FX_BUSES: new Map([[3, "Plate"]]),
    CHANNEL_EQ_BANDS: 2,
    BLOCK: 512,
    DEFAULT_ENABLED: { ...base.DEFAULT_ENABLED, vocal_ride: true },
  });
  applyChannelMap(
    {
      map: { "2": "lead_vox", "4": "gtr_l", "5": "gtr_r", "9": "meas_mic" },
      labels: { gtr_l: "Guitar L", gtr_r: "Guitar R" },
      lead: 2,
      meas_mic: 9,
      balance: [4],
      stereo_links: [[4, 5]],
    },
    cfg,
  );
  return cfg;
}

const rows = (e: Engine): Record<string, unknown>[] => e.snapshot()["channels"] as Record<string, unknown>[];

test("the engine and everything it builds read the config it is given", () => {
  const cfg = custom();
  const e = new Engine({
    sim: true,
    clock: new ManualClock(100, 1_700_000_000),
    cfg,
    template: fromObject({ name: "Gig", songs: [{ name: "A", balance: { "4": -3 } }] }, cfg),
  });
  assert.equal(e.cfg, cfg);
  assert.equal(e.assistant.cfg, cfg);
  assert.ok(e.con instanceof SimConsole);
  assert.deepEqual(
    rows(e).map((r) => [r["ch"], r["label"], r["is_lead"], r["is_meas"], r["is_balance"]]),
    [
      [2, "Lead vocal", true, false, false],
      [4, "Guitar L", false, false, true],
      [5, "Guitar R", false, false, false],
      [9, "FOH meas mic", false, true, false],
    ],
  );
  const snap = e.snapshot();
  assert.equal(snap["block_ms"], 10.7);
  assert.deepEqual((snap["fx"] as { buses: Record<string, string> }).buses, { "3": "Plate" });
  assert.deepEqual(Object.keys((snap["eq"] as Record<string, unknown[]>)["2"] ?? {}).length, 2);
  assert.equal((snap["unmask"] as { freq: number }).freq, 2500);
  assert.equal(e.assistant.enabled["vocal_ride"], true);
  assert.equal(e.template.name, "Gig");
  assert.throws(() => fromObject({ songs: [{ name: "A", balance: { "9": -3 } }] }, defaultConfig()), /not in the channel map/);
  e.setFader(4, -10);
  assert.equal(e.assistant.faderDb.get(5), -10);
  assert.equal(e.assistant.manualHoldUntil.get(4), e.clock.monotonic() + 42);
  assert.equal(e.con.setFaderDb(4, -50), -30);
  e.setLeadTarget(9);
  assert.equal(e.assistant.leadTarget, 3);
  e.setSend(4, 3, -6);
  assert.ok(
    e.events.some((ev) => ev.msg === "gtr_l → Plate -6 dB"),
    JSON.stringify(e.events.slice(-3)),
  );
});

test("two engines with different configs do not see each other's settings", () => {
  const clock = new ManualClock(100, 1_700_000_000);
  const cfg = custom();
  const a = new Engine({ sim: true, clock, cfg, template: fromObject({}, cfg) });
  const b = new Engine({ sim: true, clock, cfg: defaultConfig() });
  assert.deepEqual(
    rows(a).map((r) => r["ch"]),
    [2, 4, 5, 9],
  );
  assert.deepEqual(
    rows(b).map((r) => r["ch"]),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  b.setFader(4, -10);
  assert.equal(b.assistant.faderDb.get(5), 0);
});

test("a copied config shares no maps or lists with the original, so changing the copy's channel map leaves the original alone", () => {
  const original = custom();
  const copy = copyConfig(original);
  assert.deepEqual(copy, original);
  assert.notEqual(copy.CHANNELS, original.CHANNELS);
  assert.notEqual(copy.STEREO_LINKS[0], original.STEREO_LINKS[0]);
  assert.notEqual(copy.DEFAULT_ENABLED, original.DEFAULT_ENABLED);
  applyChannelMap({ map: { "1": "meas_mic" }, stereo_links: [] }, copy);
  copy.DEFAULT_ENABLED["phase"] = true;
  assert.deepEqual([...original.CHANNELS.keys()], [2, 4, 5, 9]);
  assert.deepEqual(original.STEREO_LINKS, [[4, 5]]);
  assert.equal(original.DEFAULT_ENABLED["phase"], false);
});
