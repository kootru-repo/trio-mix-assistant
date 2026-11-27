import assert from "node:assert/strict";
import test from "node:test";
import { applyChannelMap, defaultConfig } from "../src/core/config.ts";
import { defaultTemplate } from "../src/core/template.ts";

test("the demo template loads with a small channel map and keeps only balance levels for channels in it", () => {
  const cfg = defaultConfig();
  applyChannelMap({ map: { "1": "lead_vocal", "2": "acoustic_gtr", "3": "bass" } }, cfg);
  const t = defaultTemplate(cfg);
  assert.deepEqual(
    t.songs.map((s) => s.name),
    ["Gravity", "Bloom", "Wildflower", "Tide"],
  );
  const bloom = t.songs.find((s) => s.name === "Bloom");
  assert.deepEqual([...(bloom?.balance.keys() ?? [])], []);
  assert.equal(bloom?.leadTarget, -7);
});

test("with the full channel map the demo template keeps its balance levels", () => {
  const t = defaultTemplate(defaultConfig());
  const bloom = t.songs.find((s) => s.name === "Bloom");
  assert.deepEqual(
    [...(bloom?.balance.entries() ?? [])],
    [
      [5, -21],
      [7, -26],
    ],
  );
});
