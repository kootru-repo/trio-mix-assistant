import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { entryFor } from "../src/host/exe.ts";
import { findLayout } from "../src/host/layout.ts";
import { withEmulatorPorts } from "./emulatorports.ts";
import { AUDIO_PARTS, buildExe, buildManifest, nodeIsNewEnough, stageAudio } from "../tools/sea.ts";

interface Manifest {
  id: string;
  files: { path: string; sha256: string }[];
}

interface Boot {
  NAME: string;
  chooseHome(exeDir: string, base: string): string;
  quietExperimentalWarnings(proc: { emitWarning: (...args: unknown[]) => void }): void;
  safeRelative(rel: unknown): boolean;
  seedHome(home: string, root: string): void;
  sha256(data: Uint8Array | string): string;
  shouldHold(code: number, argv: readonly string[], interactive: boolean): boolean;
  unpack(manifest: Manifest, readAsset: (rel: string) => Uint8Array, root: string): number;
  userBase(env: Record<string, string | undefined>, platform: string, home: string): string;
}

const boot: Boot = createRequire(import.meta.url)("../tools/sea-boot.cts");
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const withDir = async (fn: (dir: string) => void | Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "trio-exe-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
};

test("no arguments and the launcher flags go to the launcher, anything else to the app", () => {
  assert.equal(entryFor([]), "launch");
  assert.equal(entryFor(["--rehearse"]), "launch");
  assert.equal(entryFor(["--list-devices"]), "launch");
  assert.equal(entryFor(["--emulate", "--lan", "--pin", "246810"]), "run");
  assert.equal(entryFor(["--help"]), "run");
  assert.equal(entryFor(["--rehearse", "--port", "9000"]), "run");
});

test("the settings folder can be set apart from the shipped files", () =>
  withDir((dir) => {
    mkdirSync(join(dir, "ship", "static"), { recursive: true });
    writeFileSync(join(dir, "ship", "static", "index.html"), "x");
    mkdirSync(join(dir, "ship", "js", "host"), { recursive: true });
    const plain = findLayout(join(dir, "ship", "js", "host"), undefined);
    assert.equal(plain.appDir, join(dir, "ship"));
    const split = findLayout(join(dir, "ship", "js", "host"), join(dir, "home"));
    assert.equal(split.appDir, join(dir, "home"));
    assert.equal(split.staticDir, join(dir, "ship", "static"));
    assert.equal(split.scnPath, join(dir, "ship", "x32_default_nodes.scn"));
    assert.equal(findLayout(join(dir, "ship", "js", "host"), "  ").appDir, join(dir, "ship"));
  }));

test("unpacking writes every file, skips what is intact and repairs what was changed", () =>
  withDir((dir) => {
    const assets: Record<string, string> = { "js/a.js": "alpha", "static/index.html": "<p>hi</p>" };
    const manifest: Manifest = { id: "t", files: Object.entries(assets).map(([path, v]) => ({ path, sha256: sha(v) })) };
    let reads = 0;
    const read = (rel: string): Uint8Array => {
      reads += 1;
      return Buffer.from(assets[rel]!);
    };
    assert.equal(boot.unpack(manifest, read, dir), 2);
    assert.equal(readFileSync(join(dir, "js", "a.js"), "utf8"), "alpha");
    assert.equal(boot.unpack(manifest, read, dir), 0);
    assert.equal(reads, 2, "intact files must not be read from the executable again");
    writeFileSync(join(dir, "js", "a.js"), "tampered");
    assert.equal(boot.unpack(manifest, read, dir), 1);
    assert.equal(readFileSync(join(dir, "js", "a.js"), "utf8"), "alpha");
    assert.deepEqual(
      readdirSync(join(dir, "js")).filter((n) => n.endsWith(".tmp")),
      [],
    );
  }));

test("unpacking refuses paths that leave the folder and data that does not match its hash", () =>
  withDir((dir) => {
    const read = (): Uint8Array => Buffer.from("x");
    for (const bad of ["../evil.js", "/abs.js", "C:/x.js", "a/../../b.js", "a\\b.js", "", "a//b.js", "./a.js"]) {
      assert.equal(boot.safeRelative(bad), false, bad);
      assert.throws(() => boot.unpack({ id: "t", files: [{ path: bad, sha256: sha("x") }] }, read, dir), /unsafe path/);
    }
    assert.equal(boot.safeRelative("js/host/main.js"), true);
    assert.throws(() => boot.unpack({ id: "t", files: [{ path: "a.js", sha256: sha("other") }] }, read, dir), /damaged/);
    assert.equal(existsSync(join(dir, "a.js")), false);
  }));

