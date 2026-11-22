import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NAME, buildPackage } from "./package.ts";

const here = dirname(fileURLToPath(import.meta.url));
const tsDir = resolve(here, "..");

const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const LOADER = "module.exports = (specifier) => import(specifier);\n";
const LEFT_OUT = /\.(bat|command)$|^START-HERE\.txt$|\.md$/;
const NATIVE_BINARY = /\.(node|dll|dylib)$|\.so(\.\d+)*$/;
const AUDIO_CHECK =
  'const a = require(require("node:path").join(process.argv[1], "build", "Release", "naudiodon.node")); const d = a.getDevices(); if (!Array.isArray(d)) process.exit(3); process.stdout.write("ok " + d.length);';

interface AudioPart {
  name: string;
  files: string[];
  licence: string;
  binaries: boolean;
}

export const AUDIO_MODULE = "naudiodon2";
export const AUDIO_PARTS: readonly AudioPart[] = [
  { name: AUDIO_MODULE, files: ["package.json"], licence: "LICENSE", binaries: true },
];

export interface ExeResult {
  exe: string;
  notice: string;
  licenceDownloaded: boolean;
  id: string;
  files: number;
  bytes: number;
}

interface ManifestFile {
  path: string;
  sha256: string;
}

export function nodeIsNewEnough(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

function listFiles(folder: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(folder, full).replace(/\\/g, "/"));
    }
  };
  walk(folder);
  return out;
}

export function buildManifest(folder: string): { id: string; files: ManifestFile[] } {
  const files = listFiles(folder)
    .filter((p) => !LEFT_OUT.test(p))
    .map((p) => ({ path: p, sha256: createHash("sha256").update(readFileSync(join(folder, p))).digest("hex") }));
  const id = createHash("sha256")
    .update(files.map((f) => `${f.path}\n${f.sha256}\n`).join(""))
    .digest("hex")
    .slice(0, 16);
  return { id, files };
}

function leadingComment(file: string): string {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const end = text.indexOf("*/");
  return end < 0 ? "" : text.slice(0, end + 2) + "\n";
}

export function stageAudio(modulesDir: string, folder: string): number {
  if (!existsSync(join(modulesDir, AUDIO_MODULE, "package.json"))) {
    throw new Error(
      `the audio module '${AUDIO_MODULE}' is not installed, so the app would not be able to listen. Run "npm install" (it needs a C++ compiler) and build again.`,
    );
  }
  let copied = 0;
  const copy = (from: string, to: string): void => {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied += 1;
  };
  for (const part of AUDIO_PARTS) {
    const from = join(modulesDir, part.name);
    const to = join(folder, "node_modules", part.name);
    for (const f of part.files) copy(join(from, f), join(to, f));
    copy(join(from, part.licence), join(to, "LICENSE"));
    if (!part.binaries) continue;
    const release = join(from, "build", "Release");
    const binaries = existsSync(release) ? readdirSync(release).filter((n) => NATIVE_BINARY.test(n) && statSync(join(release, n)).isFile()) : [];
    if (!binaries.some((n) => n.endsWith(".node"))) throw new Error(`'${part.name}' is installed but was never compiled (no .node file in ${release})`);
    for (const n of binaries) copy(join(release, n), join(to, "build", "Release", n));
  }
  const portaudio = leadingComment(join(modulesDir, AUDIO_MODULE, "portaudio", "include", "portaudio.h"));
  if (!portaudio.includes("Permission is hereby granted")) throw new Error("the PortAudio licence text was not found in the audio module");
  writeFileSync(join(folder, "node_modules", AUDIO_MODULE, "PORTAUDIO-LICENSE.txt"), portaudio);
  const check = spawnSync(process.execPath, ["-e", AUDIO_CHECK, join(folder, "node_modules", AUDIO_MODULE)], { cwd: folder, encoding: "utf8" });
  if (check.status !== 0 || !check.stdout.includes("ok ")) {
    throw new Error(`the audio module does not load from the app folder, so the app would not be able to listen:\n${check.stdout}${check.stderr}`);
  }
  return copied + 1;
}

function runStep(label: string, args: string[], cwd: string): void {
  const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${label} failed:\n${r.stdout}${r.stderr}`);
}

async function nodeLicence(): Promise<{ text: string; downloaded: boolean }> {
  const version = process.versions.node;
  const url = `https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`;
  const head =
    `${NAME} contains the Node.js ${version} runtime, which is distributed under the licence below.\n` +
    `Source: https://github.com/nodejs/node/tree/v${version}\n\n`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { text: head + (await res.text()), downloaded: true };
  } catch {
    return { text: head + `The licence text could not be downloaded when this copy was built. Read it at:\n${url}\n`, downloaded: false };
  }
}

export async function buildExe(outDir: string): Promise<ExeResult> {
  if (!nodeIsNewEnough()) throw new Error(`Node.js 22.13 or newer is needed to build the app (this is ${process.versions.node})`);
  mkdirSync(outDir, { recursive: true });
  const stage = join(outDir, "stage");
  rmSync(stage, { recursive: true, force: true });
  const pkg = buildPackage(stage);
  rmSync(pkg.zip, { force: true });
  writeFileSync(join(pkg.folder, "load.cjs"), LOADER);
  stageAudio(join(tsDir, "node_modules"), pkg.folder);
  const manifest = buildManifest(pkg.folder);
  const manifestPath = join(stage, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const assets: Record<string, string> = { "manifest.json": manifestPath };
  for (const f of manifest.files) assets[f.path] = join(pkg.folder, f.path);
  const bootPath = join(stage, "boot.cjs");
  writeFileSync(bootPath, stripTypeScriptTypes(readFileSync(join(here, "sea-boot.cts"), "utf8")));
  const blob = join(stage, "app.blob");
  const config = join(stage, "sea-config.json");
  writeFileSync(
    config,
    JSON.stringify({
      main: bootPath,
      output: blob,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      assets,
    }),
  );
  runStep("preparing the app bundle", ["--experimental-sea-config", config], stage);

  const exe = join(outDir, process.platform === "win32" ? `${NAME}.exe` : NAME);
  rmSync(exe, { force: true });
  copyFileSync(process.execPath, exe);
  if (process.platform !== "win32") chmodSync(exe, 0o755);
  if (process.platform === "darwin") spawnSync("codesign", ["--remove-signature", exe]);
  const inject = [join(tsDir, "node_modules", "postject", "dist", "cli.js"), exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", FUSE];
  if (process.platform === "darwin") inject.push("--macho-segment-name", "NODE_SEA");
  runStep("writing the app into the executable", inject, stage);
  if (process.platform === "darwin") spawnSync("codesign", ["--sign", "-", exe]);

  const notice = join(outDir, "NODE-LICENSE.txt");
  const licence = await nodeLicence();
  writeFileSync(notice, licence.text);
  rmSync(stage, { recursive: true, force: true });
  return { exe, notice, licenceDownloaded: licence.downloaded, id: manifest.id, files: manifest.files.length, bytes: statSync(exe).size };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  buildExe(join(tsDir, "dist", "exe")).then(
    (r) => {
      console.log(`Built ${r.exe}`);
      console.log(`  ${(r.bytes / 1048576).toFixed(0)} MB, ${r.files} app files inside, build id ${r.id}`);
      console.log(`  Ship ${r.notice} with it.`);
      if (!r.licenceDownloaded) {
        console.log("  [!] The Node.js licence text could not be downloaded, so that file only links to it. Rebuild online before sharing the app.");
      }
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
