import assert from "node:assert/strict";
import test from "node:test";
import { configWith, defaultConfig } from "../src/core/config.ts";
import { TemplateError, defaultTemplate, fromObject } from "../src/core/template.ts";

const testCfg = defaultConfig();

const channelsOf = (): string => JSON.stringify([...testCfg.CHANNELS]);

test("a template without a channel map checks balance channels against the injected config", () => {
  const before = channelsOf();
  const cfg = configWith({
    CHANNELS: new Map([
      [1, "a"],
      [42, "b"],
    ]),
  });
  const spec = { songs: [{ name: "A", balance: { "42": -10 } }] };
  assert.equal(fromObject(spec, cfg).songs[0]!.balance.get(42), -10);
  assert.throws(() => fromObject(spec, testCfg), TemplateError);
  assert.throws(() => fromObject({ songs: [{ name: "A", balance: { "5": -10 } }] }, cfg), TemplateError);
  assert.equal(channelsOf(), before);
});

test("the default template is checked against the injected config", () => {
  const before = channelsOf();
  assert.equal(defaultTemplate(testCfg).songs.length, 4);
  const small = defaultTemplate(configWith({ CHANNELS: new Map([[1, "a"]]) }));
  assert.deepEqual([...(small.songs.find((s) => s.name === "Bloom")?.balance.keys() ?? [])], []);
  assert.deepEqual(
    [
      ...(defaultTemplate(testCfg)
        .songs.find((s) => s.name === "Bloom")
        ?.balance.keys() ?? []),
    ],
    [5, 7],
  );
  assert.equal(channelsOf(), before);
});
