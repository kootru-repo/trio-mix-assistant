import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SCRIPTS, buildPackage } from "../tools/package.ts";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

test("the package holds the compiled app, the dashboard and start scripts, and it runs", async () => {
  const out = mkdtempSync(join(tmpdir(), "pkg-"));
  try {
    const r = buildPackage(out);
    for (const f of ["js/host/main.js", "js/host/launch.js", "js/core/engine/core.js", "static/index.html", "static/dashboard.js", "x32_default_nodes.scn", "show.conf", "package.json", "START-HERE.txt", ...Object.keys(SCRIPTS)]) {
      assert.ok(existsSync(join(r.folder, f)), `missing ${f}`);
    }
    assert.ok(!existsSync(join(r.folder, "js", "host", "main.ts")));
    assert.ok(readFileSync(join(r.folder, "start.bat"), "utf8").includes("js\\host\\launch.js"));
    assert.ok(existsSync(r.zip));
    assert.ok(r.files > 50);
    const head = readFileSync(r.zip).subarray(0, 4).toString("hex");
    assert.equal(head, "504b0304");
    const listing = spawnSync("tar", ["-tf", r.zip], { encoding: "utf8" });
    if (listing.status === 0) {
      assert.ok(listing.stdout.includes("TrioMixAssistant/js/host/main.js"));
      assert.ok(listing.stdout.includes("TrioMixAssistant/static/index.html"));
    }

    const port = await freePort();
    const child = spawn(process.execPath, ["js/host/main.js", "--port", String(port), "--session-db", "off"], { cwd: r.folder });
    let text = "";
    child.stdout.on("data", (b: Buffer) => (text += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (text += b.toString("utf8")));
    try {
      for (let i = 0; i < 100 && !text.includes("Press Ctrl+C"); i++) await new Promise((res) => setTimeout(res, 100));
      assert.ok(text.includes("SIMULATION"), text);
      const page = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(page.status, 200);
      assert.ok((await page.text()).includes("/dashboard.js"));
      const state = await (await fetch(`http://127.0.0.1:${port}/state`)).json();
      assert.equal((state as { mode: string }).mode, "simulation");
    } finally {
      await new Promise<void>((res) => {
        child.once("exit", () => res());
        child.kill();
      });
    }
  } finally {
    rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
