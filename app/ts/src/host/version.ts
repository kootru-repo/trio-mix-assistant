import { readFileSync } from "node:fs";

export interface AppVersion {
  version: string;
  commit: string | null;
  label: string;
}

export function versionFrom(text: string): AppVersion {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  const version = typeof data === "object" && data !== null ? Reflect.get(data, "version") : undefined;
  const commit = typeof data === "object" && data !== null ? Reflect.get(data, "commit") : undefined;
  const v = typeof version === "string" && version ? version : "unknown";
  const c = typeof commit === "string" && commit ? commit : null;
  return { version: v, commit: c, label: c === null ? v : `${v} (${c})` };
}

let cached: AppVersion | null = null;

export function appVersion(): AppVersion {
  if (cached !== null) return cached;
  let text = "";
  try {
    text = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
  } catch {
    text = "";
  }
  cached = versionFrom(text);
  return cached;
}
