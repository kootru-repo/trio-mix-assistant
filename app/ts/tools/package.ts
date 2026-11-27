import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const tsDir = resolve(here, "..");
const appDir = resolve(tsDir, "..");

export const NAME = "TrioMixAssistant";

const DOCS = ["show.conf", "RUNBOOK.md", "HARDWARE_BRINGUP.md", "HARDWARE_SETUP.md", "README.md"];

const NODE_CHECK_BAT =
  "node -e \"var v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=13)?0:1)\" >nul 2>nul || (\r\n" +
  "  echo Node.js 22.13 or newer is needed. Install it from https://nodejs.org/ and run this again.\r\n" +
  "  pause\r\n" +
  "  exit /b 1\r\n" +
  ")\r\n";

const NODE_CHECK_SH =
  "if ! command -v node >/dev/null 2>&1 || ! node -e \"var v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=13)?0:1)\"; then\n" +
  '  echo "Node.js 22.13 or newer is needed. Install it from https://nodejs.org/ (or: brew install node) and run this again."\n' +
  "  exit 1\n" +
  "fi\n";

const bat = (body: string): string => `@echo off\r\ncd /d "%~dp0"\r\n${NODE_CHECK_BAT}${body}pause\r\n`;
const sh = (body: string): string => `#!/bin/bash\ncd "$(dirname "$0")"\n${NODE_CHECK_SH}${body}`;

export const SCRIPTS: Record<string, string> = {
  "start.bat": bat("node --no-warnings js\\host\\launch.js\r\n"),
  "rehearse.bat": bat(
    "echo Running the FULL app against a simulated console (no hardware needed)...\r\nnode --no-warnings js\\host\\launch.js --rehearse\r\n",
  ),
  "list-devices.bat": bat("node --no-warnings js\\host\\launch.js --list-devices\r\n"),
  "start.command": sh("node --no-warnings js/host/launch.js\n"),
  "rehearse.command": sh("node --no-warnings js/host/launch.js --rehearse\n"),
  "list-devices.command": sh("node --no-warnings js/host/launch.js --list-devices\n"),
};

function crcOf(buf: Buffer): number {
  return crc32(buf);
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function zipFolder(folder: string, zipPath: string, prefix: string): number {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const data = readFileSync(full);
      const packed = deflateRawSync(data);
      const stored = packed.length < data.length;
      const body = stored ? packed : data;
      const entryName = Buffer.from((prefix + "/" + relative(folder, full)).replace(/\\/g, "/"), "utf8");
      const { time, date } = dosTime(statSync(full).mtime);
      const crc = crcOf(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(stored ? 8 : 0, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(entryName.length, 26);
      parts.push(local, entryName, body);
      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0);
      const executable = entryName.toString("utf8").endsWith(".command");
      cen.writeUInt16LE(executable ? 0x031e : 20, 4);
      cen.writeUInt16LE(20, 6);
      cen.writeUInt16LE(0x0800, 8);
      cen.writeUInt16LE(stored ? 8 : 0, 10);
      cen.writeUInt16LE(time, 12);
      cen.writeUInt16LE(date, 14);
      cen.writeUInt32LE(crc, 16);
      cen.writeUInt32LE(body.length, 20);
      cen.writeUInt32LE(data.length, 24);
      cen.writeUInt16LE(entryName.length, 28);
      cen.writeUInt32LE(executable ? (0o100755 << 16) >>> 0 : 0, 38);
      cen.writeUInt32LE(offset, 42);
      central.push(cen, entryName);
      offset += local.length + entryName.length + body.length;
      count += 1;
    }
  };
  walk(folder);
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(zipPath, Buffer.concat([...parts, centralBuf, end]));
  return count;
}

export interface PackageResult {
  folder: string;
  zip: string;
  files: number;
}

export function buildCommit(): string | null {
  const given = process.env["TRIO_MIX_COMMIT"];
  if (given) return given.slice(0, 12);
  const head = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: tsDir, encoding: "utf8" });
  if (head.status !== 0 || !head.stdout.trim()) return null;
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: tsDir, encoding: "utf8" });
  return head.stdout.trim() + (dirty.status === 0 && dirty.stdout.trim() ? ".dirty" : "");
}

export function buildPackage(outDir: string): PackageResult {
  const dest = join(outDir, NAME);
  mkdirSync(outDir, { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const build = spawnSync(
    process.execPath,
    [join(tsDir, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json", "--outDir", join(dest, "js")],
    {
      cwd: tsDir,
      encoding: "utf8",
    },
  );
  if (build.status !== 0) throw new Error("build failed:\n" + build.stdout + build.stderr);
  const own: unknown = JSON.parse(readFileSync(join(tsDir, "package.json"), "utf8"));
  const version = typeof own === "object" && own !== null ? String(Reflect.get(own, "version") ?? "unknown") : "unknown";
  writeFileSync(
    join(dest, "package.json"),
    JSON.stringify({ name: "trio-mix-assistant", private: true, type: "module", version, commit: buildCommit() }, null, 2) + "\n",
  );
  cpSync(join(appDir, "static"), join(dest, "static"), { recursive: true });
  cpSync(join(appDir, "x32_default_nodes.scn"), join(dest, "x32_default_nodes.scn"));
  if (existsSync(join(appDir, "templates"))) cpSync(join(appDir, "templates"), join(dest, "templates"), { recursive: true });
  for (const f of DOCS) if (existsSync(join(appDir, f))) cpSync(join(appDir, f), join(dest, f));
  for (const [name, text] of Object.entries(SCRIPTS))
    writeFileSync(join(dest, name), text, { mode: name.endsWith(".command") ? 0o755 : 0o644 });
  cpSync(join(appDir, "START-HERE.txt"), join(dest, "START-HERE.txt"));
  const zip = join(outDir, NAME + ".zip");
  rmSync(zip, { force: true });
  const files = zipFolder(dest, zip, NAME);
  return { folder: dest, zip, files };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const r = buildPackage(join(tsDir, "dist", "package"));
  console.log(`Package folder : ${r.folder}`);
  console.log(`Zip            : ${r.zip}`);
  console.log(`Files          : ${r.files}`);
}
