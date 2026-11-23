import type { CaptureStatus, Frame } from "./capture.ts";
import { CaptureSourceBase, simRoomCapture } from "./capture.ts";
import type { Clock } from "./clock.ts";
import { C, applyChannelMap, channelMapState, restoreChannelMapState } from "./config.ts";
import type { ChannelMapSpec } from "./config.ts";
import { ConsoleBase, dbToFader, faderToDb, freqToEqParam, qToParam } from "./console.ts";
import type { ChannelFeatures, PhaseRelation, Samples } from "./dsp.ts";
import { Engine } from "./engine/index.ts";
import { chFromFaderAddr } from "./metersrv.ts";
import { fixed } from "./numfmt.ts";
import { argFloat, argText } from "./oscargs.ts";
import { encodeMessage, oscInt } from "./oscwire.ts";
import type { OscArg } from "./oscwire.ts";
import { SeededRng } from "./rng.ts";
import type { ShowState } from "./showclock.ts";
import type { ShowTemplate } from "./template.ts";
import { clamp, zeroPad } from "./util.ts";

export type VetStatus = "pass" | "fail" | "skip";
export type VetProof = "real console" | "emulator" | "this computer" | "nothing";

export interface VetRow {
  id: string;
  area: string;
  title: string;
  status: VetStatus;
  proof: VetProof;
  detail: string;
  covers: string[];
}

export interface StepSpec {
  id: string;
  area: string;
  title: string;
  proof: VetProof;
  covers: string[];
}

export const TOLERANCE = 0.01;
export const ASK_TIMEOUT_S = 1.0;
const ASK_POLL_S = 0.02;
const METER_WAIT_S = 3.0;
export const READ_ATTEMPTS = 2;
export const RESTORE_ATTEMPTS = 4;

export class VetSkip extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VetSkip";
  }
}

export class VetFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VetFailure";
  }
}

export const must = (cond: boolean, message: string): void => {
  if (!cond) throw new VetFailure(message);
};

const near = (a: number, b: number): boolean => Math.abs(a - b) <= TOLERANCE;

const argsText = (args: readonly OscArg[]): string =>
  args.map((a) => (a.t === "f" ? fixed(a.v, 4) : a.t === "b" ? `<${a.v.length} bytes>` : argText(a))).join(" ");

export class VetLog {
  readonly lines: string[] = [];
  private readonly clock: Clock;
  private readonly t0: number;
  private readonly sink: ((line: string) => void) | null;
  private finished = 0;
  onProgress: ((done: number, title: string) => void) | null = null;

  constructor(clock: Clock, sink: ((line: string) => void) | null = null) {
    this.clock = clock;
    this.t0 = clock.monotonic();
    this.sink = sink;
  }

  began(title: string): void {
    if (this.onProgress !== null) this.onProgress(this.finished, title);
  }

  ended(title: string): void {
    this.finished += 1;
    if (this.onProgress !== null) this.onProgress(this.finished, title);
  }

  note(text: string): void {
    const line = `[${fixed(this.clock.monotonic() - this.t0, 3).padStart(9)}] ${text}`;
    this.lines.push(line);
    if (this.sink !== null) this.sink(line);
  }
}

export async function step(rows: VetRow[], log: VetLog, spec: StepSpec, body: () => Promise<string>): Promise<void> {
  log.note(`--- ${spec.id}: ${spec.title}`);
  log.began(spec.title);
  let status: VetStatus = "pass";
  let detail: string;
  try {
    detail = await body();
  } catch (exc) {
    status = exc instanceof VetSkip ? "skip" : "fail";
    detail = exc instanceof Error ? exc.message : String(exc);
  }
  log.note(`=== ${spec.id}: ${status.toUpperCase()} (${spec.proof}): ${detail}`);
  rows.push({ ...spec, status, detail });
  log.ended(spec.title);
}

export function skipRow(rows: VetRow[], log: VetLog, spec: StepSpec, reason: string): void {
  log.note(`=== ${spec.id}: SKIP: ${reason}`);
  rows.push({ ...spec, proof: "nothing", status: "skip", detail: reason });
  log.ended(spec.title);
}

class VetConsole extends ConsoleBase {
  private readonly emit: (addr: string, args: OscArg[]) => void;

  constructor(clock: Clock, emit: (addr: string, args: OscArg[]) => void) {
    super({ clock });
    this.emit = emit;
  }

  protected override send(addr: string, ...args: OscArg[]): void {
    this.emit(addr, args);
  }
}

export interface DeskOptions {
  transmit: (data: Uint8Array) => boolean;
  clock: Clock;
  log: VetLog;
  proof: VetProof;
  timeoutS?: number;
  stopped?: () => boolean;
}

export class Desk {
  readonly con: ConsoleBase;
  readonly proof: VetProof;
  readonly clock: Clock;
  readonly log: VetLog;
  meterPackets = 0;
  onFader: ((ch: number, db: number) => void) | null = null;
  holdMain: () => boolean = () => false;
  mainHeld = false;
  private readonly transmit: (data: Uint8Array) => boolean;
  private readonly timeoutS: number;
  private readonly stoppedFn: () => boolean;
  private readonly seen = new Map<string, OscArg[]>();

  constructor(opts: DeskOptions) {
    this.transmit = opts.transmit;
    this.clock = opts.clock;
    this.log = opts.log;
    this.proof = opts.proof;
    this.timeoutS = opts.timeoutS ?? ASK_TIMEOUT_S;
    this.stoppedFn = opts.stopped ?? (() => false);
    this.con = new VetConsole(opts.clock, (addr, args) => {
      this.send(addr, ...args);
    });
  }

  get stopped(): boolean {
    return this.stoppedFn();
  }

  receive(addr: string, args: readonly OscArg[]): void {
    if (addr.startsWith("/meters")) {
      this.meterPackets += 1;
      return;
    }
    this.log.note(`recv ${addr} ${argsText(args)}`);
    this.seen.set(addr, [...args]);
    const ch = chFromFaderAddr(addr);
    if (ch === null || this.onFader === null) return;
    const pos = argFloat(args[0]);
    if (pos !== null && Number.isFinite(pos)) this.onFader(ch, faderToDb(pos));
  }

