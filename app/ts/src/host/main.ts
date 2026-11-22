import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { C, applyChannelMap, autoChannelMap } from "../core/config.ts";
import type { Clock } from "../core/clock.ts";
import { OscConsole } from "../core/console.ts";
import type { AudioInputFactory, RankedInput } from "../core/devicecapture.ts";
import { autodetectInputs, listAudioDevices, parseChannelMap, InvalidArgumentError } from "../core/devicecapture.ts";
import { RemoteCapture } from "../core/capturelink.ts";
import type { CapturePort } from "../core/capturelink.ts";
import { buildReport, checkLines, footerLines, headerLines } from "../core/diagnostics.ts";
import type { AudioFacts, ConsoleFacts, DiagFacts } from "../core/diagnostics.ts";
import { EmulatedDesk } from "../core/emulator.ts";
import { Engine } from "../core/engine/index.ts";
import { MeterReceiver, SharedPortSink } from "../core/metersrv.ts";
import { fixed } from "../core/numfmt.ts";
import { qrAscii, qrEncode } from "../core/qr.ts";
import { AbleSetReceiver, SimShowClock } from "../core/showclock.ts";
import { defaultTemplate, fromObject } from "../core/template.ts";
import type { ShowTemplate } from "../core/template.ts";
import { HELP, UsageError, modeName, parseCliArgs, parseDevice, USAGE } from "./args.ts";
import type { Args } from "./args.ts";
import { Advisor } from "./advisor.ts";
import { bannerLines, emulatorLines } from "./banner.ts";
import { NativeAudioInputFactory } from "./audiodevice.ts";
import { AudioProbe, CLI_WINDOW_S, ConsoleProbe, moduleFacts, networkFacts, systemFacts } from "./diagnose.ts";
import { SystemClock, threadStamp } from "./clock.ts";
import { captureThread } from "./capturethread.ts";
import type { CaptureKind } from "./capturethread.ts";
import { findLayout } from "./layout.ts";
import type { Layout } from "./layout.ts";
import { lanIp } from "./netinfo.ts";
import { createServer, OpenDashboardRefused } from "./server.ts";
import type { DashboardServer } from "./server.ts";
import { SessionLog } from "./sessionlog.ts";
import { allLanIps, ensureCert, ensureTrustedCert, hostPermittedByCa, tlsHosts } from "./tls.ts";
import { NodeUdpFactory } from "./udp.ts";
import { UdpSink } from "./udpsink.ts";
import { VenueStore } from "./venuestore.ts";

const AUTO_CANDIDATES = 6;
const AUTO_DIGITAL_SILENCE_DB = -150;
const AUTO_SMALL_DEVICE_CH = 2;

function audioFactory(io: Pick<Io, "factory">): AudioInputFactory {
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
  connect: (kind: CaptureKind) => CapturePort;
  udp: NodeUdpFactory;
  waitForStop: () => Promise<void>;
  layout: Layout;
  diagnoseSeconds?: number;
  onListening?: (url: string) => void;
}

function fail(io: Io, ...lines: string[]): never {
  for (const l of lines) io.out(l);
  throw new Exit(2);
}

