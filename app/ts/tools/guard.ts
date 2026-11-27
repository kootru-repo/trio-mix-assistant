import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(fileURLToPath(new URL("../..", import.meta.url)));

interface Rule {
  name: string;
  pattern: RegExp;
}

const RULES: readonly Rule[] = [
  { name: "a comment line (the project keeps code free of comments)", pattern: /^\s*(\/\/|\/\*)/ },
  { name: "a double cast through unknown", pattern: /\bas\s+unknown\s+as\b/ },
  { name: "a TypeScript error suppression", pattern: /@ts-(ignore|expect-error|nocheck)/ },
  {
    name: "a lint suppression",
    pattern: new RegExp(
      [
        ["biome", "ignore"],
        ["eslint", "disable"],
      ]
        .map((w) => w.join("-"))
        .join("|"),
    ),
  },
  { name: "a skipped or focused test", pattern: /\b(it|test|describe)\.(skip|only|todo)\s*\(|\bskip:\s*true\b/ },
];

export interface Finding {
  file: string;
  line: number;
  rule: string;
  text: string;
}

export function scan(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const r of RULES) if (r.pattern.test(line)) out.push({ file, line: i + 1, rule: r.name, text: line.trim() });
  });
  return out;
}

function trackedSources(): string[] {
  const listed = spawnSync("git", ["ls-files", "--", "ts/src", "ts/test", "ts/tools", "web/src"], { cwd: appDir, encoding: "utf8" });
  if (listed.status !== 0) throw new Error("git ls-files failed: " + listed.stderr);
  return listed.stdout.split(/\r?\n/).filter((f) => /\.(ts|cts|mts)$/.test(f));
}

function bannedPackages(): Finding[] {
  const out: Finding[] = [];
  for (const pkg of ["ts/package.json", "web/package.json"]) {
    const text = readFileSync(join(appDir, pkg), "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      if (/"(effect|@effect\/[^"]+)"\s*:/.test(line)) out.push({ file: pkg, line: i + 1, rule: "the Effect library", text: line.trim() });
    });
  }
  return out;
}

function biome(): number {
  const bin = join(appDir, "ts", "node_modules", "@biomejs", "biome", "bin", "biome");
  const r = spawnSync(process.execPath, [bin, "check", "."], { cwd: appDir, stdio: "inherit" });
  return r.status ?? 1;
}

export function run(): number {
  const linted = biome();
  const findings = [...trackedSources().flatMap((f) => scan(f, readFileSync(join(appDir, f), "utf8"))), ...bannedPackages()];
  for (const f of findings) console.log(`${f.file}:${f.line}: ${f.rule}: ${f.text}`);
  console.log(findings.length ? `${findings.length} problem(s) found.` : "Project rules: no problems found.");
  return findings.length || linted !== 0 ? 1 : 0;
}

const entry = process.argv[1];
if (entry && resolve(entry) === fileURLToPath(import.meta.url)) process.exit(run());
