import type { AnalysedBlock } from "./blockanalysis.ts";
import { fixed } from "./numfmt.ts";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  rows: string[];
  fix: string | null;
}

export interface ChannelLevel {
  ch: number;
  label: string;
  mapped: boolean;
  rmsDb: number | null;
  peakDb: number | null;
}

export interface AudioFacts {
  name: string | null;
  deviceChannels: number | null;
  link: string;
  dead: boolean;
  lastError: string | null;
  windowS: number;
  blocks: number;
  expectedPerS: number;
  stale: number;
  overruns: number;
  channels: ChannelLevel[];
}

export interface ConsoleFacts {
  emulated: boolean;
  address: string;
  listening: boolean;
  listenError: string | null;
  windowS: number;
  packets: number;
  meters: number;
}

export interface NetworkFacts {
  lan: boolean;
  url: string | null;
  pin: boolean;
  https: boolean;
}

export interface AudioModuleFacts {
  ok: boolean;
  inputs: number;
  error: string | null;
}

export interface DiagFacts {
  app: string;
  system: string;
  platform: string;
  home: string | null;
  mode: string;
  audioModule: AudioModuleFacts;
  audio: AudioFacts | null;
  audioSkipped: string;
  console: ConsoleFacts | null;
  network: NetworkFacts;
  scrub?: (text: string) => string;
}

export interface DiagReport {
  result: CheckStatus;
  summary: string;
  checks: Check[];
  text: string;
}

export const DIGITAL_SILENCE_DB = -150;
export const QUIET_CHANNEL_DB = -85;
export const RATE_FAIL = 0.9;
export const RATE_WARN = 0.97;
export const LATE_WARN = 0.02;

export class LevelWindow {
  blocks = 0;
  private readonly rms = new Map<number, number>();
  private readonly peak = new Map<number, number>();

  add(block: AnalysedBlock): void {
    this.blocks += 1;
    for (const [ch, feat] of block.feats) {
      const r = this.rms.get(ch);
      if (r === undefined || feat.rmsDbfs > r) this.rms.set(ch, feat.rmsDbfs);
      const p = this.peak.get(ch);
      if (p === undefined || feat.peakDbfs > p) this.peak.set(ch, feat.peakDbfs);
    }
  }

  levels(labels: ReadonlyMap<number, string>, mapped: ReadonlySet<number> | null): ChannelLevel[] {
    return [...labels].map(([ch, label]) => ({
      ch,
      label,
      mapped: mapped === null || mapped.has(ch),
      rmsDb: this.rms.get(ch) ?? null,
      peakDb: this.peak.get(ch) ?? null,
    }));
  }
}

const check = (id: string, title: string, status: CheckStatus, detail: string, fix: string | null = null, rows: string[] = []): Check => ({
  id,
  title,
  status,
  detail,
  rows,
  fix: status === "pass" || status === "skip" ? null : fix,
});

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const microphoneFix = (platform: string): string =>
  platform === "darwin"
    ? "Open System Settings → Privacy & Security → Microphone, allow Terminal (or the app you started this from), then start the app again."
    : platform === "win32"
      ? "Open Settings → Privacy & security → Microphone and let desktop apps use the microphone. Check that the input is not muted, then start the app again."
      : "Check that this app may use the microphone and that the input is not muted, then start the app again.";

function moduleCheck(f: DiagFacts): Check {
  const title = "Audio module loads";
  const m = f.audioModule;
  if (!m.ok) {
    return check(
      "module",
      title,
      "fail",
      m.error ?? "the audio module did not load",
      "Use the downloaded single-file app, which carries the audio module.",
    );
  }
  if (m.inputs === 0) {
    return check(
      "module",
      title,
      "fail",
      "loaded, but the system reports no audio inputs",
      "Plug in the console's USB cable or an audio interface and check the system's sound settings.",
    );
  }
  return check("module", title, "pass", `loaded, ${plural(m.inputs, "input")} found`);
}