  send(addr: string, ...args: OscArg[]): boolean {
    this.log.note(`send ${addr} ${argsText(args)}`);
    const ok = this.transmit(encodeMessage(addr, args));
    if (!ok) this.log.note(`send FAILED ${addr}`);
    return ok;
  }

  async ask(addr: string): Promise<OscArg[] | null> {
    this.seen.delete(addr);
    if (!this.send(addr)) return null;
    const t0 = this.clock.monotonic();
    for (;;) {
      const got = this.seen.get(addr);
      if (got !== undefined) return got;
      if (this.clock.monotonic() - t0 >= this.timeoutS) break;
      await this.clock.sleep(ASK_POLL_S);
    }
    this.log.note(`no answer to ${addr} within ${this.timeoutS} s`);
    return null;
  }

  async num(addr: string): Promise<number | null> {
    const got = await this.ask(addr);
    if (got === null) return null;
    const v = argFloat(got[0]);
    return v !== null && Number.isFinite(v) ? v : null;
  }

  async holds(addr: string, want: number): Promise<number | null> {
    let got: number | null = null;
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      got = await this.num(addr);
      if (got !== null && near(got, want)) return got;
    }
    return got;
  }

  async putBack(addr: string, arg: OscArg, was: number): Promise<number | null> {
    let got: number | null = null;
    for (let attempt = 0; attempt < RESTORE_ATTEMPTS; attempt++) {
      if (addr === `/${C.MAIN_BUS}/mix/on` && this.holdMain()) {
        this.log.note(`restore of ${addr} skipped: takeover is holding the main muted`);
        this.mainHeld = true;
        return was;
      }
      this.send(addr, arg);
      got = await this.num(addr);
      if (got !== null && near(got, was)) return got;
      this.log.note(`restore of ${addr} not confirmed (attempt ${attempt + 1} of ${RESTORE_ATTEMPTS})`);
    }
    return got;
  }

  async expect(addr: string, want: number): Promise<void> {
    const got = await this.holds(addr, want);
    this.log.note(`check ${addr}: expected ${fixed(want, 4)}, read ${got === null ? "nothing" : fixed(got, 4)}, tolerance ${TOLERANCE}`);
    if (got === null) throw new VetFailure(`${addr} gave no answer`);
    if (!near(got, want)) throw new VetFailure(`${addr}: expected ${fixed(want, 3)}, the console holds ${fixed(got, 3)}`);
  }
}

interface WriteCase {
  id: string;
  title: string;
  feature: string;
  group: "channel" | "gain" | "main" | "scene";
  addrs: string[];
  act: (before: Map<string, number>) => Map<string, number> | string;
}

async function writeCheck(rows: VetRow[], desk: Desk, area: string, wc: WriteCase): Promise<void> {
  const spec: StepSpec = { id: wc.id, area, title: wc.title, proof: desk.proof, covers: [`console:${wc.feature}`] };
  await step(rows, desk.log, spec, async () => {
    if (desk.stopped) throw new VetSkip("stopped before this step ran");
    const original = new Map<string, OscArg>();
    const before = new Map<string, number>();
    for (const addr of wc.addrs) {
      const got = await desk.ask(addr);
      const v = got === null ? null : argFloat(got[0]);
      if (got === null || v === null || !Number.isFinite(v)) {
        throw new VetSkip(`the console gave no usable answer to a read of ${addr}, so nothing was written`);
      }
      original.set(addr, got[0]!);
      before.set(addr, v);
    }
    const problems: string[] = [];
    let held = false;
    let result: Map<string, number> | string | null = null;
    try {
      result = wc.act(before);
      if (typeof result !== "string") {
        await desk.con.flushRamps();
        for (const [addr, want] of result) {
          const got = await desk.holds(addr, want);
          desk.log.note(`check ${addr}: wrote ${fixed(want, 4)}, read ${got === null ? "nothing" : fixed(got, 4)}, tolerance ${TOLERANCE}`);
          if (got === null) problems.push(`${addr} gave no answer after the write`);
          else if (!near(got, want)) problems.push(`${addr}: wrote ${fixed(want, 3)}, read back ${fixed(got, 3)}`);
        }
      }
    } finally {
      if (typeof result !== "string") {
        await desk.con.flushRamps();
        for (const [addr, was] of before) {
          desk.mainHeld = false;
          const now = await desk.putBack(addr, original.get(addr)!, was);
          if (desk.mainHeld) held = true;
          else if (now === null || !near(now, was)) {
            problems.push(`${addr} was NOT put back: it was ${fixed(was, 3)} and is now ${now === null ? "unknown" : fixed(now, 3)}`);
          }
        }
      }
    }
    if (typeof result === "string") throw new VetSkip(result);
    if (problems.length) throw new VetFailure(problems.join("; "));
    const n = result === null ? 0 : result.size;
    if (held) return `set ${n} value${n === 1 ? "" : "s"} and read ${n === 1 ? "it" : "each"} back; the main bus was left muted because TAKEOVER is holding it`;
    return `set ${n} value${n === 1 ? "" : "s"}, read ${n === 1 ? "it" : "each"} back, then put back what was there`;
  });
}

const lowered = (db: number, lo: number, hi: number): number | null => {
  const t = clamp(db - 6, lo, hi);
  return t < db - 0.05 ? t : null;
};

const FLOOR_STEP_DB = -80;

const nudged = (db: number): number => (db > FLOOR_STEP_DB - 4 ? Math.max(-90, db - 6) : FLOOR_STEP_DB);

const one = (addr: string, value: number): Map<string, number> => new Map([[addr, value]]);

function eqExpect(base: string, onAddr: string, hz: number, gainDb: number, q: number): Map<string, number> {
  return new Map([
    [`${base}/type`, 2],
    [`${base}/f`, freqToEqParam(hz)],
    [`${base}/g`, clamp((gainDb + 15) / 30, 0, 1)],
    [`${base}/q`, qToParam(q)],
    [onAddr, 1],
  ]);
}

const eqAddrs = (base: string, onAddr: string): string[] => [`${base}/type`, `${base}/f`, `${base}/g`, `${base}/q`, onAddr];

