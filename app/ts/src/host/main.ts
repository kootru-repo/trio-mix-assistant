import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { C, applyChannelMap, autoChannelMap } from "../core/config.ts";
import type { Clock } from "../core/clock.ts";
import { ConsoleBase, OscConsole } from "../core/console.ts";
import type { AudioInputFactory } from "../core/devicecapture.ts";
import { SoundDeviceCapture, autodetectInputs, listAudioDevices, parseChannelMap, ValueError } from "../core/devicecapture.ts";
import { EmulatedDesk } from "../core/emulator.ts";
import { Engine } from "../core/engine/index.ts";
import { MeterReceiver } from "../core/metersrv.ts";
import { fixed } from "../core/pyfmt.ts";
import { qrAscii, qrEncode } from "../core/qr.ts";
import { AbleSetReceiver, SimShowClock } from "../core/showclock.ts";
import { TemplateError, defaultTemplate, fromObject } from "../core/template.ts";
import type { ShowTemplate } from "../core/template.ts";
import { TimedAudioFactory } from "../core/timedaudio.ts";
import { HELP, UsageError, modeName, parseCliArgs, parseDevice, USAGE } from "./args.ts";
import type { Args } from "./args.ts";
import { Advisor } from "./advisor.ts";
import { bannerLines, emulatorLines } from "./banner.ts";
import { NativeAudioInputFactory } from "./audiodevice.ts";
import { SystemClock } from "./clock.ts";
import { findLayout } from "./layout.ts";
import type { Layout } from "./layout.ts";
import { lanIp } from "./netinfo.ts";
import { createServer } from "./server.ts";
import { SessionLog } from "./sessionlog.ts";
import { allLanIps, ensureCert, ensureTrustedCert, tlsHosts } from "./tls.ts";
import { NodeUdpFactory } from "./udp.ts";
import { UdpSink } from "./udpsink.ts";
import { VenueStore } from "./venuestore.ts";

const AUTO_CANDIDATES = 6;

function audioFactory(io: Io): AudioInputFactory {
  if (io.factory === null) throw new Error("audio factory not loaded");
  return io.factory;
}

export class Exit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.name = "Exit";
    this.code = code;
  }
}

export interface Io {
  out(line: string): void;
  clock: Clock;
  audio: () => Promise<AudioInputFactory>;
  factory: AudioInputFactory | null;
  udp: NodeUdpFactory;
  waitForStop: () => Promise<void>;
  layout: Layout;
}

function fail(io: Io, ...lines: string[]): never {
  for (const l of lines) io.out(l);
  throw new Exit(2);
}

function loadShowTemplate(args: Args, io: Io): ShowTemplate {
  let t: ShowTemplate;
  try {
    t = args.template ? fromObject(JSON.parse(readFileSync(args.template, "utf8"))) : defaultTemplate();
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    if (exc instanceof TemplateError || exc instanceof SyntaxError || (exc as NodeJS.ErrnoException).code) {
      return fail(io, `  [!] show template error: ${msg}`);
    }
    throw exc;
  }
  if (t.channels) {
    applyChannelMap(t.channels);
    io.out(`  Channel map: ${C.CHANNELS.size} channels from template '${t.name}'`);
  }
  return t;
}

function loadChannelMap(args: Args, io: Io): Map<number, number> | null {
  if (!args.channelMap) return null;
  let map: Map<number, number>;
  try {
    map = parseChannelMap(args.channelMap);
  } catch (exc) {
    if (exc instanceof ValueError) return fail(io, `  [!] --channel-map: ${exc.message}`);
    throw exc;
  }
  const missing = [...C.CHANNELS.keys()].filter((ch) => !map.has(ch));
  if (missing.length) {
    io.out(
      `  [!] --channel-map is missing console channel(s) [${missing.join(", ")}]; they won't be captured. Add them or omit --channel-map.`,
    );
  }
  if (args.auto) io.out("  [i] --channel-map is ignored with --auto (auto sizes its own map).");
  return map;
}

