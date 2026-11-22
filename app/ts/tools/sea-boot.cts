const nodeCrypto: typeof import("node:crypto") = require("node:crypto");
const nodeFs: typeof import("node:fs") = require("node:fs");
const nodeModule: typeof import("node:module") = require("node:module");
const nodeOs: typeof import("node:os") = require("node:os");
const nodePath: typeof import("node:path") = require("node:path");
const nodeReadline: typeof import("node:readline") = require("node:readline");
const nodeSea: typeof import("node:sea") = require("node:sea");
const nodeUrl: typeof import("node:url") = require("node:url");

interface BootManifestFile {
  path: string;
  sha256: string;
}

interface BootManifest {
  id: string;
  files: BootManifestFile[];
}

interface WarningEmitter {
  emitWarning: (warning: unknown, ...rest: unknown[]) => void;
}

interface AppEntry {
  startFromExecutable(argv: readonly string[]): Promise<number>;
}

const APP_NAME = "TrioMixAssistant";
const SEED_FILES = ["show.conf"];
const SEED_DIRS = ["templates"];

function userBase(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  home: string = nodeOs.homedir(),
): string {
  const set = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";
  if (platform === "win32") {
    return nodePath.join(set(env["LOCALAPPDATA"]) ? env["LOCALAPPDATA"] : nodePath.join(home, "AppData", "Local"), APP_NAME);
  }
  if (platform === "darwin") return nodePath.join(home, "Library", "Application Support", APP_NAME);
  return nodePath.join(set(env["XDG_DATA_HOME"]) ? env["XDG_DATA_HOME"] : nodePath.join(home, ".local", "share"), APP_NAME);
}

function sha256(data: Uint8Array | string): string {
  return nodeCrypto.createHash("sha256").update(data).digest("hex");
}

function safeRelative(rel: unknown): rel is string {
  if (typeof rel !== "string" || rel === "" || rel.includes("\\") || rel.includes("\0")) return false;
  if (nodePath.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function matches(file: string, expected: string): boolean {
  try {
    return sha256(nodeFs.readFileSync(file)) === expected;
  } catch {
    return false;
  }
}

function unpack(manifest: BootManifest, readAsset: (rel: string) => ArrayBuffer | Uint8Array, root: string): number {
  let written = 0;
  for (const entry of manifest.files) {
    const rel: unknown = entry.path;
    if (!safeRelative(rel)) throw new Error(`unsafe path in the app manifest: ${String(rel)}`);
    const dest = nodePath.join(root, ...rel.split("/"));
    if (matches(dest, entry.sha256)) continue;
    const raw = readAsset(rel);
    const data = raw instanceof Uint8Array ? Buffer.from(raw) : Buffer.from(new Uint8Array(raw));
    if (sha256(data) !== entry.sha256) throw new Error(`the app file is damaged: ${rel}`);
    nodeFs.mkdirSync(nodePath.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.${nodeCrypto.randomBytes(4).toString("hex")}.tmp`;
    nodeFs.writeFileSync(tmp, data);
    try {
      nodeFs.renameSync(tmp, dest);
    } catch (err) {
      nodeFs.rmSync(tmp, { force: true });
      if (!matches(dest, entry.sha256)) throw err;
    }
    written += 1;
  }
  return written;
}

function chooseHome(exeDir: string, base: string): string {
  return nodeFs.existsSync(nodePath.join(exeDir, "show.conf")) ? exeDir : base;
}

function seedHome(home: string, root: string): void {
  nodeFs.mkdirSync(home, { recursive: true });
  for (const name of SEED_FILES) {
    const from = nodePath.join(root, name);
    const to = nodePath.join(home, name);
    if (nodeFs.existsSync(from) && !nodeFs.existsSync(to)) nodeFs.copyFileSync(from, to);
  }
  for (const name of SEED_DIRS) {
    const from = nodePath.join(root, name);
    const to = nodePath.join(home, name);
    if (nodeFs.existsSync(from)) nodeFs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
  }
}

function quietExperimentalWarnings(proc: WarningEmitter = process as WarningEmitter): void {
  const emit = proc.emitWarning;
  proc.emitWarning = function emitWarning(warning: unknown, ...rest: unknown[]): void {
    const first = rest[0];
    const type =
      typeof first === "string" ? first : typeof first === "object" && first !== null ? (first as { type?: unknown }).type : undefined;
    const name = typeof warning === "object" && warning !== null ? (warning as { name?: unknown }).name : undefined;
    if (type === "ExperimentalWarning" || name === "ExperimentalWarning") return;
    emit.call(proc, warning, ...rest);
  };
}

function shouldHold(code: number, argv: readonly string[], interactive: boolean): boolean {
  return code !== 0 && argv.length === 0 && interactive;
}

function holdWindow(): Promise<void> {
  return new Promise((resolve) => {
    const rl = nodeReadline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("\nPress Enter to close this window.", () => rl.close());
    rl.on("close", () => resolve());
  });
}

async function startApp(argv: readonly string[]): Promise<number> {
  quietExperimentalWarnings();
  const manifest: BootManifest = JSON.parse(nodeSea.getAsset("manifest.json", "utf8"));
  const base = userBase();
  const root = nodePath.join(base, "runtime", manifest.id);
  unpack(manifest, (rel) => nodeSea.getRawAsset(rel) as ArrayBuffer, root);
  const home = chooseHome(nodePath.dirname(process.execPath), base);
  seedHome(home, root);
  process.env["TRIO_MIX_HOME"] = home;
  process.env["TRIO_MIX_BUILD"] = manifest.id;
  const load: (specifier: string) => Promise<AppEntry> = nodeModule.createRequire(nodePath.join(root, "load.cjs"))("./load.cjs");
  const app = await load(nodeUrl.pathToFileURL(nodePath.join(root, "js", "host", "exe.js")).href);
  return app.startFromExecutable(argv);
}

if (nodeSea.isSea()) {
  const argv = process.argv.slice(2);
  startApp(argv)
    .catch((err: unknown) => {
      console.error("Could not start the app:", err instanceof Error ? err.message : err);
      return 1;
    })
    .then(async (code) => {
      if (shouldHold(code, argv, Boolean(process.stdin.isTTY && process.stdout.isTTY))) await holdWindow();
      process.exit(code);
    });
} else {
  module.exports = { NAME: APP_NAME, chooseHome, quietExperimentalWarnings, safeRelative, seedHome, sha256, shouldHold, unpack, userBase };
}