const headampAddr = (ch: number): string => `/headamp/${zeroPad(ch - 1, 3)}/gain`;
const SCENE_ADDR = "/-show/prepos/current";

function consoleCases(con: ConsoleBase, ch: number, label: string, send: (addr: string, arg: OscArg) => void): WriteCase[] {
  const p = `/ch/${zeroPad(ch, 2)}`;
  const fader = `${p}/mix/fader`;
  const bus = [...C.FX_BUSES.keys()][0] ?? 1;
  const sendAddr = `${p}/mix/${zeroPad(bus, 2)}/level`;
  const main = `/${C.MAIN_BUS}`;
  const fxrtn = `/fxrtn/${zeroPad(bus, 2)}/mix/fader`;
  return [
    {
      id: "con_fader_set",
      title: `Channel ${label} fader: set`,
      feature: "setFaderDb",
      group: "channel",
      addrs: [fader],
      act: (b) => {
        const db = faderToDb(b.get(fader)!);
        const t = lowered(db, C.FADER_MIN_DB, C.FADER_MAX_DB);
        if (t === null) return `the fader is at ${fixed(db, 1)} dB, at or below the lowest level the assistant sets (${C.FADER_MIN_DB} dB); raise it and run this again`;
        return one(fader, dbToFader(con.setFaderDb(ch, t)));
      },
    },
    {
      id: "con_fader_ramp",
      title: `Channel ${label} fader: smooth ride`,
      feature: "rampFaderDb",
      group: "channel",
      addrs: [fader],
      act: (b) => {
        const db = faderToDb(b.get(fader)!);
        const t = lowered(db, C.FADER_MIN_DB, C.FADER_MAX_DB);
        if (t === null) return `the fader is at ${fixed(db, 1)} dB, at or below the lowest level the assistant sets (${C.FADER_MIN_DB} dB); raise it and run this again`;
        return one(fader, dbToFader(con.rampFaderDb(ch, db, t, 120, 4)));
      },
    },
    {
      id: "con_fader_raw",
      title: `Channel ${label} fader: dashboard move`,
      feature: "setFaderRaw",
      group: "channel",
      addrs: [fader],
      act: (b) => {
        const db = faderToDb(b.get(fader)!);
        return one(fader, dbToFader(con.setFaderRaw(ch, nudged(db))));
      },
    },
    {
      id: "con_ch_mute",
      title: `Channel ${label} mute`,
      feature: "setChannelMute",
      group: "channel",
      addrs: [`${p}/mix/on`],
      act: (b) => {
        if (b.get(`${p}/mix/on`)! < 0.5) return "the channel is already muted; unmute it and run this again";
        con.setChannelMute(ch, true);
        return one(`${p}/mix/on`, 0);
      },
    },
    {
      id: "con_polarity",
      title: `Channel ${label} polarity`,
      feature: "setPolarity",
      group: "channel",
      addrs: [`${p}/preamp/invert`],
      act: (b) => {
        const inverted = b.get(`${p}/preamp/invert`)! >= 0.5;
        con.setPolarity(ch, !inverted);
        return one(`${p}/preamp/invert`, inverted ? 0 : 1);
      },
    },
    {
      id: "con_eq_notch",
      title: `Channel ${label} feedback notch (EQ band 1)`,
      feature: "setEqNotch",
      group: "channel",
      addrs: eqAddrs(`${p}/eq/1`, `${p}/eq/on`),
      act: () => {
        con.setEqNotch(ch, 1, 1000);
        return eqExpect(`${p}/eq/1`, `${p}/eq/on`, 1000, C.FB_NOTCH_GAIN_DB, C.FB_NOTCH_Q);
      },
    },
    {
      id: "con_eq_band",
      title: `Channel ${label} EQ band 2`,
      feature: "setEqBand",
      group: "channel",
      addrs: eqAddrs(`${p}/eq/2`, `${p}/eq/on`),
      act: () => {
        con.setEqBand(ch, 2, 2000, -3, 2, true);
        return eqExpect(`${p}/eq/2`, `${p}/eq/on`, 2000, -3, 2);
      },
    },
    {
      id: "con_eq_clear",
      title: `Channel ${label} EQ off`,
      feature: "clearChannelEq",
      group: "channel",
      addrs: [`${p}/eq/on`],
      act: (b) => {
        if (b.get(`${p}/eq/on`)! < 0.5) send(`${p}/eq/on`, oscInt(1));
        con.clearChannelEq(ch);
        return one(`${p}/eq/on`, 0);
      },
    },
    {
      id: "con_send",
      title: `Channel ${label} send to ${C.FX_BUSES.get(bus) ?? `bus ${bus}`}`,
      feature: "setSend",
      group: "channel",
      addrs: [sendAddr],
      act: (b) => {
        const db = faderToDb(b.get(sendAddr)!);
        const t = nudged(db);
        con.setSend(ch, bus, t);
        return one(sendAddr, dbToFader(t));
      },
    },
    {
      id: "con_gain",
      title: `Channel ${label} preamp gain`,
      feature: "nudgeGainDb",
      group: "gain",
      addrs: [headampAddr(ch)],
      act: (b) => {
        const cur = b.get(headampAddr(ch))! * 72 - 12;
        const delta = cur - 3 < C.HEADAMP_MIN_DB ? 1 : -3;
        return one(headampAddr(ch), (con.nudgeGainDb(ch, cur, delta) + 12) / 72);
      },
    },
    {
      id: "con_main_mute",
      title: "Main mute (takeover)",
      feature: "setMainMute",
      group: "main",
      addrs: [`${main}/mix/on`],
      act: (b) => {
        if (b.get(`${main}/mix/on`)! < 0.5) return "the main bus is already muted; unmute it and run this again";
        con.setMainMute(true);
        return one(`${main}/mix/on`, 0);
      },
    },
    {
      id: "con_main_fader",
      title: "Main fader",
      feature: "setMainFader",
      group: "main",
      addrs: [`${main}/mix/fader`],
      act: (b) => {
        const db = faderToDb(b.get(`${main}/mix/fader`)!);
        return one(`${main}/mix/fader`, dbToFader(con.setMainFader(nudged(db))));
      },
    },
    {
      id: "con_bus_eq",
      title: "Main-bus EQ band 6",
      feature: "setBusEq",
      group: "main",
      addrs: eqAddrs(`${main}/eq/6`, `${main}/eq/on`),
      act: () => {
        con.setBusEq(6, 1000, -3, 4);
        return eqExpect(`${main}/eq/6`, `${main}/eq/on`, 1000, -3, 4);
      },
    },
    {
      id: "con_fx_return",
      title: `${C.FX_BUSES.get(bus) ?? `FX ${bus}`} return level`,
      feature: "setFxReturn",
      group: "main",
      addrs: [fxrtn],
      act: (b) => {
        const db = faderToDb(b.get(fxrtn)!);
        const t = nudged(db);
        con.setFxReturn(bus, t);
        return one(fxrtn, dbToFader(t));
      },
    },
    {
      id: "con_scene",
      title: "Scene recall",
      feature: "recallScene",
      group: "scene",
      addrs: [SCENE_ADDR],
      act: (b) => {
        const n = Math.trunc(b.get(SCENE_ADDR)!) === 42 ? 43 : 42;
        con.recallScene(n);
        return one(SCENE_ADDR, n);
      },
    },
  ];
}

