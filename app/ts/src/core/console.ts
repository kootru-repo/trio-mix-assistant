import type { Clock } from "./clock.ts";
import { C } from "./config.ts";
import { encodeMessage, oscFloat, oscInt, oscStr } from "./oscwire.ts";
import type { OscArg } from "./oscwire.ts";
import { clamp, zeroPad } from "./util.ts";

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

const finite = (...xs: number[]): void => {
  for (const x of xs) if (!Number.isFinite(x)) throw new RangeError("non-finite value");
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
  gen: number;
  epoch: number;
}

export interface ConsoleOptions {
  clock?: Clock | null;
  ip?: string | null;
}

export abstract class ConsoleBase {
  protected readonly rampClock: Clock | null;
  readonly ip: string | null;
  private rampChain: Promise<void> = Promise.resolve();
  private rampGen = new Map<number, number>();
  private rampEpoch = 0;
  private closed = false;
  lastRampError: unknown = null;
  onError: ((exc: unknown) => void) | null = null;

  constructor(opts: ConsoleOptions = {}) {
    this.rampClock = opts.clock ?? null;
    this.ip = opts.ip ?? null;
  }

  protected abstract send(addr: string, ...args: OscArg[]): void;

  protected record(_event: Recorded): void {}

  close(): void {
    this.closed = true;
  }

  private bumpRamp(ch: number): number {
    const gen = (this.rampGen.get(ch) ?? 0) + 1;
    this.rampGen.set(ch, gen);
    return gen;
  }

  cancelRamps(): void {
    this.rampEpoch += 1;
  }

  query(addr: string): void {
    this.send(addr);
  }

  private writeFader(ch: number, db: number, lo: number, hi: number): number {
    finite(db);
    const v = clamp(db, lo, hi);
    this.send(`/ch/${zeroPad(ch, 2)}/mix/fader`, oscFloat(dbToFader(v)));
    this.record({ kind: "fader", ch, db: v });
    return v;
  }

  setFaderDb(ch: number, db: number): number {
    finite(db);
    this.bumpRamp(ch);
    return this.writeFader(ch, db, C.limits.faderMinDb, C.limits.faderMaxDb);
  }

  rampFaderDb(ch: number, startDb: number, endDb: number, ms: number = C.ride.rampMs, steps: number = 12): number {
    finite(startDb, endDb, ms, steps);
    const end = clamp(endDb, C.limits.faderMinDb, C.limits.faderMaxDb);
    const job: RampJob = { ch, startDb, endDb: end, ms, steps, gen: this.bumpRamp(ch), epoch: this.rampEpoch };
    this.rampChain = this.rampChain.then(() => this.runRamp(job)).catch((exc: unknown) => {
      this.lastRampError = exc;
      if (this.onError !== null) {
        try {
          this.onError(exc);
        } catch {
          return;
        }
      }
    });
    return end;
  }

  flushRamps(): Promise<void> {
    return this.rampChain;
  }

  private async runRamp(job: RampJob): Promise<void> {
    for (let i = 1; i <= job.steps; i++) {
      if (this.closed || job.epoch !== this.rampEpoch || job.gen !== this.rampGen.get(job.ch)) return;
      this.writeFader(job.ch, job.startDb + (job.endDb - job.startDb) * (i / job.steps), C.limits.faderMinDb, C.limits.faderMaxDb);
      if (this.rampClock) await this.rampClock.sleep(job.ms / 1000 / job.steps);
    }
  }

  nudgeGainDb(ch: number, currentDb: number, deltaDb: number): number {
    finite(currentDb, deltaDb);
    const next = clamp(currentDb + deltaDb, C.limits.headampMinDb, C.limits.headampMaxDb);
    this.send(`/headamp/${zeroPad(ch - 1, 3)}/gain`, oscFloat((next + 12) / 72));
    this.record({ kind: "gain", ch, db: next });
    return next;
  }