function inputCheck(f: DiagFacts): Check {
  const title = "Chosen input opens";
  const a = f.audio;
  if (a === null) return check("input", title, "skip", f.audioSkipped);
  if (a.link !== "open") {
    return check(
      "input",
      title,
      "fail",
      a.lastError ?? `the input is not open (${a.link})`,
      "Run the app with --list-devices and pick an input with enough channels at 48000 Hz. Close other apps that are using it. " +
        "To test a small input on its own, run --diagnose --audio-device <number> without --hardware or --emulate.",
    );
  }
  const size = a.deviceChannels === null ? "" : `, ${plural(a.deviceChannels, "channel")}`;
  return check("input", title, "pass", `'${a.name ?? "input"}'${size}, 48000 Hz`);
}

function flowCheck(f: DiagFacts, input: Check): Check {
  const title = "Audio is arriving";
  const a = f.audio;
  if (a === null || input.status !== "pass") return check("flow", title, "skip", "needs an open input");
  const rate = a.windowS > 0 ? a.blocks / a.windowS : 0;
  const share = a.expectedPerS > 0 ? rate / a.expectedPerS : 0;
  const detail =
    `${fixed(rate, 1)} of ${fixed(a.expectedPerS, 1)} blocks per second over ${fixed(a.windowS, 0)} s` +
    `; ${a.stale} late, ${a.overruns} dropped by the driver`;
  const fix = "Close other audio apps, plug the interface straight into the computer, and on Windows pick the WASAPI entry for the device.";
  if (a.dead || share < RATE_FAIL)
    return check("flow", title, "fail", a.dead ? `the input stopped delivering audio; ${detail}` : detail, fix);
  if (share < RATE_WARN || a.overruns > 0 || a.stale > LATE_WARN * Math.max(1, a.blocks)) return check("flow", title, "warn", detail, fix);
  return check("flow", title, "pass", detail);
}

function signalCheck(f: DiagFacts, flow: Check): Check {
  const title = "Signal is not digital silence";
  const a = f.audio;
  if (a === null || flow.status === "skip" || a.blocks === 0) return check("signal", title, "skip", "needs audio to arrive");
  const peaks = a.channels.map((c) => c.peakDb).filter((p): p is number => p !== null);
  if (peaks.length === 0) return check("signal", title, "skip", "no mapped channel delivered audio");
  const peak = Math.max(...peaks);
  if (peak <= DIGITAL_SILENCE_DB) {
    return check(
      "signal",
      title,
      "fail",
      "every sample is exactly zero, which usually means the system is blocking the microphone",
      microphoneFix(f.platform),
    );
  }
  return check("signal", title, "pass", `loudest peak ${Math.round(peak) || 0} dBFS`);
}

function channelsCheck(f: DiagFacts, signal: Check): Check {
  const title = "Each channel shows a level";
  const a = f.audio;
  if (a === null || signal.status === "skip") return check("channels", title, "skip", "needs audio to arrive");
  const rows = a.channels.map((c) => {
    const name = `ch ${c.ch} ${c.label}`;
    if (!c.mapped) return `${name}: not in the channel map`;
    if (c.rmsDb === null) return `${name}: no audio`;
    return `${name}: ${fixed(Math.max(c.rmsDb, -120), 0)} dBFS${c.rmsDb <= QUIET_CHANNEL_DB ? " (no signal)" : ""}`;
  });
  const unmapped = a.channels.filter((c) => !c.mapped).length;
  const quiet = a.channels.filter((c) => c.mapped && (c.rmsDb === null || c.rmsDb <= QUIET_CHANNEL_DB)).length;
  if (unmapped === 0 && quiet === 0)
    return check("channels", title, "pass", `all ${plural(a.channels.length, "channel")} carry signal`, null, rows);
  const parts: string[] = [];
  const fixes: string[] = [];
  if (quiet > 0) {
    parts.push(`${plural(quiet, "channel")} showed no signal`);
    fixes.push(
      "Make sound on each quiet channel and run the checks again. If a different channel moves instead, set the channel map (--channel-map).",
    );
  }
  if (unmapped > 0) {
    parts.push(`${plural(unmapped, "channel")} missing from the channel map`);
    fixes.push("Add the missing channels to the channel map, or leave the map out to use the default order.");
  }
  return check("channels", title, "warn", parts.join("; "), fixes.join(" "), rows);
}

