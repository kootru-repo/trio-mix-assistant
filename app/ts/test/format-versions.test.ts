import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/core/config.ts";
import { TEMPLATE_VERSION, TemplateError, fromObject, migrateTemplate } from "../src/core/template.ts";
import { CONF_VERSION, checkConf } from "../src/host/launcher.ts";

const APP = join(import.meta.dirname, "..", "..");

test("the shipped show.conf loads unchanged, with no notes and no version key", () => {
  const text = readFileSync(join(APP, "show.conf"), "utf8");
  const r = checkConf(text);
  assert.deepEqual(r.notes, []);
  assert.equal(r.version, CONF_VERSION);
  assert.equal(r.conf["MODE"], "sim");
});

test("show.conf notes: a misspelt key gets a suggestion, duplicates and malformed lines are reported, nothing throws", () => {
  const r = checkConf(
    [
      "MODE=sim",
      "CONSLE_IP=10.0.0.2",
      "LAN=no",
      "LAN=yes",
      "just some words",
      "VENU=Hall",
      "TUNE.feedback.ringDb=10",
      "BOGUS_THING=1",
    ].join("\n"),
  );
  assert.equal(r.conf["LAN"], "yes", "the last value wins, as before");
  assert.equal(r.conf["CONSLE_IP"], "10.0.0.2", "unknown keys are kept, never dropped");
  const all = r.notes.join("\n");
  assert.match(all, /CONSLE_IP.*did you mean CONSOLE_IP/);
  assert.match(all, /VENU.*did you mean VENUE/);
  assert.match(all, /BOGUS_THING.*not a setting/);
  assert.match(all, /LAN is set twice \(lines 3 and 4\)/);
  assert.match(all, /line 5.*no '='/);
  assert.doesNotMatch(all, /TUNE\./, "tuning keys are checked by the tuning allowlist, not here");
});

test("show.conf versions: blank means version 1, a newer one is noted, a broken one is noted, the file is never rewritten", () => {
  assert.equal(checkConf("MODE=sim").version, 1);
  const newer = checkConf(`CONF_VERSION=${CONF_VERSION + 1}\nMODE=sim`);
  assert.match(newer.notes.join("\n"), /written for a newer version/);
  assert.match(checkConf("CONF_VERSION=two").notes.join("\n"), /CONF_VERSION must be a whole number/);
  assert.deepEqual(checkConf(`CONF_VERSION=${CONF_VERSION}\nMODE=sim`).notes, []);
});

test("the shipped templates load unchanged, with no warnings and no version key", () => {
  const dir = join(APP, "templates");
  for (const n of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const d: unknown = JSON.parse(readFileSync(join(dir, n), "utf8"));
    const t = fromObject(d, defaultConfig());
    assert.deepEqual(t.warnings, [], n);
    assert.ok(t.songs.length > 0, n);
  }
});

test("template keys: a typo like leadTarget is reported with the right name, and unknown keys never throw", () => {
  const t = fromObject(
    {
      name: "Set",
      colour: "blue",
      songs: [
        { name: "A", leadTarget: -6, scene: 1 },
        { name: "B", balanse: {} },
      ],
      channels: { map: { "1": "lead" }, lead: 1, measMic: 1 },
    },
    defaultConfig(),
  );
  const all = t.warnings.join("\n");
  assert.match(all, /songs\[0\]\.leadTarget.*did you mean lead_target/);
  assert.match(all, /songs\[1\]\.balanse.*did you mean balance/);
  assert.match(all, /channels\.measMic.*did you mean meas_mic/);
  assert.match(all, /colour.*not a template setting/);
  assert.equal(t.songs[0]!.leadTarget, null, "the typo is not guessed into the setting");
});

test("template versions: missing is 1, the current one loads quietly, a newer one is a warning, a broken one is refused", () => {
  assert.equal(migrateTemplate({ songs: [] }).version, 1);
  assert.deepEqual(fromObject({ version: TEMPLATE_VERSION, songs: [{ name: "A" }] }, defaultConfig()).warnings, []);
  assert.match(fromObject({ version: TEMPLATE_VERSION + 1, songs: [] }, defaultConfig()).warnings.join("\n"), /newer version/);
  assert.throws(() => fromObject({ version: "one", songs: [] }, defaultConfig()), TemplateError);
  assert.throws(() => fromObject({ version: 0, songs: [] }, defaultConfig()), TemplateError);
});

test("template channel numbers must be real console channels, 1 to 32", () => {
  for (const ch of ["0", "-1", "33", "4000"]) {
    assert.throws(() => fromObject({ channels: { map: { [ch]: "x" } }, songs: [] }, defaultConfig()), TemplateError, ch);
  }
  assert.equal(fromObject({ channels: { map: { "32": "x" } }, songs: [] }, defaultConfig()).channels?.map?.["32"], "x");
});
