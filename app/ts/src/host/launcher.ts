import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type Conf = Record<string, string>;

export function parseConf(text: string): Conf {
  const cfg: Conf = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const at = line.indexOf("=");
    cfg[line.slice(0, at).trim().toUpperCase()] = line.slice(at + 1).trim();
  }
  return cfg;
}

export function readConf(path: string): Conf {
  if (!existsSync(path)) return {};
  return parseConf(readFileSync(path, "utf8"));
}

const yes = (v: unknown): boolean => ["1", "yes", "y", "true", "on"].includes(String(v).trim().toLowerCase());

const get = (cfg: Conf, key: string, fallback: string): string => cfg[key] ?? fallback;

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
  if (yes(get(cfg, "AUTO", "no"))) argv.push("--auto");
  if (mode === "hardware") {
    argv.push("--hardware");
    const ip = get(cfg, "CONSOLE_IP", "").trim();
    if (ip) {
      argv.push("--console-ip", ip);
    } else {
      print("  [!] MODE=hardware but CONSOLE_IP is blank in show.conf — the console feed won't connect until you set it.");
    }
    const dev = get(cfg, "AUDIO_DEVICE", "").trim();
    if (dev) {
      argv.push("--audio-device", dev);
    } else {
      print(
        "  [i] AUDIO_DEVICE blank — running manual mixing + scene recall only (the assistant won't listen). Run list-devices to pick one.",
      );
    }
    const outdev = get(cfg, "OUTPUT_DEVICE", "").trim();
    if (outdev) argv.push("--output-device", outdev);
    const igain = get(cfg, "INPUT_GAIN", "").trim();
    if (igain) argv.push("--input-gain", igain);
    const ab = get(cfg, "ABLESET_PORT", "").trim();
    if (ab) argv.push("--ableset-port", ab);
  } else if (mode === "emulate") {
    argv.push("--emulate");
  }

  const tmpl = get(cfg, "TEMPLATE", "").trim();
  if (tmpl) argv.push("--template", isAbsolute(tmpl) ? tmpl : join(baseDir, tmpl));
  const venue = get(cfg, "VENUE", "").trim();
  if (venue) argv.push("--venue", venue);
  const lan = yes(get(cfg, "LAN", "yes"));
  if (lan) argv.push("--lan");
  const https = yes(get(cfg, "HTTPS", "yes"));
  if (https) argv.push("--https");
  const pin = get(cfg, "PIN", "").trim();
  if (pin) {
    argv.push("--pin", pin);
    if (lan && !https) {
      print("  [!] PIN is set but HTTPS=no — the PIN travels unencrypted. Set HTTPS=yes in show.conf.");
    }
  }
  const port = get(cfg, "PORT", "").trim() || "8770";
  argv.push("--port", port);
  if (yes(get(cfg, "ADVISOR", "no"))) argv.push("--advisor");
  return { argv, mode, port };
}