function loadShowTemplate(args: Args, io: Io): ShowTemplate {
  let t: ShowTemplate;
  try {
    t = args.template ? fromObject(JSON.parse(readFileSync(args.template, "utf8"))) : defaultTemplate();
    if (t.channels) applyChannelMap(t.channels);
  } catch (exc) {
    return fail(io, `  [!] show template error: ${exc instanceof Error ? exc.message : String(exc)}`);
  }
  if (t.channels) {
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
    if (exc instanceof InvalidArgumentError) return fail(io, `  [!] --channel-map: ${exc.message}`);
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

async function quietStop(source: RemoteCapture): Promise<void> {
  try {
    source.stop();
    await source.settled();
  } catch {
    return;
  }
}

export async function autodetectSource(io: Pick<Io, "factory" | "clock" | "out" | "connect">): Promise<RemoteCapture | null> {
  const factory = audioFactory(io);
  let cands;
  try {
    cands = autodetectInputs(factory);
  } catch (exc) {
    io.out(`  [!] --auto: ${exc instanceof Error ? exc.message : String(exc)}`);
    return null;
  }
  if (!cands.length) {
    io.out("  [!] --auto: no input devices found (install the audio module?) — the assistant will not listen to a real input.");
    return null;
  }
  const open = async (cand: RankedInput): Promise<RemoteCapture | null> => {
    const label = `[${cand.index}] ${cand.name} (${cand.hostapi}`;
    autoChannelMap(cand.channels);
    const source = new RemoteCapture({ connect: () => io.connect("native"), clock: io.clock, stamp: threadStamp, device: cand.index });
    try {
      source.start();
      await source.ready();
      await source.autoGain();
    } catch (exc) {
      io.out(`  [i] --auto: ${label}) won't open (${exc instanceof Error ? exc.name : "Error"}); trying next.`);
      await quietStop(source);
      return null;
    }
    if (source.autoDb === null) {
      io.out(`  [i] --auto: ${label}) opened but delivered no audio (mic busy?); trying next.`);
      await quietStop(source);
      return null;
    }
    return source;
  };
  const announce = (cand: RankedInput, source: RemoteCapture): void =>
    io.out(
      `  Auto input: [${cand.index}] ${cand.name} (${cand.hostapi}, ${cand.channels} ch) — mic ${fixed(source.autoDb ?? 0, 0)} dBFS, +${fixed(source.gainDb, 0)} dB`,
    );
  let silent: RankedInput | null = null;
  for (const cand of cands.slice(0, AUTO_CANDIDATES)) {
    const source = await open(cand);
    if (source === null) continue;
    if ((source.autoDb ?? 0) >= AUTO_DIGITAL_SILENCE_DB || cand.channels > AUTO_SMALL_DEVICE_CH) {
      announce(cand, source);
      return source;
    }
    io.out(`  [i] --auto: [${cand.index}] ${cand.name} is completely silent (muted or unplugged?); trying next.`);
    silent ??= cand;
    await quietStop(source);
  }
  if (silent !== null) {
    const source = await open(silent);
    if (source !== null) {
      announce(silent, source);
      io.out("  [!] --auto: every input was silent, so this one is a guess. Check the mic, or pick one with --audio-device.");
      return source;
    }
  }
  io.out("  [!] --auto: no input delivered audio. Close other apps using the mic");
  io.out("      (mixer editors, voice tools) and check the system's microphone permission, then restart.");
  return null;
}

function deviceSource(args: Args, chanMap: Map<number, number> | null, io: Io): RemoteCapture {
  return new RemoteCapture({
    connect: () => io.connect("native"),
    clock: io.clock,
    stamp: threadStamp,
    device: parseDevice(args.audioDevice),
    outputDevice: parseDevice(args.outputDevice),
    channelMap: chanMap,
    gainDb: args.inputGain,
  });
}

const engineTick = (): number => C.BLOCK / C.SAMPLE_RATE;

const WILDCARD_HOSTS = ["0.0.0.0", "::"];

interface ConsoleLink {
  con: OscConsole;
  rx: MeterReceiver;
}

function consoleLink(io: Io, consoleIp: string, listenIp: string, allowFrom: string | null): ConsoleLink {
  const rx = new MeterReceiver(io.udp, { ip: listenIp, allowFrom });
  const sink = new SharedPortSink(rx, { host: consoleIp, port: C.CONSOLE_PORT }, new UdpSink(consoleIp, C.CONSOLE_PORT));
  return { con: new OscConsole(sink, { clock: io.clock, ip: consoleIp }), rx };
}

function wireMeters(engine: Engine, rx: MeterReceiver): void {
  rx.onFader = (ch, db) => engine.reconcileFader(ch, db);
  rx.onMeters = (vals) => engine.setConsoleMeters(vals);
  engine.meterRx = rx;
}

function buildEmulated(
  args: Args,
  template: ShowTemplate,
  chanMap: Map<number, number> | null,
  auto: RemoteCapture | null,
  io: Io,
): { engine: Engine; emu: EmulatedDesk } {
  const emu = new EmulatedDesk(io.udp, io.clock, {
    externalMoves: true,
    listenHost: WILDCARD_HOSTS.includes(args.host) ? "0.0.0.0" : "127.0.0.1",
    nodeScn: readScn(io),
    onTrace: args.traceOsc ? (l) => io.out(l) : null,
  });
  for (const s of template.songs) if (s.scene !== null) emu.sceneNames.set(s.scene, s.name);
  const { con, rx } = consoleLink(io, "127.0.0.1", "127.0.0.1", "127.0.0.1");
  let source: RemoteCapture;
  if (auto !== null) {
    source = auto;
  } else if (args.audioDevice !== null) {
    source = deviceSource(args, chanMap, io);
    io.out("  Listening on a REAL audio device against the emulated desk." + (args.inputGain ? `  (+${fixed(args.inputGain, 0)} dB input)` : ""));
  } else {
    source = new RemoteCapture({ connect: () => io.connect("timed"), clock: io.clock, stamp: threadStamp });
  }
  const engine = new Engine({ console: con, sim: false, source, tick: engineTick(), template, clock: io.clock });
  wireMeters(engine, rx);
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
  auto: RemoteCapture | null,
  io: Io,
): Engine {
  const ip = args.consoleIp || C.CONSOLE_IP;
  const { con, rx } = consoleLink(io, ip, "0.0.0.0", isIP(ip) !== 0 ? ip : null);
  let source: RemoteCapture | null = auto;
  if (source === null && args.audioDevice !== null) source = deviceSource(args, chanMap, io);
  const engine = new Engine({ console: con, sim: false, source, tick: engineTick(), template, clock: io.clock });
  wireMeters(engine, rx);
  if (args.ablesetPort !== null) {
    engine.showClock = new AbleSetReceiver(io.udp, (s) => engine.onSongChange(s), "0.0.0.0", args.ablesetPort, args.ablesetFrom);
    io.out(
      args.ablesetFrom !== null
        ? `  AbleSet: accepting song changes only from ${args.ablesetFrom}.`
        : "  AbleSet: accepting song changes from the first computer that sends them (pin it with --ableset-from <ip>).",
    );
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
  let slog: SessionLog;
  try {
    slog = new SessionLog(db);
    slog.startSession(args.venue, templateName, modeName(args));
  } catch (exc) {
    return fail(
      io,
      `  [!] Could not open the session log '${db}': ${exc instanceof Error ? exc.message : String(exc)}`,
      "      Pick a writable path with --session-db, or turn logging off with --session-db off.",
    );
  }
  engine.sessionLog = slog;
  io.out(`  Session log: ${db}` + (args.venue ? `  (venue: ${args.venue})` : ""));
}

function attachVenue(engine: Engine, args: Args, io: Io): void {
  if (!args.venue) return;
  const store = new VenueStore(join(io.layout.appDir, "venues"));
  engine.venue = args.venue;
  engine.venueStore = store;
  const model = store.load(args.venue);
  if (store.lastProblem) io.out(`  [!] Venue '${args.venue}': ${store.lastProblem}`);
  if (model === null) {
    const learns = engine.sessionLog !== null;
    io.out(`  Venue '${args.venue}': no model yet — ${learns ? "will learn after this show" : "it is not learned while the session log is off"}.`);
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
    onError: (m) => engine.assistant.emit("system", `advisor unavailable: ${m}`),
  });
  if (adv.available) {
    engine.advisor = adv;
    io.out("  Claude advisor: ON (advisory notes only)");
  } else {
    io.out("  [!] --advisor requested but ANTHROPIC_API_KEY is not set; advisor disabled.");
  }
}

function fileStamp(path: string): string {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
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
      const caBefore = fileStamp(join(certdir, "ca.pem"));
      const [c, k, ca] = ensureTrustedCert(certdir, hosts);
      if (fileStamp(ca) !== caBefore) {
        io.out("  [i] A new local root CA was created: install it again on every device (see the steps below).");
      }
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
      io.out(`TrioMixAssistant: error: ${exc.message}`);
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

const EMULATED_FEED = "no real input is selected, so the emulator's built-in audio feed stands in";
const NO_INPUT = "no audio input is selected (manual control only)";
const SIMULATED_STAGE = "simulation mode uses a built-in stage, so no real input is opened (add --audio-device <number> to check one)";

const modeLabel = (args: Args): string =>
  args.emulate
    ? "emulated console (this does not prove anything about a real console)"
    : args.hardware
      ? `hardware, console at ${args.consoleIp || C.CONSOLE_IP}`
      : args.diagnose && (args.audioDevice || args.auto)
        ? "simulation, checking one real audio input (no console)"
        : "simulation (nothing real is checked except the audio module)";

function fitMapToInput(args: Args, io: Io): void {
  let inputs: number;
  try {
    inputs = audioFactory(io).queryDevice(parseDevice(args.audioDevice)).max_input_channels ?? 0;
  } catch {
    return;
  }
  if (inputs < 1 || inputs >= Math.max(...C.CHANNELS.keys())) return;
  autoChannelMap(inputs);
  io.out(`  Checking this input on its own, so the channel map is fitted to its ${inputs} input${inputs === 1 ? "" : "s"}.`);
}

async function runDiagnose(args: Args, io: Io): Promise<number> {
  const head = { ...systemFacts(), mode: modeLabel(args) };
  for (const l of headerLines(head)) io.out(l);
  loadShowTemplate(args, io);
  const chanMap = loadChannelMap(args, io);
  const real = args.emulate || args.hardware;
  if (!real && !args.auto && args.audioDevice !== null && chanMap === null) fitMapToInput(args, io);
  const seconds = io.diagnoseSeconds ?? CLI_WINDOW_S;
  let emu: EmulatedDesk | null = null;
  let consoleProbe: ConsoleProbe | null = null;
  let audioProbe: AudioProbe | null = null;
  let audio: AudioFacts | null = null;
  let consoleFacts: ConsoleFacts | null = null;
  let audioSkipped = !real ? SIMULATED_STAGE : args.emulate ? EMULATED_FEED : NO_INPUT;
  let listened = false;
  const listen = async (): Promise<void> => {
    if (listened || (audioProbe === null && consoleProbe === null)) return;
    listened = true;
    io.out(`  Listening for ${seconds} seconds. Nothing on the console is changed and no sound is played.`);
    await io.clock.sleep(seconds);
  };
  try {
    if (args.auto || args.audioDevice !== null) {
      const auto = args.auto ? await autodetectSource(io) : null;
      const source = auto ?? (args.audioDevice !== null ? deviceSource(args, chanMap, io) : null);
      if (source !== null) {
        audioProbe = new AudioProbe(source, io.clock);
        await audioProbe.start(auto !== null);
      } else {
        audioSkipped = "--auto found no input that delivers audio (see the lines above)";
      }
    }
    if (real) {
      const ip = args.emulate ? "127.0.0.1" : args.consoleIp || C.CONSOLE_IP;
      let emuError: string | null = null;
      if (args.emulate) {
        emu = new EmulatedDesk(io.udp, io.clock, { externalMoves: false, listenHost: "127.0.0.1", nodeScn: readScn(io) });
        try {
          await emu.start();
        } catch (exc) {
          emuError = `the emulator could not start: ${exc instanceof Error ? exc.message : String(exc)}`;
          emu = null;
        }
      }
      if (emuError === null) {
        const link = consoleLink(io, ip, args.emulate ? "127.0.0.1" : "0.0.0.0", isIP(ip) !== 0 ? ip : null);
        consoleProbe = new ConsoleProbe(link.con, link.rx, io.clock);
        await consoleProbe.start();
      } else {
        consoleFacts = { emulated: true, address: ip, listening: false, listenError: emuError, windowS: 0, packets: 0, meters: 0 };
      }
      if (consoleProbe !== null) {
        await listen();
        consoleFacts = consoleProbe.facts(args.emulate, ip);
      }
    }
    await listen();
    if (audioProbe !== null) audio = audioProbe.facts(args.auto || chanMap === null ? null : [...chanMap.keys()]);
  } finally {
    await attempt(async () => {
      if (audioProbe !== null) await audioProbe.stop();
    });
    await attempt(async () => {
      if (consoleProbe !== null) consoleProbe.stop();
    });
    await attempt(async () => {
      if (emu !== null) emu.stop();
    });
  }
  const facts: DiagFacts = {
    ...head,
    audioModule: moduleFacts(io.factory),
    audio,
    audioSkipped,
    console: consoleFacts,
    network: networkFacts(args, await lanIp()),
  };
  const report = buildReport(facts);
  for (const l of [...report.checks.flatMap(checkLines), ...footerLines(report.checks)]) io.out(l);
  return report.result === "fail" ? 1 : 0;
}

async function attempt(step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (exc) {
    console.error(`  [!] shutdown step failed: ${exc instanceof Error ? exc.message : String(exc)}`);
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
  if (args.diagnose) return runDiagnose(args, io);

  const template = loadShowTemplate(args, io);
  const chanMap = loadChannelMap(args, io);
  const auto = args.auto ? await autodetectSource(io) : null;

  let emu: EmulatedDesk | null = null;
  let engine: Engine | null = null;
  let server: DashboardServer | null = null;
  try {
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
      const lan = WILDCARD_HOSTS.includes(args.host);
      for (const l of emulatorLines(lan ? ip : null, emu.listenPort, args.traceOsc, lan)) io.out(l);
    }
    const plan = await prepareTls(args, ip, io);

    try {
      server = createServer({ engine, staticDir: io.layout.staticDir, pin: args.pin, caPem: plan.caPem, tls: plan.tls, allowOpen: args.insecureOpen });
    } catch (exc) {
      return fail(io, `  [!] ${exc instanceof Error ? exc.message : String(exc)}`);
    }
    try {
      await server.start(args.port, args.host);
    } catch (exc) {
      server = null;
      const message = exc instanceof Error ? exc.message : String(exc);
      if (exc instanceof OpenDashboardRefused) {
        return fail(io, `  [!] ${message}`, "      Add --pin <at least 6 characters> (PIN= in show.conf), or --insecure-open to allow it anyway.");
      }
      return fail(
        io,
        `  [!] Could not open the dashboard on port ${args.port}: ${message}`,
        `      Another copy already running? Try a different port:  --port ${args.port + 1}  (or PORT= in show.conf)`,
      );
    }
    await engine.start();
    const scheme = plan.tls ? "https" : "http";
    const usesEmulatedFeed = args.emulate && auto === null && args.audioDevice === null;
    const mapped = args.auto || chanMap === null ? null : [...chanMap.keys()];
    engine.diagHost = () => ({
      ...systemFacts(),
      mode: modeLabel(args),
      audioModule: moduleFacts(io.factory),
      audioSkipped: usesEmulatedFeed ? EMULATED_FEED : null,
      mappedChannels: mapped,
      consoleEmulated: args.emulate,
      network: networkFacts({ ...args, https: plan.tls !== null }, ip),
    });
    const url = `${scheme}://${ip}:${args.port}/`;
    const wildcard = WILDCARD_HOSTS.includes(args.host);
    const qr = wildcard && ip ? qrAscii(qrEncode(url).modules) : null;
    for (const l of bannerLines({
      args,
      scheme,
      ip: wildcard ? ip : null,
      altIps: allLanIps(ip).filter((a) => !args.trust || hostPermittedByCa(a)),
      caPath: join(io.layout.appDir, ".certs", "ca.pem"),
      qr,
    })) {
      io.out(l);
    }
    if (io.onListening) io.onListening(`${scheme}://127.0.0.1:${args.port}/`);
    await io.waitForStop();
    io.out("\nShutting down...");
    return 0;
  } finally {
    await attempt(async () => {
      if (server !== null) await server.stop();
    });
    await attempt(async () => {
      if (engine !== null) await engine.stop();
      else if (auto !== null) auto.stop();
    });
    await attempt(async () => {
      if (emu !== null) emu.stop();
    });
  }
}

export function installProcessHandlers(): void {
  const report = (label: string) => (err: unknown): void => {
    console.error(`  [!] ${label}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  };
  process.on("uncaughtException", report("unexpected error (continuing)"));
  process.on("unhandledRejection", report("unexpected rejection (continuing)"));
}

export function defaultIo(): Io {
  installProcessHandlers();
  const stopper = new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  return {
    out: (l) => console.log(l),
    clock: new SystemClock(),
    audio: () => NativeAudioInputFactory.create(),
    factory: null,
    connect: captureThread,
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