  private eqBand(base: string, hz: number, gainDb: number, q: number): void {
    finite(hz, gainDb, q);
    this.send(`${base}/type`, oscInt(2));
    this.send(`${base}/f`, oscFloat(freqToEqParam(hz)));
    this.send(`${base}/g`, oscFloat(clamp((gainDb + 15) / 30, 0, 1)));
    this.send(`${base}/q`, oscFloat(qToParam(q)));
  }

  setEqNotch(
    ch: number,
    band: number,
    hz: number,
    gainDb: number = C.feedback.notchGainDb,
    q: number = C.feedback.notchQ,
  ): void {
    this.eqBand(`/ch/${zeroPad(ch, 2)}/eq/${band}`, hz, gainDb, q);
    this.send(`/ch/${zeroPad(ch, 2)}/eq/on`, oscInt(1));
    this.record({ kind: "notch", ch, band, hz, gainDb, q });
  }

  setBusEq(band: number, hz: number, gainDb: number, q: number = 4.0): void {
    this.eqBand(`/${C.MAIN_BUS}/eq/${band}`, hz, gainDb, q);
    this.send(`/${C.MAIN_BUS}/eq/on`, oscInt(1));
    this.record({ kind: "bus_eq", band, hz, gainDb, q });
  }

  setEqBand(ch: number, band: number, hz: number, gainDb: number, q: number, on: boolean = true): void {
    const g = on ? gainDb : 0;
    this.eqBand(`/ch/${zeroPad(ch, 2)}/eq/${band}`, hz, g, q);
    if (on) this.send(`/ch/${zeroPad(ch, 2)}/eq/on`, oscInt(1));
    this.record({ kind: "eq_band", ch, band, hz, gainDb: g, q, on });
  }

  setSend(ch: number, bus: number, levelDb: number): void {
    finite(levelDb);
    this.send(`/ch/${zeroPad(ch, 2)}/mix/${zeroPad(bus, 2)}/level`, oscFloat(dbToFader(levelDb)));
    this.record({ kind: "send", ch, bus, levelDb });
  }

  setFxReturn(fx: number, levelDb: number): void {
    finite(levelDb);
    this.send(`/fxrtn/${zeroPad(fx, 2)}/mix/fader`, oscFloat(dbToFader(levelDb)));
    this.record({ kind: "fx_return", fx, levelDb });
  }

  recallScene(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index > 99) throw new RangeError("scene index must be an integer from 0 to 99");
    this.send("/-action/goscene", oscInt(index));
    this.record({ kind: "scene", index });
  }

  setMainMute(muted: boolean): void {
    this.send(`/${C.MAIN_BUS}/mix/on`, oscInt(muted ? 0 : 1));
    this.record({ kind: "main_mute", muted });
  }

  clearChannelEq(ch: number): void {
    this.send(`/ch/${zeroPad(ch, 2)}/eq/on`, oscInt(0));
    this.record({ kind: "eq_clear", ch });
  }

  setFaderRaw(ch: number, db: number): number {
    finite(db);
    this.bumpRamp(ch);
    return this.writeFader(ch, db, -90, 10);
  }

  setChannelMute(ch: number, muted: boolean): void {
    this.send(`/ch/${zeroPad(ch, 2)}/mix/on`, oscInt(muted ? 0 : 1));
    this.record({ kind: "ch_mute", ch, muted });
  }

  setPolarity(ch: number, inverted: boolean): void {
    this.send(`/ch/${zeroPad(ch, 2)}/preamp/invert`, oscInt(inverted ? 1 : 0));
    this.record({ kind: "polarity", ch, inverted });
  }

  setMainFader(db: number): number {
    finite(db);
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
  readonly failures?: number;
  send(data: Uint8Array): void;
  close(): void;
}

export class OscConsole extends ConsoleBase {
  private readonly sink: DatagramSink;

  constructor(sink: DatagramSink, opts: ConsoleOptions = {}) {
    super(opts);
    this.sink = sink;
  }

  get sendFailures(): number | null {
    return this.sink.failures ?? null;
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
  static readonly WIRE_LOG_MAX = 5000;
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
    if (this.wireLog.length > SimConsole.WIRE_LOG_MAX) this.wireLog.shift();
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