export interface ConsoleVetOptions {
  channel: number | null;
  main: boolean;
  gain: boolean;
}

const GROUP_OFF: Record<WriteCase["group"], string> = {
  channel: "not asked for: name a channel to test this on it",
  gain: "not asked for: also choose preamp gain, with a channel, to test it",
  main: "not asked for: also choose the main bus and FX return to test them (PA off)",
  scene: "a scene recall cannot be undone, so it is never sent to a real console here; recall a scene from the dashboard by hand",
};

export async function vetConsole(rows: VetRow[], desk: Desk, area: string, opts: ConsoleVetOptions): Promise<void> {
  const emulated = desk.proof === "emulator";
  let alive = false;
  await step(rows, desk.log, { id: "con_identity", area, title: "Console answers", proof: desk.proof, covers: ["feature:console-reply"] }, async () => {
    const got = await desk.ask("/xinfo");
    if (got === null) throw new VetFailure("no answer to an identity request; check the address, the cable or Wi-Fi, and that no firewall blocks UDP");
    alive = true;
    return `answered: ${argsText(got)}`;
  });
  const meters: StepSpec = { id: "con_meters", area, title: "Meters arrive", proof: desk.proof, covers: ["console:subscribeMeters"] };
  if (!alive) skipRow(rows, desk.log, meters, "the console did not answer");
  else {
    await step(rows, desk.log, meters, async () => {
      const start = desk.meterPackets;
      desk.con.subscribeMeters();
      const t0 = desk.clock.monotonic();
      while (desk.meterPackets === start && desk.clock.monotonic() - t0 < METER_WAIT_S) await desk.clock.sleep(0.05);
      must(desk.meterPackets > start, `no meter data arrived within ${METER_WAIT_S} s of subscribing`);
      return "meter data arrived after subscribing";
    });
  }
  const ch = opts.channel ?? 1;
  for (const wc of consoleCases(desk.con, ch, opts.channel === null ? "N" : String(ch), (addr, arg) => desk.send(addr, arg))) {
    const spec: StepSpec = { id: wc.id, area, title: wc.title, proof: desk.proof, covers: [`console:${wc.feature}`] };
    const wanted =
      wc.group === "channel"
        ? opts.channel !== null
        : wc.group === "gain"
          ? opts.channel !== null && opts.gain
          : wc.group === "main"
            ? opts.main
            : emulated;
    if (!wanted) skipRow(rows, desk.log, spec, GROUP_OFF[wc.group]);
    else if (!alive) skipRow(rows, desk.log, spec, "the console did not answer, so nothing was written");
    else await writeCheck(rows, desk, area, wc);
  }
}

const VET_MAP: ChannelMapSpec = {
  map: {
    "1": "lead_vox",
    "2": "harm_vox_l",
    "3": "harm_vox_r",
    "4": "acoustic_gtr",
    "5": "bass_di",
    "6": "bass_mic",
    "7": "guest_vox",
    "8": "meas_mic",
  },
  lead: 1,
  meas_mic: 8,
  balance: [4, 5],
  guest: [7],
  stereo_links: [[2, 3]],
  phase_pairs: [[5, 6]],
  stage_mic: null,
};

const vetTemplate = (): ShowTemplate => ({
  name: "vet",
  channels: null,
  songs: [
    { name: "Vet Song A", scene: 11, leadTarget: -14, balance: new Map(), guest: false },
    { name: "Vet Song B", scene: 12, leadTarget: null, balance: new Map(), guest: true },
  ],
});

class VetSource extends CaptureSourceBase {
  next: () => Frame = () => new Map();

  block(): Frame {
    return this.next();
  }

  override captureMeas(): Promise<Samples | null> {
    return Promise.resolve(simRoomCapture(new SeededRng(7)));
  }

  override status(): CaptureStatus {
    return { kind: "vet" };
  }
}

const feat = (over: Partial<ChannelFeatures>): ChannelFeatures => ({
  rmsDbfs: -30,
  peakDbfs: -20,
  fbFreq: null,
  contrastDb: 0,
  harmonicity: 0,
  spectrum: new Float64Array(0),
  ...over,
});

const song = (name: string, index: number): ShowState => ({
  songName: name,
  nextSong: "",
  section: "Verse",
  bpm: 120,
  playing: true,
  songIndex: index,
});

export interface SequenceOptions {
  externalMove: ((ch: number, db: number) => void) | null;
}