test("the per-user folder follows each platform's convention", () => {
  assert.equal(boot.userBase({ LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }, "win32", "C:\\Users\\x"), join("C:\\Users\\x\\AppData\\Local", boot.NAME));
  assert.equal(boot.userBase({}, "win32", "C:\\Users\\x"), join("C:\\Users\\x", "AppData", "Local", boot.NAME));
  assert.equal(boot.userBase({}, "darwin", "/Users/x"), join("/Users/x", "Library", "Application Support", boot.NAME));
  assert.equal(boot.userBase({ XDG_DATA_HOME: "/data" }, "linux", "/home/x"), join("/data", boot.NAME));
  assert.equal(boot.userBase({}, "linux", "/home/x"), join("/home/x", ".local", "share", boot.NAME));
});

test("settings live in the per-user folder unless a show.conf sits beside the executable", () =>
  withDir((dir) => {
    const exeDir = join(dir, "exe");
    const base = join(dir, "base");
    mkdirSync(exeDir);
    assert.equal(boot.chooseHome(exeDir, base), base);
    writeFileSync(join(exeDir, "show.conf"), "MODE=sim\n");
    assert.equal(boot.chooseHome(exeDir, base), exeDir);
  }));

test("first run copies the default settings and never overwrites the user's own", () =>
  withDir((dir) => {
    const root = join(dir, "root");
    const home = join(dir, "home");
    mkdirSync(join(root, "templates"), { recursive: true });
    writeFileSync(join(root, "show.conf"), "MODE=sim\n");
    writeFileSync(join(root, "templates", "set.json"), "{}");
    boot.seedHome(home, root);
    assert.equal(readFileSync(join(home, "show.conf"), "utf8"), "MODE=sim\n");
    assert.ok(existsSync(join(home, "templates", "set.json")));
    writeFileSync(join(home, "show.conf"), "MODE=hardware\n");
    boot.seedHome(home, root);
    assert.equal(readFileSync(join(home, "show.conf"), "utf8"), "MODE=hardware\n");
  }));

test("experimental-feature warnings are silenced and every other warning still gets through", () => {
  const seen: unknown[] = [];
  const proc = { emitWarning: (...args: unknown[]): void => void seen.push(args[0]) };
  boot.quietExperimentalWarnings(proc);
  proc.emitWarning("SQLite is experimental", "ExperimentalWarning");
  proc.emitWarning("typed", { type: "ExperimentalWarning" });
  proc.emitWarning(Object.assign(new Error("named"), { name: "ExperimentalWarning" }));
  proc.emitWarning("a real problem", "DeprecationWarning");
  proc.emitWarning("plain");
  assert.deepEqual(seen, ["a real problem", "plain"]);
});

test("the window is held open only for a failed double-click start in a console", () => {
  assert.equal(boot.shouldHold(2, [], true), true);
  assert.equal(boot.shouldHold(0, [], true), false);
  assert.equal(boot.shouldHold(2, ["--port", "x"], true), false);
  assert.equal(boot.shouldHold(2, [], false), false);
});

test("the build refuses a Node.js that is too old", () => {
  assert.equal(nodeIsNewEnough("22.12.0"), false);
  assert.equal(nodeIsNewEnough("22.13.0"), true);
  assert.equal(nodeIsNewEnough("20.19.0"), false);
  assert.equal(nodeIsNewEnough("24.0.0"), true);
});

test("the manifest lists the app files with hashes and leaves the start scripts out", () =>
  withDir((dir) => {
    mkdirSync(join(dir, "js"));
    writeFileSync(join(dir, "js", "a.js"), "alpha");
    writeFileSync(join(dir, "start.bat"), "x");
    writeFileSync(join(dir, "start.command"), "x");
    writeFileSync(join(dir, "START-HERE.txt"), "x");
    writeFileSync(join(dir, "README.md"), "x");
    writeFileSync(join(dir, "show.conf"), "MODE=sim\n");
    const m = buildManifest(dir);
    assert.deepEqual(
      m.files.map((f) => f.path),
      ["js/a.js", "show.conf"],
    );
    assert.equal(m.files[0]!.sha256, sha("alpha"));
    assert.match(m.id, /^[0-9a-f]{16}$/);
    writeFileSync(join(dir, "js", "a.js"), "beta");
    assert.notEqual(buildManifest(dir).id, m.id);
  }));

test("the build stops when the audio module is missing or was never compiled, rather than making an app that cannot listen", () =>
  withDir((dir) => {
    const modules = join(dir, "node_modules");
    const out = join(dir, "out");
    mkdirSync(out);
    assert.throws(() => stageAudio(modules, out), /not installed, so the app would not be able to listen/);
    for (const part of AUDIO_PARTS) {
      mkdirSync(join(modules, part.name), { recursive: true });
      for (const f of [...part.files, part.licence]) writeFileSync(join(modules, part.name, f), "x");
    }
    assert.throws(() => stageAudio(modules, out), /never compiled/);
  }));

