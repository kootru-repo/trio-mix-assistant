import { configWith, defaultTuning } from "../src/core/config.ts";
import type { Config } from "../src/core/config.ts";
import { MixState } from "../src/core/assistant/context.ts";
import type { JobContext, MixerPort } from "../src/core/assistant/context.ts";
import type { ChannelFeatures } from "../src/core/dsp.ts";

export type MixerCall =
  | { op: "notch"; ch: number; band: number; hz: number }
  | { op: "busEq"; band: number; hz: number; gainDb: number; q: number }
  | { op: "eqBand"; ch: number; band: number; hz: number; gainDb: number; q: number; on: boolean }
  | { op: "ramp"; ch: number; startDb: number; endDb: number }
  | { op: "gain"; ch: number; currentDb: number; deltaDb: number }
  | { op: "polarity"; ch: number; inverted: boolean }
  | { op: "clearEq"; ch: number };

export class RecordingMixer implements MixerPort {
  calls: MixerCall[] = [];
  setEqNotch(ch: number, band: number, hz: number): void {
    this.calls.push({ op: "notch", ch, band, hz });
  }
  setBusEq(band: number, hz: number, gainDb: number, q: number): void {
    this.calls.push({ op: "busEq", band, hz, gainDb, q });
  }
  setEqBand(ch: number, band: number, hz: number, gainDb: number, q: number, on: boolean): void {
    this.calls.push({ op: "eqBand", ch, band, hz, gainDb, q, on });
  }
  rampFaderDb(ch: number, startDb: number, endDb: number): number {
    this.calls.push({ op: "ramp", ch, startDb, endDb });
    return endDb;
  }
  nudgeGainDb(ch: number, currentDb: number, deltaDb: number): number {
    this.calls.push({ op: "gain", ch, currentDb, deltaDb });
    return currentDb + deltaDb;
  }
  setPolarity(ch: number, inverted: boolean): void {
    this.calls.push({ op: "polarity", ch, inverted });
  }
  clearChannelEq(ch: number): void {
    this.calls.push({ op: "clearEq", ch });
  }
}

export interface Emitted {
  kind: string;
  msg: string;
  ch: number | null;
}

export interface Recommended {
  kind: string;
  ch: number | null;
  text: string;
  persist: boolean;
  meta: Record<string, unknown>;
}

export interface Harness {
  ctx: JobContext;
  cfg: Config;
  mixer: RecordingMixer;
  state: MixState;
  events: Emitted[];
  recs: Recommended[];
  latency: string[];
  coach: { on: boolean };
}

export function harness(over: Partial<Config> = {}): Harness {
  const cfg = configWith(over);
  const mixer = new RecordingMixer();
  const state = new MixState(cfg);
  const events: Emitted[] = [];
  const recs: Recommended[] = [];
  const latency: string[] = [];
  const coach = { on: false };
  const ctx: JobContext = {
    cfg,
    mixer,
    state,
    coaching: () => coach.on,
    emit: (kind, msg, ch = null) => events.push({ kind, msg, ch }),
    recommend: (kind, ch, text, persist = false, meta = {}) => recs.push({ kind, ch, text, persist, meta }),
    noteLatency: (kind) => latency.push(kind),
  };
  return { ctx, cfg, mixer, state, events, recs, latency, coach };
}

export function tuned<S extends keyof ReturnType<typeof defaultTuning>>(
  section: S,
  values: Partial<ReturnType<typeof defaultTuning>[S]>,
): Partial<Config> {
  const base = defaultTuning();
  const next: Partial<Config> = {};
  Reflect.set(next, section, Object.freeze({ ...base[section], ...values }));
  return next;
}

export const feat = (over: Partial<ChannelFeatures> = {}): ChannelFeatures => ({
  rmsDbfs: -30,
  peakDbfs: -20,
  fbFreq: null,
  contrastDb: 0,
  harmonicity: 0,
  spectrum: new Float64Array(0),
  ...over,
});
