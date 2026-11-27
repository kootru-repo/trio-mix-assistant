import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/core/config.ts";
import { parseCliArgs } from "../src/host/args.ts";
import { Exit, showConfig } from "../src/host/main.ts";

const withTemplate = (body: unknown, run: (path: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "showcfg-"));
  try {
    const path = join(dir, "t.json");
    writeFileSync(path, JSON.stringify(body));
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("one config is built at start from the template's channel map and tuning, then --tune, which wins", () => {
  withTemplate(
    {
      name: "Bench",
      channels: { map: { "3": "lead_vox", "4": "meas_mic" }, lead: 3, meas_mic: 4 },
      tuning: { feedback: { ringDb: 10 }, clip: { peakDbfs: -2 } },
      songs: [{ name: "A", balance: { "3": -4 } }],
    },
    (path) => {
      const lines: string[] = [];
      const { cfg, template } = showConfig(parseCliArgs(["--template", path, "--tune", "feedback.ringDb=14"]), {
        out: (l) => lines.push(l),
      });
      assert.equal(template.name, "Bench");
      assert.deepEqual(
        [...cfg.CHANNELS],
        [
          [3, "lead_vox"],
          [4, "meas_mic"],
        ],
      );
      assert.equal(cfg.LEAD_VOCAL_CH, 3);
      assert.equal(cfg.MEAS_MIC_CH, 4);
      assert.equal(cfg.feedback.ringDb, 14);
      assert.equal(cfg.clip.peakDbfs, -2);
      assert.ok(Object.isFrozen(cfg.feedback));
      assert.deepEqual(
        cfg.TUNED.map((o) => [o.path, o.value, o.source]),
        [
          ["feedback.ringDb", 10, "template 'Bench'"],
          ["clip.peakDbfs", -2, "template 'Bench'"],
          ["feedback.ringDb", 14, "show.conf or --tune"],
        ],
      );
      assert.ok(lines.includes("  Channel map: 2 channels from template 'Bench'"), lines.join("\n"));
      assert.ok(lines.includes("  Tuning changed from the defaults:"), lines.join("\n"));
      assert.ok(
        lines.some((l) => l.includes("feedback.ringDb = 14 (default 12, from show.conf or --tune)")),
        lines.join("\n"),
      );
      assert.equal(defaultConfig().CHANNELS.size, 8);
    },
  );
});

test("with no template or tuning the start config is the default one, and a bad tuning stops the start", () => {
  const { cfg } = showConfig(parseCliArgs([]), { out: () => undefined });
  const d = defaultConfig();
  assert.deepEqual([...cfg.CHANNELS], [...d.CHANNELS]);
  assert.deepEqual({ ...cfg.feedback }, { ...d.feedback });
  assert.deepEqual(cfg.TUNED, []);
  withTemplate({ tuning: { room: { quietDb: -20, loudDb: -30 } } }, (path) => {
    const lines: string[] = [];
    assert.throws(
      () => showConfig(parseCliArgs(["--template", path]), { out: (l) => lines.push(l) }),
      (e: unknown) => e instanceof Exit && e.code === 2,
    );
    assert.match(lines.join("\n"), /tuning: room\.quietDb/);
  });
});
