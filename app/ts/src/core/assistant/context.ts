import type { Config } from "../config.ts";
import { NEG_INF } from "../util.ts";

export interface MixerPort {
  setEqNotch(ch: number, band: number, hz: number): void;
  setBusEq(band: number, hz: number, gainDb: number, q: number): void;
  setEqBand(ch: number, band: number, hz: number, gainDb: number, q: number, on: boolean): void;
  rampFaderDb(ch: number, startDb: number, endDb: number): number;
  nudgeGainDb(ch: number, currentDb: number, deltaDb: number): number;
  setPolarity(ch: number, inverted: boolean): void;
  clearChannelEq(ch: number): void;
}

export function need<T>(m: Map<number, T>, ch: number): T {
  const v = m.get(ch);
  if (v === undefined) throw new Error(`unknown channel ${ch}`);
  return v;
}

export const perChannelOf = <T>(cfg: Config, value: T): Map<number, T> => new Map([...cfg.CHANNELS.keys()].map((c) => [c, value]));

export const roleOf = (cfg: Config, ch: number | null): string | null => (ch === null ? null : (cfg.CHANNELS.get(ch) ?? null));

export const chanOf = (cfg: Config, ch: number): string => {
  const r = cfg.CHANNELS.get(ch);
  if (r === undefined) throw new Error(`unknown channel ${ch}`);
  return r;
};

export const roleLabelOf = (cfg: Config, ch: number): string => cfg.CHANNELS.get(ch) ?? `ch${ch}`;

export const coachKey = (kind: string, ch: number | null): string => `${kind}|${ch === null ? "" : ch}`;
export const pairKey = (a: number, b: number): string => `${a},${b}`;

export class MixState {
  enabled: Record<string, boolean>;
  faderDb: Map<number, number>;
  gainDb: Map<number, number>;
  nominalGain: Map<number, number>;
  lastMoveT: Map<number, number>;
  manualHoldUntil: Map<number, number>;
  roomConfidence = 1;

  constructor(cfg: Config) {
    this.enabled = { ...cfg.DEFAULT_ENABLED };
    this.faderDb = perChannelOf(cfg, 0);
    this.gainDb = perChannelOf(cfg, 20);
    this.nominalGain = perChannelOf(cfg, 20);
    this.lastMoveT = perChannelOf(cfg, NEG_INF);
    this.manualHoldUntil = perChannelOf(cfg, NEG_INF);
  }
}

export interface JobContext {
  readonly cfg: Config;
  readonly mixer: MixerPort;
  readonly state: MixState;
  coaching(): boolean;
  emit(kind: string, msg: string, ch?: number | null): void;
  recommend(kind: string, ch: number | null, text: string, persist?: boolean, meta?: Record<string, unknown>, key?: string): void;
  noteLatency(kind: string): void;
  locked(ch: number): boolean;
}