export async function vetSequence(rows: VetRow[], desk: Desk, opts: SequenceOptions): Promise<void> {
  const saved = channelMapState();
  applyChannelMap(VET_MAP);
  const area = "Features and sequences";
  const main = `/${C.MAIN_BUS}`;
  const make = (source: VetSource = new VetSource()): Engine => {
    const e = new Engine({ console: desk.con, sim: false, source, tick: 0.02, template: vetTemplate(), clock: desk.clock });
    desk.onFader = (ch, db) => e.reconcileFader(ch, db);
    return e;
  };
  let t = desk.clock.monotonic() + 1000;
  const T = (advance: number = 0.05): number => {
    t += advance;
    return t;
  };
  const S = (id: string, title: string, covers: string[], body: () => Promise<string>): Promise<void> =>
    step(rows, desk.log, { id, area, title, proof: desk.proof, covers }, async () => {
      if (desk.stopped) throw new VetSkip("stopped before this step ran");
      return body();
    });
  try {
    const e = make();
    await S("cmd_fader", "Dashboard fader move reaches the console", ["command:fader"], async () => {
      e.command({ type: "fader", ch: 1, db: -12 });
      await desk.expect("/ch/01/mix/fader", dbToFader(-12));
      return "channel 1 went to -12 dB on the console";
    });
    await S("cmd_fader_link", "A linked pair moves together", ["feature:stereo-link"], async () => {
      e.command({ type: "fader", ch: 2, db: -20 });
      await desk.expect("/ch/02/mix/fader", dbToFader(-20));
      await desk.expect("/ch/03/mix/fader", dbToFader(-20));
      return "channels 2 and 3 both went to -20 dB";
    });
    await S("cmd_mute", "Dashboard mute and unmute", ["command:mute"], async () => {
      e.command({ type: "mute", ch: 1, on: true });
      await desk.expect("/ch/01/mix/on", 0);
      e.command({ type: "mute", ch: 1, on: false });
      await desk.expect("/ch/01/mix/on", 1);
      return "channel 1 muted, then unmuted";
    });
    await S("cmd_master", "Dashboard master fader", ["command:master"], async () => {
      e.command({ type: "master", db: -6 });
      await desk.expect(`${main}/mix/fader`, dbToFader(-6));
      e.command({ type: "master", db: 0 });
      await desk.expect(`${main}/mix/fader`, dbToFader(0));
      return "the main fader went to -6 dB and back to 0 dB";
    });
    await S("cmd_eq", "Dashboard EQ band", ["command:eq"], async () => {
      e.command({ type: "eq", ch: 1, band: 2, hz: 1500, gain: -4, q: 3, on: true });
      await desk.expect("/ch/01/eq/2/f", freqToEqParam(1500));
      await desk.expect("/ch/01/eq/2/g", (-4 + 15) / 30);
      await desk.expect("/ch/01/eq/2/q", qToParam(3));
      await desk.expect("/ch/01/eq/on", 1);
      return "band 2 on channel 1: 1500 Hz, -4 dB, Q 3";
    });
    await S("cmd_eq_reset", "Dashboard EQ reset", ["command:eq_reset"], async () => {
      e.command({ type: "eq_reset", ch: 1 });
      await desk.expect("/ch/01/eq/2/g", 0.5);
      await desk.expect("/ch/01/eq/on", 0);
      return "channel 1 band 2 went flat and the channel EQ went off";
    });
    await S("cmd_send", "Dashboard FX send", ["command:send"], async () => {
      e.command({ type: "send", ch: 1, fx: 1, db: -15 });
      await desk.expect("/ch/01/mix/01/level", dbToFader(-15));
      return "channel 1 send 1 went to -15 dB";
    });
    await S("cmd_fx", "Dashboard FX return", ["command:fx"], async () => {
      e.command({ type: "fx", fx: 1, db: -8 });
      await desk.expect("/fxrtn/01/mix/fader", dbToFader(-8));
      return "FX return 1 went to -8 dB";
    });
    await S("cmd_scene", "Dashboard scene recall", ["command:scene"], async () => {
      e.command({ type: "scene", index: 7 });
      await desk.expect(SCENE_ADDR, 7);
      return "scene 7 was recalled";
    });
    await S("cmd_lead_target", "Lead target", ["command:lead_target"], async () => {
      e.command({ type: "lead_target", db: -16 });
      must(e.assistant.leadTarget === -16, `the lead target is ${e.assistant.leadTarget}, not -16`);
      return "lead target set to -16 dB";
    });
    await S("cmd_toggle", "Each job switches on and off", ["command:toggle"], async () => {
      const jobs = Object.keys(e.assistant.enabled);
      for (const job of jobs) {
        e.command({ type: "toggle", job, on: true });
        must(e.assistant.enabled[job] === true, `${job} did not switch on`);
        e.command({ type: "toggle", job, on: false });
        must(e.assistant.enabled[job] === false, `${job} did not switch off`);
      }
      return `switched: ${jobs.join(", ")}`;
    });
    await S("cmd_coach", "Coach mode advises and leaves the preamp gain alone", ["command:coach", "feature:coach"], async () => {
      e.command({ type: "coach", on: true });
      must(e.assistant.coachMode, "coach mode did not switch on");
      e.command({ type: "toggle", job: "clip", on: true });
      const before = await desk.num(headampAddr(4));
      e.assistant.onFeatures(4, feat({ peakDbfs: 0 }), T());
      const after = await desk.num(headampAddr(4));
      must(before !== null && after !== null && near(before, after), "the preamp gain changed, or could not be read, while coach mode was on");
      must(e.assistant.coachRecs.size > 0, "no recommendation was made for a clipping channel");
      e.command({ type: "coach", on: false });
      must(!e.assistant.coachMode, "coach mode did not switch off");
      return "a clipping channel produced a recommendation and its preamp gain did not change";
    });
    await S("cmd_panic", "Takeover mutes the main, holds the jobs, blocks scenes, then releases", ["command:panic", "feature:takeover"], async () => {
      e.command({ type: "panic", on: true });
      await desk.expect(`${main}/mix/on`, 0);
      must(e.status === "takeover", `status is '${e.status}', not takeover`);
      must(Object.values(e.assistant.enabled).every((on) => !on), "a job stayed on during takeover");
      const scene = await desk.num(SCENE_ADDR);
      e.command({ type: "scene", index: 9 });
      const after = await desk.num(SCENE_ADDR);
      must(scene !== null && after !== null && near(scene, after), "a scene was recalled, or could not be read, during takeover");
      e.command({ type: "panic", on: false });
      await desk.expect(`${main}/mix/on`, 1);
      must(e.status === "live", `status is '${e.status}' after release`);
      must(e.assistant.enabled["clip"] === true, "the jobs were not restored after release");
      return "main muted and unmuted; scene recall refused in between";
    });
    await S("cmd_balance_capture", "Balance capture", ["command:balance_capture"], async () => {
      e.onPushedBlock({ feats: new Map([[4, feat({})], [5, feat({})]]), phases: [] }, 0);
      e.command({ type: "balance_capture" });
      must(e.assistant.balanceTargets.size === 2, `captured ${e.assistant.balanceTargets.size} targets, expected 2`);
      return "captured a target for both balance channels";
    });
    await S("cmd_calibrate", "Calibration analyses a built-in test recording and writes the main-bus EQ", ["command:calibrate", "feature:calibration"], async () => {
      e.command({ type: "calibrate" });
      must(e.calibrationTask !== null, "calibration did not start");
      await e.calibrationTask;
      must(e.calibStatus === "done" && e.calib !== null, `calibration ended as '${e.calibStatus}'`);
      const plan = e.calib === null ? [] : e.calibrator.plan(e.calib);
      must(plan.length > 0, "the built-in test room produced no corrections");
      for (const s of plan) {
        await desk.expect(`${main}/eq/${s.band}/f`, freqToEqParam(s.hz));
        await desk.expect(`${main}/eq/${s.band}/g`, clamp((s.gain + 15) / 30, 0, 1));
      }
      await desk.expect(`${main}/eq/on`, 1);
      return `${plan.length} main-bus band(s) written from a built-in test recording (no sound was played)`;
    });
    await S("cmd_diagnose", "Run checks produces a report", ["command:diagnose"], async () => {
      e.diagHost = () => ({
        app: "vet",
        system: "vet",
        platform: "vet",
        home: null,
        mode: "vet",
        audioModule: { ok: true, inputs: 0, error: null },
        audioSkipped: "not part of this step",
        mappedChannels: null,
        consoleEmulated: desk.proof === "emulator",
        network: { lan: false, url: null, pin: false, https: false },
      });
      const status = (): unknown => {
        const d = e.snapshot()["diagnostics"];
        return typeof d === "object" && d !== null && "status" in d ? d.status : null;
      };
      e.command({ type: "diagnose" });
      must(status() === "running", `the checks did not start (status '${String(status())}')`);
      const t0 = desk.clock.monotonic();
      while (status() !== "done" && desk.clock.monotonic() - t0 < Engine.DIAG_WINDOW_S + 5) await desk.clock.sleep(0.1);
      must(status() === "done", `the report status is '${String(status())}'`);
      return "the read-only checks ran inside the engine and produced a report";
    });

    const j = make();
    let notchBand = 0;
    await S("job_feedback", "Feedback job: a ringing channel gets a notch", ["job:feedback"], async () => {
      j.setEnabled("feedback", true);
      for (let i = 0; i < 12 && notchBand === 0; i++) {
        j.assistant.onFeatures(4, feat({ fbFreq: 2500, rmsDbfs: -40 + i, contrastDb: 20 }), T());
        notchBand = j.assistant.usedNotchBand.get(4) ?? 0;
      }
      must(notchBand > 0, "a steady, rising 2500 Hz tone did not trigger a notch");
      await desk.expect(`/ch/04/eq/${notchBand}/f`, freqToEqParam(2500));
      await desk.expect(`/ch/04/eq/${notchBand}/g`, (C.FB_NOTCH_GAIN_DB + 15) / 30);
      await desk.expect("/ch/04/eq/on", 1);
      return `2500 Hz notched on channel 4, band ${notchBand}`;
    });
    let busBand = 0;
    await S("job_feedback_room", "Feedback job: a ringing room gets a main-bus notch", ["job:feedback-room"], async () => {
      for (let i = 0; i < 200 && busBand === 0; i++) {
        j.assistant.onFeatures(C.MEAS_MIC_CH, feat({ fbFreq: 800, rmsDbfs: -80 + 0.4 * i, contrastDb: 25 }), T());
        busBand = j.assistant.fbBusBands[0] ?? 0;
      }
      must(busBand > 0, "a steady, rising 800 Hz tone at the room mic did not trigger a main-bus notch");
      await desk.expect(`${main}/eq/${busBand}/f`, freqToEqParam(800));
      await desk.expect(`${main}/eq/${busBand}/g`, (C.FB_NOTCH_GAIN_DB + 15) / 30);
      return `800 Hz notched on the main bus, band ${busBand}`;
    });
    await S("cmd_reset_notches", "Reset notches clears them", ["command:reset_notches"], async () => {
      must(notchBand > 0 && busBand > 0, "the notches this step clears were not made");
      j.command({ type: "reset_notches" });
      await desk.expect("/ch/04/eq/on", 0);
      await desk.expect(`${main}/eq/${busBand}/g`, 0.5);
      return "the channel EQ went off and the main-bus band went flat";
    });
    await S("job_clip", "Clip job: trims a clipping preamp, then raises it again", ["job:clip"], async () => {
      j.setEnabled("clip", true);
      const start = j.assistant.gainDb.get(4) ?? 0;
      j.assistant.onFeatures(4, feat({ peakDbfs: 0 }), T());
      const trimmed = j.assistant.gainDb.get(4) ?? 0;
      must(trimmed < start, "a clipping channel was not trimmed");
      await desk.expect(headampAddr(4), (trimmed + 12) / 72);
      j.assistant.onFeatures(4, feat({ peakDbfs: -20 }), T(C.CLIP_RECOVER_S + 1));
      const restored = j.assistant.gainDb.get(4) ?? 0;
      must(restored > trimmed, "a clean channel did not get its gain back");
      await desk.expect(headampAddr(4), (restored + 12) / 72);
      return `gain trimmed to ${fixed(trimmed, 1)} dB, then raised to ${fixed(restored, 1)} dB`;
    });
    await S("job_vocal_ride", "Vocal ride job: a quiet lead vocal is raised", ["job:vocal_ride"], async () => {
      j.setEnabled("vocal_ride", true);
      const start = j.assistant.faderDb.get(C.LEAD_VOCAL_CH) ?? 0;
      j.assistant.onFeatures(C.LEAD_VOCAL_CH, feat({ rmsDbfs: -60 }), T());
      await desk.con.flushRamps();
      const now = j.assistant.faderDb.get(C.LEAD_VOCAL_CH) ?? 0;
      must(now > start, "a quiet lead vocal was not raised");
      await desk.expect(`/ch/${zeroPad(C.LEAD_VOCAL_CH, 2)}/mix/fader`, dbToFader(now));
      j.setEnabled("vocal_ride", false);
      return `lead fader raised to ${fixed(now, 1)} dB`;
    });
    await S("job_balance", "Balance job: the fader of a channel that drops is raised", ["job:balance"], async () => {
      j.onPushedBlock({ feats: new Map([[4, feat({})], [5, feat({})]]), phases: [] }, 0);
      j.setEnabled("balance", true);
      const start = j.assistant.faderDb.get(5) ?? 0;
      j.assistant.onFeatures(5, feat({ rmsDbfs: -55 }), T(2));
      await desk.con.flushRamps();
      const now = j.assistant.faderDb.get(5) ?? 0;
      must(now > start, "a channel that dropped was not raised");
      await desk.expect("/ch/05/mix/fader", dbToFader(now));
      j.setEnabled("balance", false);
      return `channel 5 fader raised to ${fixed(now, 1)} dB`;
    });
    await S("job_phase", "Phase job: an out-of-polarity pair is flipped", ["job:phase"], async () => {
      j.setEnabled("phase", true);
      const rel: PhaseRelation = { zeroCorr: -0.9, bestCorr: -0.9, lagSamples: 0, lagMs: 0 };
      for (let i = 0; i < C.PHASE_SUSTAIN + 4 && j.assistant.polarity.get(6) !== true; i++) j.assistant.handlePhase(5, 6, rel, T());
      must(j.assistant.polarity.get(6) === true, "an inverted pair was not flipped");
      await desk.expect("/ch/06/preamp/invert", 1);
      j.setEnabled("phase", false);
      return "channel 6 polarity was inverted";
    });
    await S("job_unmask", "Unmask job: another channel (2) dips while the lead vocal is up, and is released when the job is switched off", ["job:unmask"], async () => {
      j.setEnabled("unmask", true);
      for (let i = 0; i < 20; i++) j.assistant.onFeatures(C.LEAD_VOCAL_CH, feat({ rmsDbfs: -20 }), T());
      const applied = j.assistant.duckApplied.get(2);
      must(applied !== undefined && applied < -1, "no dip was applied while the vocal was up");
      const addr = `/ch/02/eq/${C.UNMASK_BAND}/g`;
      const held = await desk.num(addr);
      must(held !== null && held < 0.5 - 1 / 30, `the dip did not reach the console (${held === null ? "no answer" : fixed(held, 3)})`);
      j.setEnabled("unmask", false);
      await desk.expect(addr, 0.5);
      return "channel 2 EQ band dipped by more than 1 dB while the lead vocal was up, then returned to flat";
    });

    const src = new VetSource();
    const a = make(src);
    let sample = 0;
    const tone = (hz: number, amp: number, sign: number = 1): Float32Array => {
      const out = new Float32Array(C.BLOCK);
      for (let i = 0; i < C.BLOCK; i++) out[i] = sign * amp * Math.sin((2 * Math.PI * hz * (sample + i)) / C.SAMPLE_RATE);
      return out;
    };
    const run = (frame: () => Frame, blocks: number, done: () => boolean): void => {
      src.next = frame;
      for (let i = 0; i < blocks && !done(); i++) {
        const last = t;
        a.step(T(C.BLOCK / C.SAMPLE_RATE), last);
        sample += C.BLOCK;
      }
      src.next = () => new Map();
    };
    await S("audio_feedback", "Test audio: a rising tone is detected in the samples and notched", ["feature:audio-to-notch"], async () => {
      a.setEnabled("feedback", true);
      a.setEnabled("clip", false);
      let amp = 0.005;
      const notched = (): boolean => (a.assistant.usedNotchBand.get(4) ?? 0) > 0;
      run(() => new Map([[4, tone(2500, (amp *= 1.12))]]), 40, notched);
      must(notched(), "a rising 2500 Hz tone in the samples was not notched");
      const band = a.assistant.usedNotchBand.get(4) ?? 0;
      await desk.expect(`/ch/04/eq/${band}/f`, freqToEqParam(2500));
      await desk.expect("/ch/04/eq/on", 1);
      return `samples went through the analyser; 2500 Hz notched on channel 4, band ${band}`;
    });
    await S("audio_clip", "Test audio: a clipping signal is detected in the samples and trimmed", ["feature:audio-to-trim"], async () => {
      a.setEnabled("clip", true);
      const start = a.assistant.gainDb.get(5) ?? 0;
      const trimmed = (): boolean => (a.assistant.gainDb.get(5) ?? 0) < start;
      run(() => new Map([[5, tone(440, 1.0)]]), 4, trimmed);
      must(trimmed(), "full-scale samples were not treated as clipping");
      await desk.expect(headampAddr(5), ((a.assistant.gainDb.get(5) ?? 0) + 12) / 72);
      a.setEnabled("clip", false);
      return "full-scale samples went through the analyser; channel 5 preamp trimmed";
    });
    await S("audio_phase", "Test audio: an inverted pair is detected in the samples and flipped", ["feature:audio-to-polarity"], async () => {
      desk.send("/ch/06/preamp/invert", oscInt(0));
      a.setEnabled("phase", true);
      const flipped = (): boolean => a.assistant.polarity.get(6) === true;
      run(() => new Map([[5, tone(220, 0.2)], [6, tone(220, 0.2, -1)]]), C.PHASE_SUSTAIN + 8, flipped);
      must(flipped(), "an inverted pair in the samples was not flipped");
      await desk.expect("/ch/06/preamp/invert", 1);
      return "inverted samples went through the analyser; channel 6 polarity flipped";
    });

    const s = make();
    await S("show_song", "Song change: recalls the scene, sets the lead target, mutes the guest", ["feature:song-change"], async () => {
      s.onSongChange(song("Vet Song A", 0));
      await desk.expect(SCENE_ADDR, 11);
      must(s.assistant.leadTarget === -14, `the lead target is ${s.assistant.leadTarget}, not -14`);
      await desk.expect("/ch/07/mix/on", 0);
      s.onSongChange(song("Vet Song B", 1));
      await desk.expect(SCENE_ADDR, 12);
      await desk.expect("/ch/07/mix/on", 1);
      return "scene 11 then 12; guest channel muted, then unmuted for the guest song";
    });
    await S("show_song_coach", "Song change in coach mode recalls nothing", ["feature:song-change-coach"], async () => {
      s.setCoachMode(true);
      s.onSongChange(song("Vet Song A", 0));
      await desk.expect(SCENE_ADDR, 12);
      must(s.assistant.coachRecs.size > 0, "no recommendation was made");
      s.setCoachMode(false);
      return "the scene stayed at 12 and a recommendation was made";
    });
    const moved: StepSpec = { id: "show_console_move", area, title: "A fader moved on the console is picked up", proof: desk.proof, covers: ["feature:console-fader-sync"] };
    const move = opts.externalMove;
    if (move === null) {
      skipRow(rows, desk.log, moved, "needs a hand on the console: move a fader and watch the dashboard follow");
    } else {
      await S(moved.id, moved.title, moved.covers, async () => {
        desk.con.subscribeMeters();
        await desk.num("/ch/05/mix/fader");
        move(5, -7);
        const t0 = desk.clock.monotonic();
        const off = (): number => Math.abs((s.assistant.faderDb.get(5) ?? 0) + 7);
        while (off() > 0.1 && desk.clock.monotonic() - t0 < ASK_TIMEOUT_S) await desk.clock.sleep(ASK_POLL_S);
        must(off() <= 0.1, "the engine did not follow a fader moved on the console");
        return "channel 5 moved to -7 dB on the console and the engine followed";
      });
    }
  } finally {
    desk.onFader = null;
    restoreChannelMapState(saved);
  }
}

