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
  diagnose: boolean;
  vet: boolean;
  vetChannel: number | null;
  vetMain: boolean;
  vetGain: boolean;
  vetKeepNames: boolean;
  vetSound: boolean;
  vetPhone: boolean;
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
  help: boolean;
}

export const USAGE = `usage: TrioMixAssistant [-h] [--host HOST] [--lan] [--port PORT] [--hardware] [--emulate]
           [--console-ip CONSOLE_IP] [--audio-device AUDIO_DEVICE]
           [--output-device OUTPUT_DEVICE] [--input-gain INPUT_GAIN]
           [--channel-map CHANNEL_MAP] [--auto] [--trace-osc] [--list-devices]
           [--diagnose]
           [--vet] [--vet-channel N] [--vet-main] [--vet-gain] [--vet-sound] [--vet-phone]
           [--vet-keep-names]
           [--https] [--pin PIN] [--trust] [--insecure-open] [--template TEMPLATE]
           [--ableset-port ABLESET_PORT] [--ableset-from ADDRESS] [--no-show-clock]
           [--venue VENUE]
           [--session-db SESSION_DB]`;

export const HELP = `${USAGE}

Trio Mix-Assistant

options:
  -h, --help            show this help message and exit
  --rehearse            use show.conf in emulate mode whatever MODE says: on its own
                        it runs the full app against the built-in emulator (no
                        console needed); with --diagnose or --vet it checks or tests
                        that setup
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
  --diagnose            check that this setup works (audio module, input, signal,
                        console, tablet access), print a report and exit. Read-only:
                        it never changes the console and plays no sound
  --vet                 full test: run every control, job and dashboard address against
                        the built-in emulator, print a report, write a log file and exit.
                        Alone, it takes its settings from show.conf (the VET_ keys add
                        options); with other flags they come from the command line. A real
                        console is contacted only with --hardware, and changed only
                        with --vet-channel, --vet-gain or --vet-main
  --vet-channel N       (--vet --hardware) test control on console channel N: each
                        value is set, read back and put back. Keep the PA off
  --vet-main            (--vet --hardware) also test the main bus and the first FX
                        return the same way. Keep the PA off
  --vet-gain            (--vet --hardware --vet-channel N) also test that channel's
                        preamp gain
  --vet-keep-names      (--vet) keep audio device names, IP addresses and show names in
                        the report and log. By default they are replaced
  --vet-sound           (--vet) play pink noise and check that the measurement input
                        hears it; needs --audio-device
  --vet-phone           (--vet) serve the dashboard and wait for a phone to sign in;
                        needs --lan and --pin
  --https               serve over TLS (self-signed) so iPad/Android get Wake Lock + a real
                        PWA install
  --pin PIN             require this access PIN (at least 6 characters) to open the
                        dashboard and control the console; pair with --https.
                        Required with --lan unless --insecure-open is given.
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
                        SQLite path for session logging (default: sessions.db beside
                        show.conf; use 'off' to disable)
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
  diagnose: { type: "boolean" },
  vet: { type: "boolean" },
  "vet-channel": { type: "string" },
  "vet-main": { type: "boolean" },
  "vet-keep-names": { type: "boolean" },
  "vet-gain": { type: "boolean" },
  "vet-sound": { type: "boolean" },
  "vet-phone": { type: "boolean" },
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
    diagnose: Boolean(values["diagnose"]),
    vet: Boolean(values["vet"]),
    vetChannel: intOption("vet-channel", values["vet-channel"], null, 1, 32),
    vetMain: Boolean(values["vet-main"]),
    vetGain: Boolean(values["vet-gain"]),
    vetKeepNames: Boolean(values["vet-keep-names"]),
    vetSound: Boolean(values["vet-sound"]),
    vetPhone: Boolean(values["vet-phone"]),
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
    help: Boolean(values["help"]),
  };
  if (args.ablesetFrom !== null && isIP(args.ablesetFrom) === 0) {
    throw new UsageError(`argument --ableset-from: '${args.ablesetFrom}' is not an IP address`);
  }
  const vetExtras = args.vetChannel !== null || args.vetMain || args.vetGain || args.vetSound || args.vetPhone || args.vetKeepNames;
  if (vetExtras && !args.vet) throw new UsageError("the --vet-... options need --vet");
  if (args.vet && (args.diagnose || args.listDevices)) throw new UsageError("--vet cannot be combined with --diagnose or --list-devices");
  if (args.vet && args.emulate) throw new UsageError("--vet always tests the built-in emulator; leave out --emulate");
  if ((args.vetChannel !== null || args.vetMain) && !args.hardware) {
    throw new UsageError("--vet-channel and --vet-main change a real console, so they need --hardware");
  }
  if (args.vetGain && args.vetChannel === null) throw new UsageError("--vet-gain needs --vet-channel N");
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
