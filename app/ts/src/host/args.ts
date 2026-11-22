import { isIP } from "node:net";
import { parseArgs } from "node:util";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface Args {
  host: string;
  lan: boolean;
  port: number;
  hardware: boolean;
  emulate: boolean;
  consoleIp: string | null;
  audioDevice: string | null;
  outputDevice: string | null;
  inputGain: number;
  channelMap: string | null;
  auto: boolean;
  traceOsc: boolean;
  listDevices: boolean;
  https: boolean;
  pin: string | null;
  trust: boolean;
  insecureOpen: boolean;
  template: string | null;
  ablesetPort: number | null;
  ablesetFrom: string | null;
  noShowClock: boolean;
  venue: string;
  sessionDb: string | null;
  advisor: boolean;
  advisorInterval: number;
  help: boolean;
}

export const USAGE = `usage: run [-h] [--host HOST] [--lan] [--port PORT] [--hardware] [--emulate]
           [--console-ip CONSOLE_IP] [--audio-device AUDIO_DEVICE]
           [--output-device OUTPUT_DEVICE] [--input-gain INPUT_GAIN]
           [--channel-map CHANNEL_MAP] [--auto] [--trace-osc] [--list-devices]
           [--https] [--pin PIN] [--trust] [--insecure-open] [--template TEMPLATE]
           [--ableset-port ABLESET_PORT] [--ableset-from ADDRESS] [--no-show-clock]
           [--venue VENUE]
           [--session-db SESSION_DB] [--advisor] [--advisor-interval ADVISOR_INTERVAL]`;

export const HELP = `${USAGE}

Acoustic Trio Mix-Assistant

options:
  -h, --help            show this help message and exit
  --host HOST
  --lan                 bind to the LAN so tablets can connect (shorthand for --host 0.0.0.0)
  --port PORT
  --hardware            drive a real M32C over OSC (default: simulation)
  --emulate             run the FULL hardware stack against an in-process desk emulator +
                        timed audio over real sockets (no gear needed)
  --console-ip CONSOLE_IP
  --audio-device AUDIO_DEVICE
                        input audio device (index or name) for the listening half; omit to
                        run hardware mode with manual control only
  --output-device OUTPUT_DEVICE
                        output device (index or name) the calibration pink noise plays to —
                        point this at the PA (default: OS default output)
  --input-gain INPUT_GAIN
                        digital input boost in dB for a quiet mic/interface (e.g. a dynamic
                        Samson Q9U); try 20-40
  --channel-map CHANNEL_MAP
                        explicit console-channel:device-column map for the input device,
                        e.g. '1:0,2:1,8:9' (console 1-based, column 0-based). Default:
                        console N -> device column N-1. Use when the console's USB routing
                        doesn't send channel N to USB column N-1.
  --auto                auto-detect the best input device, size the channel map to it, and
                        auto-set input gain (no --audio-device needed)
  --trace-osc           (--emulate) print every OSC address an editor (Mixing Station,
                        X32-Edit) asks the emulated desk for — for protocol fidelity work
  --list-devices        list input audio devices and exit
  --https               serve over TLS (self-signed) so iPad/Android get Wake Lock + a real
                        PWA install
  --pin PIN             require this access PIN to open the dashboard and control the
                        console (recommended on untrusted networks; pair with --https).
                        Omit for no auth on a trusted FOH LAN.
  --trust               serve a cert signed by a local root CA (implies --https). Install
                        the printed root once per device (browse to /ca.pem) for a
                        fully-trusted, warning-FREE https connection.
  --insecure-open       allow the dashboard on the network without a PIN (anyone on the
                        network can then control the console)
  --template TEMPLATE   show-template JSON (songs -> scene + reference levels); omit to use
                        the built-in trio setlist
  --ableset-port ABLESET_PORT
                        listen for AbleSet song/section OSC on this UDP port (hardware
                        mode); enables automatic scene recall
  --ableset-from ADDRESS
                        accept AbleSet messages only from this IP address (default: the
                        first computer that sends them)
  --no-show-clock       disable the simulated show clock (no auto song changes)
  --venue VENUE         venue name — tags the session log for venue learning
  --session-db SESSION_DB
                        SQLite path for session logging (default: ./sessions.db; use 'off'
                        to disable)
  --advisor             enable the Claude advisory layer (needs ANTHROPIC_API_KEY; advisory
                        notes only — never controls the mix)
  --advisor-interval ADVISOR_INTERVAL
                        seconds between advisor checks (default 30)
`;

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  host: { type: "string" },
  lan: { type: "boolean" },
  port: { type: "string" },
  hardware: { type: "boolean" },
  emulate: { type: "boolean" },
  "console-ip": { type: "string" },
  "audio-device": { type: "string" },
  "output-device": { type: "string" },
  "input-gain": { type: "string" },
  "channel-map": { type: "string" },
  auto: { type: "boolean" },
  "trace-osc": { type: "boolean" },
  "list-devices": { type: "boolean" },
  https: { type: "boolean" },
  pin: { type: "string" },
  trust: { type: "boolean" },
  "insecure-open": { type: "boolean" },
  template: { type: "string" },
  "ableset-port": { type: "string" },
  "ableset-from": { type: "string" },
  "no-show-clock": { type: "boolean" },
  venue: { type: "string" },
  "session-db": { type: "string" },
  advisor: { type: "boolean" },
  "advisor-interval": { type: "string" },
} as const;