function quietStop(source: SoundDeviceCapture): void {
  try {
    source.stop();
  } catch {
    return;
  }
}

async function autodetectSource(io: Io): Promise<SoundDeviceCapture | null> {
  const factory = audioFactory(io);
  let cands;
  try {
    cands = autodetectInputs(factory);
  } catch (exc) {
    io.out(`  [!] --auto: ${exc instanceof Error ? exc.message : String(exc)}`);
    return null;
  }
  if (!cands.length) {
    io.out("  [!] --auto: no input devices found (install the audio module?) — manual only.");
    return null;
  }
  for (const cand of cands.slice(0, AUTO_CANDIDATES)) {
    const label = `[${cand.index}] ${cand.name} (${cand.hostapi}`;
    autoChannelMap(cand.channels);
    const source = new SoundDeviceCapture({ factory, clock: io.clock, device: cand.index });
    try {
      source.start();
      await source.autoGain();
    } catch (exc) {
      io.out(`  [i] --auto: ${label}) won't open (${exc instanceof Error ? exc.name : "Error"}); trying next.`);
      quietStop(source);
      continue;
    }
    if (source.autoDb !== null) {
      io.out(`  Auto input: ${label}, ${cand.channels} ch) — mic ${fixed(source.autoDb, 0)} dBFS, +${fixed(source.gainDb, 0)} dB`);
      return source;
    }
    io.out(`  [i] --auto: ${label}) opened but delivered no audio (mic busy?); trying next.`);
    quietStop(source);
  }
  io.out("  [!] --auto: no input delivered audio. Close other apps using the mic");
  io.out("      (mixer editors, voice tools) and check Windows mic privacy, then restart.");
  return null;
}

function deviceSource(args: Args, chanMap: Map<number, number> | null, io: Io): SoundDeviceCapture {
  return new SoundDeviceCapture({
    factory: audioFactory(io),
    clock: io.clock,
    device: parseDevice(args.audioDevice),
    outputDevice: parseDevice(args.outputDevice),
    channelMap: chanMap,
    gainDb: args.inputGain,
  });
}

const engineTick = (): number => C.BLOCK / C.SAMPLE_RATE;

function wireMeters(engine: Engine, io: Io): void {
  engine.meterRx = new MeterReceiver(io.udp, {
    onFader: (ch, db) => engine.reconcileFader(ch, db),
    onMeters: (vals) => engine.setConsoleMeters(vals),
  });
}

function buildEmulated(
  args: Args,
  template: ShowTemplate,
  chanMap: Map<number, number> | null,
  auto: SoundDeviceCapture | null,
  io: Io,
): { engine: Engine; emu: EmulatedDesk } {
  const emu = new EmulatedDesk(io.udp, io.clock, {
    externalMoves: true,
    nodeScn: readScn(io),
    onTrace: args.traceOsc ? (l) => io.out(l) : null,
  });
  for (const s of template.songs) if (s.scene !== null) emu.sceneNames.set(s.scene, s.name);
  const con = new OscConsole(new UdpSink("127.0.0.1", C.CONSOLE_PORT), { clock: io.clock, ip: "127.0.0.1" });
  let source: SoundDeviceCapture;
  if (auto !== null) {
    source = auto;
  } else if (args.audioDevice !== null) {
    source = deviceSource(args, chanMap, io);
    io.out("  Listening on a REAL audio device against the emulated desk." + (args.inputGain ? `  (+${fixed(args.inputGain, 0)} dB input)` : ""));
  } else {
    source = new SoundDeviceCapture({ factory: new TimedAudioFactory(io.clock), clock: io.clock });
  }
  const engine = new Engine({ console: con, sim: false, source, tick: engineTick(), template, clock: io.clock });
  wireMeters(engine, io);
  if (!args.noShowClock) engine.showClock = new SimShowClock(template, io.clock, (s) => engine.onSongChange(s));
  return { engine, emu };
}