interface ListeningState {
  capture: { link?: string; dead?: boolean };
  room: { level_db: number };
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const registerIf = (condition: boolean, name: string, body: () => Promise<void>): void => {
  if (condition) test(name, { timeout: 300000 }, body);
};

registerIf(process.platform === "win32" || process.platform === "darwin", "the built executable starts from an empty folder without Node.js on the path and serves the dashboard", () =>
  withDir(async (dir) => {
    const built = await buildExe(join(dir, "out"));
    assert.ok(built.files > 50);
    assert.ok(readFileSync(built.notice, "utf8").includes("Node.js"));
    const exeDir = join(dir, "Downloads");
    mkdirSync(exeDir);
    const windows = process.platform === "win32";
    const exeName = basename(built.exe);
    const exe = join(exeDir, exeName);
    copyFileSync(built.exe, exe);
    if (!windows) chmodSync(exe, 0o755);
    const profile = join(dir, "profile");
    mkdirSync(profile);
    const local = windows ? join(dir, "LocalAppData") : join(profile, "Library", "Application Support");
    const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
    const port = await freePort();
    const exeEnv: Record<string, string> = windows
      ? { SystemRoot: systemRoot, PATH: join(systemRoot, "System32"), LOCALAPPDATA: local, USERPROFILE: profile, TEMP: dir, TMP: dir }
      : { PATH: "/usr/bin:/bin", HOME: profile, TMPDIR: dir };
    const child = spawn(exe, ["--port", String(port), "--session-db", "off"], { cwd: exeDir, env: exeEnv });
    let text = "";
    child.stdout.on("data", (b: Buffer) => (text += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (text += b.toString("utf8")));
    try {
      for (let i = 0; i < 300 && !text.includes("Press Ctrl+C") && child.exitCode === null; i++) await sleep(100);
      assert.ok(text.includes("Press Ctrl+C"), text);
      assert.ok(!text.includes("ExperimentalWarning"), text);
      const home = join(local, "TrioMixAssistant");
      assert.ok(text.includes(home), "the settings folder should be printed");
      const page = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(page.status, 200);
      assert.ok((await page.text()).includes("/dashboard.js"));
      const state = (await (await fetch(`http://127.0.0.1:${port}/state`)).json()) as { mode: string };
      assert.equal(state.mode, "simulation");
      assert.ok(existsSync(join(home, "show.conf")));
      assert.deepEqual(readdirSync(exeDir), [exeName]);
      const runtime = join(home, "runtime", built.id, "node_modules");
      for (const part of AUDIO_PARTS) assert.ok(existsSync(join(runtime, part.name, "LICENSE")), part.name);
      assert.ok(existsSync(join(runtime, "naudiodon2", "PORTAUDIO-LICENSE.txt")));
      const listed = spawnSync(exe, ["--list-devices"], { cwd: exeDir, env: exeEnv, encoding: "utf8", timeout: 60000 });
      assert.equal(listed.status, 0, listed.stdout + listed.stderr);
      assert.ok(listed.stdout.includes("Input devices:"), "the audio module must load inside the executable: " + listed.stdout + listed.stderr);
      await withEmulatorPorts(async () => {
        const emuPort = await freePort();
        const emu = spawn(exe, ["--emulate", "--port", String(emuPort), "--session-db", "off", "--no-show-clock"], { cwd: exeDir, env: exeEnv });
        let emuText = "";
        emu.stdout.on("data", (b: Buffer) => (emuText += b.toString("utf8")));
        emu.stderr.on("data", (b: Buffer) => (emuText += b.toString("utf8")));
        try {
          for (let i = 0; i < 300 && !emuText.includes("Press Ctrl+C") && emu.exitCode === null; i++) await sleep(100);
          assert.ok(emuText.includes("Press Ctrl+C"), emuText);
          const read = async (): Promise<ListeningState> => (await (await fetch(`http://127.0.0.1:${emuPort}/state`)).json()) as ListeningState;
          let snap = await read();
          for (let i = 0; i < 60 && !(snap.capture.link === "open" && snap.room.level_db > -80); i++) {
            await sleep(250);
            snap = await read();
          }
          assert.equal(snap.capture.link, "open", "the audio thread must start inside the executable");
          assert.equal(snap.capture.dead, false);
          assert.ok(snap.room.level_db > -80, `analysed audio must reach the engine (room ${snap.room.level_db} dB)`);
        } finally {
          await new Promise<void>((res) => {
            if (emu.exitCode !== null) return res();
            emu.once("exit", () => res());
            emu.kill();
          });
          await sleep(300);
        }
      });
      assert.deepEqual(readdirSync(exeDir), [exeName]);
    } finally {
      await new Promise<void>((res) => {
        if (child.exitCode !== null) return res();
        child.once("exit", () => res());
        child.kill();
      });
      await sleep(300);
    }
  }),
);