export interface SoundSource {
  captureMeas(seconds: number): Promise<Samples | null>;
  emitPinkNoise(samples: Float32Array): Promise<boolean>;
}

export const SOUND_MIN_DBFS = -50;
export const SOUND_MIN_RISE_DB = 6;

const levelOf = (x: Samples | null): number | null => {
  if (x === null || x.length === 0) return null;
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i]! * x[i]!;
  return 20 * Math.log10(Math.sqrt(sum / x.length) + 1e-9);
};

export interface SoundResult {
  ambientDb: number | null;
  noiseDb: number | null;
  played: boolean;
  capture: Samples | null;
}

export async function measureSound(source: SoundSource, noise: Float32Array, seconds: number): Promise<SoundResult> {
  const ambientDb = levelOf(await source.captureMeas(Math.min(2, seconds)));
  const played = await source.emitPinkNoise(noise);
  const capture = await source.captureMeas(seconds);
  return { ambientDb, noiseDb: levelOf(capture), played, capture };
}

export function soundVerdict(r: SoundResult): string {
  must(r.played, "the test noise could not be played; check the output device");
  must(r.noiseDb !== null, "nothing was captured from the measurement input");
  const noise = r.noiseDb ?? 0;
  must(noise > SOUND_MIN_DBFS, `the microphone heard only ${fixed(noise, 0)} dBFS during the noise (needs more than ${SOUND_MIN_DBFS}); raise the speaker or mic level`);
  const rise = r.ambientDb === null ? null : noise - r.ambientDb;
  must(rise === null || rise >= SOUND_MIN_RISE_DB, `the level rose only ${fixed(rise ?? 0, 1)} dB when the noise played, so the microphone may not be hearing the speakers`);
  return `heard ${fixed(noise, 0)} dBFS during the noise` + (rise === null ? " (the room level before the noise was not measured)" : `, ${fixed(rise, 0)} dB above the room before it`);
}