function readScn(io: Io): string | null {
  try {
    return readFileSync(io.layout.scnPath, "utf8");
  } catch {
    return null;
  }
}

function buildHardware(
  args: Args,
  template: ShowTemplate,
  chanMap: Map<number, number> | null,
  auto: SoundDeviceCapture | null,
  io: Io,
): Engine {
  const ip = args.consoleIp || C.CONSOLE_IP;
  const con: ConsoleBase = new OscConsole(new UdpSink(ip, C.CONSOLE_PORT), { clock: io.clock, ip });
  let source: SoundDeviceCapture | null = auto;
  if (source === null && args.audioDevice !== null) source = deviceSource(args, chanMap, io);
  const engine = new Engine({ console: con, sim: false, source, tick: engineTick(), template, clock: io.clock });
  wireMeters(engine, io);
  if (args.ablesetPort !== null) {
    engine.showClock = new AbleSetReceiver(io.udp, (s) => engine.onSongChange(s), "0.0.0.0", args.ablesetPort);
  }
  return engine;
}

function buildSimulation(args: Args, template: ShowTemplate, io: Io): Engine {
  const engine = new Engine({ sim: true, template, clock: io.clock });
  if (!args.noShowClock) engine.showClock = new SimShowClock(template, io.clock, (s) => engine.onSongChange(s));
  return engine;
}

function attachSessionLog(engine: Engine, args: Args, templateName: string, io: Io): void {
  const db = args.sessionDb !== null ? args.sessionDb : join(io.layout.appDir, "sessions.db");
  if (db.toLowerCase() === "off") return;
  const slog = new SessionLog(db);
  slog.startSession(args.venue, templateName, modeName(args));
  engine.sessionLog = slog;
  io.out(`  Session log: ${db}` + (args.venue ? `  (venue: ${args.venue})` : ""));
}

function attachVenue(engine: Engine, args: Args, io: Io): void {
  if (!args.venue) return;
  const store = new VenueStore(join(io.layout.appDir, "venues"));
  engine.venue = args.venue;
  engine.venueStore = store;
  const model = store.load(args.venue);
  if (model === null) {
    io.out(`  Venue '${args.venue}': no model yet — will learn after this show.`);
    return;
  }
  engine.applyVenueModel(model);
  io.out(`  Venue model: ${model.shows} show(s), ${model.feedback_freqs.length} freq(s), confidence ${fixed(model.confidence * 100, 0)}%`);
}

function attachAdvisor(engine: Engine, args: Args, io: Io): void {
  if (!args.advisor) return;
  const adv = new Advisor({
    getContext: () => engine.advisorContext(),
    onAdvice: (a) => engine.onAdvice(a),
    interval: args.advisorInterval,
  });
  if (adv.available) {
    engine.advisor = adv;
    io.out("  Claude advisor: ON (advisory notes only)");
  } else {
    io.out("  [!] --advisor requested but ANTHROPIC_API_KEY is not set; advisor disabled.");
  }
}

interface TlsPlan {
  tls: { key: string; cert: string } | null;
  caPem: string | null;
}

