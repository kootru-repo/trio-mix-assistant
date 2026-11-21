import type { Clock } from "./clock.ts";
import { C } from "./config.ts";
import { encodeMessage, oscFloat, oscInt, oscStr } from "./oscwire.ts";
import type { OscArg } from "./oscwire.ts";

export function dbToFader(db: number): number {
  if (db <= -90) return 0;
  let f: number;
  if (db < -60) f = (db + 90) / 480;
  else if (db < -30) f = (db + 70) / 160;
  else if (db < -10) f = (db + 50) / 80;
  else f = (db + 30) / 40;
  return Math.min(1, Math.max(0, f));
}

export function faderToDb(f: number): number {
  if (f <= 0) return -90;
  if (f < 0.0625) return f * 480 - 90;
  if (f < 0.25) return f * 160 - 70;
  if (f < 0.5) return f * 80 - 50;
  return f * 40 - 30;
}

export function freqToEqParam(hz: number): number {
  const h = Math.max(20, Math.min(20000, hz));
  return Math.log10(h / 20) / 3;
}

export const eqParamToFreq = (p: number): number => 20 * 10 ** (3 * p);

export function qToParam(q: number): number {
  const c = Math.max(0.3, Math.min(10, q));
  return (Math.log10(10) - Math.log10(c)) / (Math.log10(10) - Math.log10(0.3));
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const pad = (n: number, w: number): string => {
  const digits = String(Math.abs(Math.trunc(n)));
  return n < 0 ? "-" + digits.padStart(w - 1, "0") : digits.padStart(w, "0");
};

export type Recorded =
  | { kind: "fader"; ch: number; db: number }
  | { kind: "gain"; ch: number; db: number }
  | { kind: "notch"; ch: number; band: number; hz: number; gainDb: number; q: number }
  | { kind: "bus_eq"; band: number; hz: number; gainDb: number; q: number }
  | { kind: "eq_band"; ch: number; band: number; hz: number; gainDb: number; q: number; on: boolean }
  | { kind: "send"; ch: number; bus: number; levelDb: number }
  | { kind: "fx_return"; fx: number; levelDb: number }
  | { kind: "scene"; index: number }
  | { kind: "main_mute"; muted: boolean }
  | { kind: "eq_clear"; ch: number }
  | { kind: "ch_mute"; ch: number; muted: boolean }
  | { kind: "polarity"; ch: number; inverted: boolean }
  | { kind: "master"; db: number };

interface RampJob {
  ch: number;
  startDb: number;
  endDb: number;
  ms: number;
  steps: number;
}

export interface ConsoleOptions {
  clock?: Clock | null;
}

export abstract class ConsoleBase {
  protected readonly rampClock: Clock | null;
  private rampChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(opts: ConsoleOptions = {}) {
    this.rampClock = opts.clock ?? null;
  }

  protected abstract send(addr: string, ...args: OscArg[]): void;

  protected record(_event: Recorded): void {}

  close(): void {
    this.closed = true;
  }

  setFaderDb(ch: number, db: number): number {
    const v = clamp(db, C.FADER_MIN_DB, C.FADER_MAX_DB);
    this.send(`/ch/${pad(ch, 2)}/mix/fader`, oscFloat(dbToFader(v)));
    this.record({ kind: "fader", ch, db: v });
    return v;
  }

  rampFaderDb(ch: number, startDb: number, endDb: number, ms: number = C.RAMP_MS, steps: number = 12): number {
    const end = clamp(endDb, C.FADER_MIN_DB, C.FADER_MAX_DB);
    const job: RampJob = { ch, startDb, endDb: end, ms, steps };
    this.rampChain = this.rampChain.then(() => this.runRamp(job));
    return end;
  }

  flushRamps(): Promise<void> {
    return this.rampChain;
  }

  private async runRamp(job: RampJob): Promise<void> {
    for (let i = 1; i <= job.steps; i++) {
      if (this.closed) return;
      this.setFaderDb(job.ch, job.startDb + (job.endDb - job.startDb) * (i / job.steps));
      if (this.rampClock) await this.rampClock.sleep(job.ms / 1000 / job.steps);
    }
  }

  nudgeGainDb(ch: number, currentDb: number, deltaDb: number): number {
    const next = clamp(currentDb + deltaDb, C.HEADAMP_MIN_DB, C.HEADAMP_MAX_DB);
    this.send(`/headamp/${pad(ch - 1, 3)}/gain`, oscFloat((next + 12) / 72));
    this.record({ kind: "gain", ch, db: next });
    return next;
  }

  private eqBand(base: string, hz: number, gainDb: number, q: number): void {
    this.send(`${base}/type`, oscInt(2));
    this.send(`${base}/f`, oscFloat(freqToEqParam(hz)));
    this.send(`${base}/g`, oscFloat((gainDb + 15) / 30));
    this.send(`${base}/q`, oscFloat(qToParam(q)));
  }

  setEqNotch(
    ch: number,
    band: number,
    hz: number,
    gainDb: number = C.FB_NOTCH_GAIN_DB,
    q: number = C.FB_NOTCH_Q,
  ): void {
    this.eqBand(`/ch/${pad(ch, 2)}/eq/${band}`, hz, gainDb, q);
    this.send(`/ch/${pad(ch, 2)}/eq/on`, oscInt(1));
    this.record({ kind: "notch", ch, band, hz, gainDb, q });
  }

  setBusEq(band: number, hz: number, gainDb: number, q: number = 4.0): void {
    this.eqBand(`/${C.MAIN_BUS}/eq/${band}`, hz, gainDb, q);
    this.send(`/${C.MAIN_BUS}/eq/on`, oscInt(1));
    this.record({ kind: "bus_eq", band, hz, gainDb, q });
  }

  setEqBand(ch: number, band: number, hz: number, gainDb: number, q: number, on: boolean = true): void {
    this.eqBand(`/ch/${pad(ch, 2)}/eq/${band}`, hz, gainDb, q);
    this.send(`/ch/${pad(ch, 2)}/eq/on`, oscInt(on ? 1 : 0));
    this.record({ kind: "eq_band", ch, band, hz, gainDb, q, on });
  }

  setSend(ch: number, bus: number, levelDb: number): void {
    this.send(`/ch/${pad(ch, 2)}/mix/${pad(bus, 2)}/level`, oscFloat(dbToFader(levelDb)));
    this.record({ kind: "send", ch, bus, levelDb });
  }

  setFxReturn(fx: number, levelDb: number): void {
    this.send(`/fxrtn/${pad(fx, 2)}/mix/fader`, oscFloat(dbToFader(levelDb)));
    this.record({ kind: "fx_return", fx, levelDb });
  }

  recallScene(index: number): void {
    this.send("/-action/goscene", oscInt(index));
    this.record({ kind: "scene", index });
  }

  setMainMute(muted: boolean): void {
    this.send(`/${C.MAIN_BUS}/mix/on`, oscInt(muted ? 0 : 1));
    this.record({ kind: "main_mute", muted });
  }

  clearChannelEq(ch: number): void {
    this.send(`/ch/${pad(ch, 2)}/eq/on`, oscInt(0));
    this.record({ kind: "eq_clear", ch });
  }

  setFaderRaw(ch: number, db: number): number {
    const v = clamp(db, -90, 10);
    this.send(`/ch/${pad(ch, 2)}/mix/fader`, oscFloat(dbToFader(v)));
    this.record({ kind: "fader", ch, db: v });
    return v;
  }

  setChannelMute(ch: number, muted: boolean): void {
    this.send(`/ch/${pad(ch, 2)}/mix/on`, oscInt(muted ? 0 : 1));
    this.record({ kind: "ch_mute", ch, muted });
  }

  setPolarity(ch: number, inverted: boolean): void {
    this.send(`/ch/${pad(ch, 2)}/preamp/invert`, oscInt(inverted ? 1 : 0));
    this.record({ kind: "polarity", ch, inverted });
  }

  setMainFader(db: number): number {
    const v = clamp(db, -90, 10);
    this.send(`/${C.MAIN_BUS}/mix/fader`, oscFloat(dbToFader(v)));
    this.record({ kind: "master", db: v });
    return v;
  }

  subscribeMeters(): void {
    this.send(
      "/batchsubscribe",
      oscStr("/meters"),
      oscStr("/meters/1"),
      oscInt(0),
      oscInt(0),
      oscInt(10),
    );
    this.send("/xremote");
  }
}

export interface DatagramSink {
  send(data: Uint8Array): void;
  close(): void;
}

export class OscConsole extends ConsoleBase {
  private readonly sink: DatagramSink;

  constructor(sink: DatagramSink, opts: ConsoleOptions = {}) {
    super(opts);
    this.sink = sink;
  }

  protected override send(addr: string, ...args: OscArg[]): void {
    this.sink.send(encodeMessage(addr, args));
  }

  override close(): void {
    super.close();
    this.sink.close();
  }
}

export interface NotchRecord {
  band: number;
  hz: number;
  gainDb: number;
  q: number;
}

export interface EqBandRecord {
  hz: number;
  gainDb: number;
  q: number;
  on: boolean;
}

export class SimConsole extends ConsoleBase {
  wireLog: [string, ...OscArg[]][] = [];
  faderDb = new Map<number, number>();
  gainDb = new Map<number, number>();
  notches = new Map<number, NotchRecord[]>();
  busEq = new Map<number, { hz: number; gainDb: number; q: number }>();
  mainMuted = false;
  chMuted = new Map<number, boolean>();
  masterDb = 0;
  lastScene: number | null = null;
  eqBands = new Map<number, Map<number, EqBandRecord>>();
  sends = new Map<string, number>();
  fxReturns = new Map<number, number>();
  polarity = new Map<number, boolean>();

  protected override send(addr: string, ...args: OscArg[]): void {
    this.wireLog.push([addr, ...args]);
  }

  protected override record(e: Recorded): void {
    switch (e.kind) {
      case "fader":
        this.faderDb.set(e.ch, e.db);
        break;
      case "gain":
        this.gainDb.set(e.ch, e.db);
        break;
      case "notch": {
        const kept = (this.notches.get(e.ch) ?? []).filter((n) => n.band !== e.band);
        kept.push({ band: e.band, hz: e.hz, gainDb: e.gainDb, q: e.q });
        this.notches.set(e.ch, kept);
        break;
      }
      case "bus_eq":
        this.busEq.set(e.band, { hz: e.hz, gainDb: e.gainDb, q: e.q });
        break;
      case "main_mute":
        this.mainMuted = e.muted;
        break;
      case "scene":
        this.lastScene = e.index;
        break;
      case "polarity":
        this.polarity.set(e.ch, e.inverted);
        break;
      case "eq_clear":
        this.notches.set(e.ch, []);
        break;
      case "ch_mute":
        this.chMuted.set(e.ch, e.muted);
        break;
      case "master":
        this.masterDb = e.db;
        break;
      case "eq_band": {
        let m = this.eqBands.get(e.ch);
        if (!m) {
          m = new Map();
          this.eqBands.set(e.ch, m);
        }
        m.set(e.band, { hz: e.hz, gainDb: e.gainDb, q: e.q, on: e.on });
        break;
      }
      case "send":
        this.sends.set(`${e.ch},${e.bus}`, e.levelDb);
        break;
      case "fx_return":
        this.fxReturns.set(e.fx, e.levelDb);
        break;
    }
  }

  override rampFaderDb(ch: number, _startDb: number, endDb: number): number {
    return this.setFaderDb(ch, endDb);
  }

  notchFreqs(ch: number): number[] {
    return (this.notches.get(ch) ?? []).map((n) => n.hz);
  }

  predipFreqs(): number[] {
    return [...this.busEq.values()].filter((b) => b.gainDb < 0).map((b) => b.hz);
  }

  isTamed(ch: number, hz: number, tol: number = 0.05): boolean {
    if (hz <= 0) return false;
    const candidates = [...this.notchFreqs(ch), ...this.predipFreqs()];
    return candidates.some((f) => Math.abs(hz - f) / hz < tol);
  }
}