const TAG: Record<VetStatus, string> = { pass: "PASS", fail: "FAIL", skip: "SKIP" };

export function tableLines(rows: readonly VetRow[]): string[] {
  const out: string[] = [];
  let area = "";
  for (const r of rows) {
    if (r.area !== area) {
      area = r.area;
      out.push("", `  ${area}`);
    }
    out.push(`    [${TAG[r.status]}] ${r.title}${r.status === "pass" ? `  (proved on: ${r.proof})` : ""}`);
    out.push(`           ${r.detail}`);
  }
  return out;
}

export function summaryLines(rows: readonly VetRow[]): string[] {
  const count = (st: VetStatus, proof: VetProof | null = null): number =>
    rows.filter((r) => r.status === st && (proof === null || r.proof === proof)).length;
  return [
    "",
    `  Result: ${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped.`,
    `  Passed on a real console: ${count("pass", "real console")}. Passed on the built-in emulator only: ${count("pass", "emulator")}. Passed on this computer: ${count("pass", "this computer")}.`,
    "  A pass on the emulator proves the app's own logic. It does not prove a real console,",
    "  because the emulator was written from the same assumptions as the app.",
    "  The job steps start from a detector reading; the three test-audio steps start from samples.",
    "  No step uses sound from a real microphone unless --vet-sound is given.",
  ];
}

export const OPERATOR_STEPS: readonly string[] = [
  "Each console channel carries the instrument its label says (talk into each mic and watch its meter).",
  "Sound leaves the PA, and the measurement mic is where the audience will be.",
  "A fader moved by hand on the console shows on the dashboard within a second.",
  "A scene recalled from the dashboard is the scene you expect on the console.",
  "AbleSet on the playback computer changes the song on the dashboard.",
  "Mixing Station on a phone or tablet connects to the console alongside the app.",
  "The dashboard stays connected on the phone when its screen locks and wakes.",
];

export function operatorLines(): string[] {
  return ["", "  Check these by hand (the steps above cannot prove them):", ...OPERATOR_STEPS.map((s) => `    [ ] ${s}`)];
}
