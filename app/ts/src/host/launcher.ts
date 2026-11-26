import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { TuningError, parseOverride } from "../core/tuning.ts";

export type Conf = Record<string, string>;

function unquote(v: string): string {
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1);
  const hash = v.search(/\s#/);
  return hash >= 0 ? v.slice(0, hash).trim() : v;
}

export function parseConf(text: string): Conf {
  const cfg: Conf = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const at = line.indexOf("=");
    cfg[line.slice(0, at).trim().toUpperCase()] = unquote(line.slice(at + 1).trim());
  }
  return cfg;
}

export function readConf(path: string): Conf {
  if (!existsSync(path)) return {};
  return parseConf(readFileSync(path, "utf8"));
}

const YES = ["1", "yes", "y", "true", "on"];
const NO = ["0", "no", "n", "false", "off", ""];

export class ConfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfError";
  }
}

function yes(v: unknown, key: string): boolean {
  const t = String(v).trim().toLowerCase();
  if (YES.includes(t)) return true;
  if (NO.includes(t)) return false;
  throw new ConfError(`${key} in show.conf must be yes or no, not '${String(v).trim()}'`);
}

const get = (cfg: Conf, key: string, fallback: string): string => cfg[key] ?? fallback;

export function vetArgv(cfg: Conf, plan: LaunchPlan, print: (line: string) => void = () => undefined): string[] {
  const argv = plan.argv.filter((a) => a !== "--emulate");
  argv.push("--vet");
  const channel = get(cfg, "VET_CHANNEL", "").trim();
  const gain = yes(get(cfg, "VET_GAIN", "no"), "VET_GAIN");
  const main = yes(get(cfg, "VET_MAIN", "no"), "VET_MAIN");
  if (plan.mode === "hardware") {
    if (channel) {
      if (!/^\d+$/.test(channel) || Number(channel) < 1 || Number(channel) > 32) {
        throw new ConfError(`VET_CHANNEL in show.conf must be a channel number from 1 to 32, not '${channel}'`);
      }
      argv.push(`--vet-channel=${channel}`);
      if (gain) argv.push("--vet-gain");
    }
    if (main) argv.push("--vet-main");
  } else if (channel || main || gain) {
    print("  [i] VET_CHANNEL, VET_GAIN and VET_MAIN are used only with MODE=hardware; testing the built-in emulator only.");
  }
  if (yes(get(cfg, "VET_SOUND", "no"), "VET_SOUND")) argv.push("--vet-sound");
  if (yes(get(cfg, "VET_PHONE", "no"), "VET_PHONE")) argv.push("--vet-phone");
  return argv;
}

export interface LaunchPlan {
  argv: string[];
  mode: string;
  port: string;
}

export function buildArgv(
  cfg: Conf,
  baseDir: string,
  rehearse: boolean = false,
  print: (line: string) => void = () => undefined,
): LaunchPlan {
  const argv: string[] = [];
  const mode = rehearse ? "emulate" : get(cfg, "MODE", "sim").trim().toLowerCase();
  if (!["sim", "emulate", "hardware"].includes(mode)) {
    throw new ConfError(`MODE in show.conf must be hardware, emulate or sim, not '${mode}'`);
  }
  const auto = yes(get(cfg, "AUTO", "no"), "AUTO");
  if (auto) argv.push("--auto");
  if (mode === "hardware") {
    argv.push("--hardware");
    const ip = get(cfg, "CONSOLE_IP", "").trim();
    if (ip) {
      argv.push(`--console-ip=${ip}`);
    } else {
      print("  [!] MODE=hardware but CONSOLE_IP is blank in show.conf — the app will try 192.168.1.50.");
    }
    const dev = get(cfg, "AUDIO_DEVICE", "").trim();
    if (dev) {
      argv.push(`--audio-device=${dev}`);
    } else if (!auto) {
      print(
        "  [i] AUDIO_DEVICE blank — running manual mixing + scene recall only (the assistant won't listen). Run the app with --list-devices to pick one.",
      );
    }
    const outdev = get(cfg, "OUTPUT_DEVICE", "").trim();
    if (outdev) argv.push(`--output-device=${outdev}`);
    const igain = get(cfg, "INPUT_GAIN", "").trim();
    if (igain) argv.push(`--input-gain=${igain}`);
    const ab = get(cfg, "ABLESET_PORT", "").trim();
    if (ab) argv.push(`--ableset-port=${ab}`);
    const abFrom = get(cfg, "ABLESET_FROM", "").trim();
    if (abFrom) argv.push(`--ableset-from=${abFrom}`);
  } else if (mode === "emulate") {
    argv.push("--emulate");
  }

  const tmpl = get(cfg, "TEMPLATE", "").trim();
  if (tmpl) argv.push(`--template=${isAbsolute(tmpl) ? tmpl : join(baseDir, tmpl)}`);
  const venue = get(cfg, "VENUE", "").trim();
  if (venue) argv.push(`--venue=${venue}`);
  const lan = yes(get(cfg, "LAN", "yes"), "LAN");
  if (lan) argv.push("--lan");
  const trust = yes(get(cfg, "TRUST", "no"), "TRUST");
  const httpsWanted = yes(get(cfg, "HTTPS", "yes"), "HTTPS");
  const https = trust || (lan && httpsWanted);
  if (trust) argv.push("--trust");
  else if (https) argv.push("--https");
  const pin = get(cfg, "PIN", "").trim();
  if (lan && !pin) {
    if (yes(get(cfg, "ALLOW_OPEN", "no"), "ALLOW_OPEN")) {
      argv.push("--insecure-open");
      print("  [!] LAN=yes with no PIN and ALLOW_OPEN=yes: anyone on this network can control the console.");
    } else {
      throw new ConfError("LAN=yes needs a PIN of at least 6 characters in show.conf (PIN=...). Set one, or set LAN=no, or ALLOW_OPEN=yes to allow an open dashboard");
    }
  }
  if (pin) {
    argv.push(`--pin=${pin}`);
    if (lan && !https) {
      print("  [!] PIN is set but HTTPS=no — the PIN travels unencrypted. Set HTTPS=yes in show.conf.");
    }
  }
  const port = get(cfg, "PORT", "").trim() || "8770";
  argv.push(`--port=${port}`);
  const sessionDb = get(cfg, "SESSION_DB", "").trim();
  if (sessionDb) {
    const off = sessionDb.toLowerCase() === "off";
    argv.push(`--session-db=${off ? "off" : isAbsolute(sessionDb) ? sessionDb : join(baseDir, sessionDb)}`);
  }
  for (const [key, value] of Object.entries(cfg)) {
    if (!key.startsWith("TUNE.")) continue;
    try {
      const o = parseOverride(`${key.slice(5)}=${value}`, "show.conf");
      argv.push(`--tune=${o.path}=${o.value}`);
    } catch (exc) {
      if (exc instanceof TuningError) throw new ConfError(`${key} in show.conf: ${exc.message}`);
      throw exc;
    }
  }
  return { argv, mode, port };
}