function consoleCheck(f: DiagFacts): Check {
  const title = "Console answers";
  const c = f.console;
  if (c === null) return check("console", title, "skip", "simulation mode has no console");
  const who = c.emulated ? "the built-in console emulator" : c.address;
  if (!c.listening) {
    return check(
      "console",
      title,
      "fail",
      `could not listen for replies${c.listenError ? ` (${c.listenError})` : ""}`,
      "Another copy of the app is probably running. Stop it, or use Run checks on its dashboard instead.",
    );
  }
  if (c.packets === 0) {
    return check(
      "console",
      title,
      "fail",
      `no reply from ${who} in ${fixed(c.windowS, 0)} s`,
      c.emulated
        ? "Start the app again; the emulator did not answer."
        : "Check the console's IP address (CONSOLE_IP), the network cable or Wi-Fi, and that the firewall allows this app on private networks.",
    );
  }
  return check("console", title, "pass", `${plural(c.packets, "meter packet")} from ${who} (${plural(c.meters, "meter")} each)`);
}

function networkCheck(f: DiagFacts): Check {
  const title = "Tablet access";
  const n = f.network;
  if (!n.lan) return check("network", title, "skip", "the dashboard is open to this computer only (LAN is off)");
  if (!n.pin)
    return check(
      "network",
      title,
      "fail",
      "the dashboard is open to the network without a PIN",
      "Set a PIN of six or more characters (PIN in show.conf, or --pin).",
    );
  const where = n.url ?? "the address printed at start";
  if (!n.https)
    return check(
      "network",
      title,
      "warn",
      `PIN set, but it travels unencrypted; ${where}`,
      "Turn HTTPS on (HTTPS=yes in show.conf, or --https).",
    );
  return check("network", title, "pass", `PIN and HTTPS are on; open ${where} on the tablet to confirm it connects`);
}

export function evaluate(f: DiagFacts): Check[] {
  const module = moduleCheck(f);
  const input = inputCheck(f);
  const flow = flowCheck(f, input);
  const signal = signalCheck(f, flow);
  const channels = channelsCheck(f, signal);
  return [module, input, flow, signal, channels, consoleCheck(f), networkCheck(f)];
}

export function checkLines(c: Check): string[] {
  const out = [`[${c.status.toUpperCase()}] ${c.title}: ${c.detail}`];
  for (const r of c.rows) out.push(`         ${r}`);
  if (c.fix !== null) out.push(`       Fix: ${c.fix}`);
  return out;
}

export function headerLines(f: Pick<DiagFacts, "app" | "system" | "mode">): string[] {
  return ["===== Trio Mix-Assistant checks =====", `App: ${f.app}`, `System: ${f.system}`, `Mode: ${f.mode}`];
}

export function resultOf(checks: readonly Check[]): CheckStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "pass";
}

export function summaryOf(checks: readonly Check[]): string {
  const count = (s: CheckStatus): number => checks.filter((c) => c.status === s).length;
  return `${count("fail")} failed, ${plural(count("warn"), "warning")}, ${count("pass")} passed, ${count("skip")} skipped`;
}

export function footerLines(checks: readonly Check[]): string[] {
  return [`Result: ${summaryOf(checks)}`, "====================================="];
}

export function redact(text: string, home: string | null): string {
  if (home === null || home.length < 3) return text;
  const forms = new Set([home, home.split("\\").join("/"), home.split("/").join("\\")]);
  let out = text;
  for (const form of forms) out = out.split(form).join("~");
  return out;
}