function intOption(name: string, raw: string | undefined, fallback: number | null, min: number = -Infinity, max: number = Infinity): number | null {
  if (raw === undefined) return fallback;
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) throw new UsageError(`argument --${name}: invalid int value: '${raw}'`);
  const v = Number(raw.trim());
  if (v < min || v > max) throw new UsageError(`argument --${name}: ${v} is outside ${min}..${max}`);
  return v;
}

function floatOption(name: string, raw: string | undefined, fallback: number, min: number = -Infinity, max: number = Infinity): number {
  if (raw === undefined) return fallback;
  const v = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(raw) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isFinite(v)) throw new UsageError(`argument --${name}: invalid float value: '${raw}'`);
  if (v < min || v > max) throw new UsageError(`argument --${name}: ${v} is outside ${min}..${max}`);
  return v;
}

export function parseCliArgs(argv: readonly string[]): Args {
  let values: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; strict: true; allowPositionals: false }>>["values"];
  try {
    values = parseArgs({ args: [...argv], options: OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const port = intOption("port", values["port"], 8770, 1, 65535) as number;
  const args: Args = {
    host: values["host"] ?? "127.0.0.1",
    lan: Boolean(values["lan"]),
    port,
    hardware: Boolean(values["hardware"]),
    emulate: Boolean(values["emulate"]),
    consoleIp: values["console-ip"] ?? null,
    audioDevice: values["audio-device"] ?? null,
    outputDevice: values["output-device"] ?? null,
    inputGain: floatOption("input-gain", values["input-gain"], 0.0, -60, 80),
    channelMap: values["channel-map"] ?? null,
    auto: Boolean(values["auto"]),
    traceOsc: Boolean(values["trace-osc"]),
    listDevices: Boolean(values["list-devices"]),
    https: Boolean(values["https"]),
    pin: values["pin"] ?? null,
    trust: Boolean(values["trust"]),
    insecureOpen: Boolean(values["insecure-open"]),
    template: values["template"] ?? null,
    ablesetPort: intOption("ableset-port", values["ableset-port"], null, 1, 65535),
    ablesetFrom: values["ableset-from"]?.trim() || null,
    noShowClock: Boolean(values["no-show-clock"]),
    venue: values["venue"] ?? "",
    sessionDb: values["session-db"] ?? null,
    advisor: Boolean(values["advisor"]),
    advisorInterval: floatOption("advisor-interval", values["advisor-interval"], 30.0, 5, 3600),
    help: Boolean(values["help"]),
  };
  if (args.ablesetFrom !== null && isIP(args.ablesetFrom) === 0) {
    throw new UsageError(`argument --ableset-from: '${args.ablesetFrom}' is not an IP address`);
  }
  if (args.lan) args.host = "0.0.0.0";
  if (args.trust) args.https = true;
  return args;
}

export const modeName = (a: Pick<Args, "emulate" | "hardware">): string =>
  a.emulate ? "emulated" : a.hardware ? "hardware" : "simulation";

export const parseDevice = (v: string | null): number | string | null => {
  if (v === null) return null;
  return /^\d+$/.test(v) ? Number(v) : v;
};