async function prepareTls(args: Args, ip: string | null, io: Io): Promise<TlsPlan> {
  if (!args.https) return { tls: null, caPem: null };
  try {
    const hosts = tlsHosts(allLanIps(ip));
    const certdir = join(io.layout.appDir, ".certs");
    let caPem: string | null = null;
    let certfile: string;
    let keyfile: string;
    if (args.trust) {
      const [c, k, ca] = ensureTrustedCert(certdir, hosts);
      certfile = c;
      keyfile = k;
      caPem = readFileSync(ca, "utf8");
    } else {
      [certfile, keyfile] = ensureCert(certdir, hosts);
    }
    return { tls: { key: readFileSync(keyfile, "utf8"), cert: readFileSync(certfile, "utf8") }, caPem };
  } catch (exc) {
    io.out(`  [!] --https unavailable (${exc instanceof Error ? exc.name : "Error"}: ${exc instanceof Error ? exc.message : String(exc)}); serving over http.`);
    return { tls: null, caPem: null };
  }
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  let args: Args;
  try {
    args = parseCliArgs(argv);
  } catch (exc) {
    if (exc instanceof UsageError) {
      io.out(USAGE);
      io.out(`run: error: ${exc.message}`);
      return 2;
    }
    throw exc;
  }
  if (args.help) {
    io.out(HELP);
    return 0;
  }
  try {
    return await runChecked(args, io);
  } catch (exc) {
    if (exc instanceof Exit) return exc.code;
    throw exc;
  }
}

async function runChecked(args: Args, io: Io): Promise<number> {
  io.factory = await io.audio();
  if (args.listDevices) {
    try {
      io.out(listAudioDevices(audioFactory(io)));
    } catch (exc) {
      io.out(exc instanceof Error ? exc.message : String(exc));
    }
    return 0;
  }

  const template = loadShowTemplate(args, io);
  const chanMap = loadChannelMap(args, io);
  const auto = args.auto ? await autodetectSource(io) : null;

  let emu: EmulatedDesk | null = null;
  let engine: Engine;
  if (args.emulate) {
    const built = buildEmulated(args, template, chanMap, auto, io);
    engine = built.engine;
    emu = built.emu;
  } else if (args.hardware) {
    engine = buildHardware(args, template, chanMap, auto, io);
  } else {
    engine = buildSimulation(args, template, io);
  }

  attachSessionLog(engine, args, template.name, io);
  attachVenue(engine, args, io);
  attachAdvisor(engine, args, io);

  const ip = await lanIp();
  if (emu !== null) {
    try {
      await emu.start();
    } catch (exc) {
      return fail(
        io,
        `  [!] Desk emulator could not bind OSC port ${emu.listenPort}: ${exc instanceof Error ? exc.message : String(exc)}`,
        "      Another --emulate session is probably running. Stop it and retry.",
      );
    }
    for (const l of emulatorLines(ip, emu.listenPort, args.traceOsc)) io.out(l);
  }
  const plan = await prepareTls(args, ip, io);

  const server = createServer({ engine, staticDir: io.layout.staticDir, pin: args.pin, caPem: plan.caPem, tls: plan.tls });
  try {
    await server.start(args.port, args.host);
  } catch (exc) {
    if (emu !== null) emu.stop();
    return fail(
      io,
      `  [!] Could not open the dashboard on port ${args.port}: ${exc instanceof Error ? exc.message : String(exc)}`,
      `      Another copy already running? Try a different port:  --port ${args.port + 1}`,
    );
  }
  await engine.start();
  const scheme = plan.tls ? "https" : "http";
  const url = `${scheme}://${ip}:${args.port}/`;
  const wildcard = ["0.0.0.0", "::"].includes(args.host);
  const qr = wildcard && ip ? qrAscii(qrEncode(url).modules) : null;
  for (const l of bannerLines({
    args,
    scheme,
    ip,
    altIps: allLanIps(ip),
    caPath: join(io.layout.appDir, ".certs", "ca.pem"),
    qr,
  })) {
    io.out(l);
  }
  await io.waitForStop();
  io.out("\nShutting down...");
  await server.stop();
  await engine.stop();
  if (emu !== null) emu.stop();
  return 0;
}

export function defaultIo(): Io {
  const stopper = new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  return {
    out: (l) => console.log(l),
    clock: new SystemClock(),
    audio: () => NativeAudioInputFactory.create(),
    factory: null,
    udp: new NodeUdpFactory(),
    waitForStop: () => stopper,
    layout: findLayout(),
  };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  run(process.argv.slice(2), defaultIo()).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