export interface ScrubFacts {
  devices: readonly string[];
  words: readonly string[];
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const HEX = "[0-9A-Fa-f]{1,4}";
const IPV6 = new RegExp(
  `(?<![\\w:.])(?:(?:${HEX}:){4,7}${HEX}|(?:${HEX}(?::${HEX})*)?::(?:(?:${HEX}:)*(?:\\d{1,3}(?:\\.\\d{1,3}){3}|x\\.x\\.x\\.x|${HEX}))?)(?:%[\\w.-]+)?(?![\\w:])`,
  "g",
);

export function templateWords(json: string): string[] {
  let d: unknown;
  try {
    d = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof d !== "object" || d === null || Array.isArray(d)) return [];
  const t = d as Record<string, unknown>;
  const out: string[] = [];
  if (typeof t["name"] === "string" && t["name"].trim()) out.push(t["name"].trim());
  const songs = t["songs"];
  if (Array.isArray(songs))
    for (const s of songs) {
      if (typeof s !== "object" || s === null) continue;
      const name = (s as Record<string, unknown>)["name"];
      if (typeof name === "string" && name.trim()) out.push(name.trim());
    }
  return out;
}

export function makeScrubber(f: ScrubFacts): (text: string) => string {
  const byLength = (a: string, b: string): number => b.length - a.length;
  const names = [...new Set(f.devices.map((d) => d.replace(/\s+/g, " ").trim()).filter((d) => d.length >= 4))].sort(byLength);
  const devices = names.map((d) => new RegExp(d.split(" ").map(escapeRegExp).join("\\s+"), "g"));
  const words = [...new Set(f.words.map((w) => w.trim()).filter((w) => w.length >= 3))].sort(byLength);
  return (text) => {
    let out = text;
    for (const d of devices) out = out.replace(d, "(device name hidden)");
    for (const w of words) out = out.replace(new RegExp(escapeRegExp(w), "gi"), "(name hidden)");
    out = out.replace(/\b(?!127\.0\.0\.1\b)\d{1,3}(?:\.\d{1,3}){3}\b/g, "x.x.x.x");
    out = out.replace(/\b[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}\b/g, "xx:xx:xx:xx:xx:xx");
    out = out.replace(IPV6, (m) => (m === "::1" ? m : "x:x:x:x:x:x:x:x"));
    out = out.replace(/((?:\/xinfo|answered:) (?:x\.x\.x\.x|127\.0\.0\.1)) (.+) (\S+) (\S+)$/gm, "$1 (console name hidden) $3 $4");
    return out;
  };
}

export function buildReport(f: DiagFacts): DiagReport {
  const scrub = f.scrub ?? ((text: string): string => text);
  const clean = (text: string): string => scrub(redact(text, f.home));
  const checks = evaluate(f).map((c) => ({
    ...c,
    detail: clean(c.detail),
    rows: c.rows.map(clean),
    fix: c.fix === null ? null : clean(c.fix),
  }));
  const text = [...headerLines(f), ...checks.flatMap(checkLines), ...footerLines(checks)].join("\n");
  return { result: resultOf(checks), summary: summaryOf(checks), checks, text };
}

export interface DiagHost {
  app: string;
  system: string;
  platform: string;
  home: string | null;
  mode: string;
  audioModule: AudioModuleFacts;
  audioSkipped: string | null;
  mappedChannels: readonly number[] | null;
  consoleEmulated: boolean;
  network: NetworkFacts;
  scrub?: (text: string) => string;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function audioFacts(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  window: LevelWindow,
  windowS: number,
  expectedPerS: number,
  labels: ReadonlyMap<number, string>,
  mapped: readonly number[] | null,
): AudioFacts {
  const link = after["link"];
  const lastError = after["lastError"];
  const name = after["name"];
  const channels = after["channels"];
  return {
    name: typeof name === "string" ? name : null,
    deviceChannels: typeof channels === "number" ? channels : null,
    link: typeof link === "string" ? link : after["dead"] ? "down" : "open",
    dead: Boolean(after["dead"]),
    lastError: typeof lastError === "string" && lastError !== "" ? lastError : null,
    windowS,
    blocks: window.blocks,
    expectedPerS,
    stale: Math.max(0, count(after["stale"]) - count(before["stale"])),
    overruns: Math.max(0, count(after["overruns"]) - count(before["overruns"])),
    channels: window.levels(labels, mapped === null ? null : new Set(mapped)),
  };
}
