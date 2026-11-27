import { C, defaultTuning } from "./config.ts";
import type { Tuning } from "./config.ts";

export class TuningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TuningError";
  }
}

export type TuningPath = { [S in keyof Tuning]: `${S}.${Extract<keyof Tuning[S], string>}` }[keyof Tuning];

export interface TuningOverride {
  path: string;
  value: number;
  source: string;
}

interface Tunable {
  path: TuningPath;
  min: number;
  max: number;
  int?: boolean;
}

export const TUNABLE: readonly Tunable[] = [
  { path: "ride.leadTargetDb", min: -40, max: 10 },
  { path: "ride.toleranceDb", min: 0.5, max: 6 },
  { path: "ride.rampMs", min: 50, max: 2000, int: true },
  { path: "ride.ema", min: 0.005, max: 0.5 },
  { path: "ride.minMoveDb", min: 0.01, max: 1 },
  { path: "ride.vocalIntervalS", min: 0.05, max: 5 },
  { path: "ride.balanceIntervalS", min: 0.1, max: 10 },
  { path: "manual.holdS", min: 1, max: 60 },
  { path: "manual.echoS", min: 0.1, max: 3 },
  { path: "manual.minDb", min: 0.1, max: 3 },
  { path: "manual.logIntervalS", min: 0.1, max: 10 },
  { path: "stage.riseDb", min: 1, max: 20 },
  { path: "stage.baselineEma", min: 0.0001, max: 0.1 },
  { path: "stage.warnIntervalS", min: 5, max: 600 },
  { path: "feedback.ringDb", min: 6, max: 30 },
  { path: "feedback.sustainBlocks", min: 1, max: 20, int: true },
  { path: "feedback.notchGainDb", min: -18, max: -3 },
  { path: "feedback.notchQ", min: 2, max: 20 },
  { path: "feedback.stableTol", min: 0.005, max: 0.2 },
  { path: "feedback.riseDb", min: 0, max: 3 },
  { path: "feedback.harmonicSustain", min: 0, max: 10, int: true },
  { path: "feedback.watchTol", min: 0.01, max: 0.2 },
  { path: "feedback.lowConf", min: 0, max: 1 },
  { path: "feedback.confFloor", min: 0.1, max: 1 },
  { path: "feedback.buildingStreak", min: 1, max: 20, int: true },
  { path: "feedback.notchRecentS", min: 0.5, max: 10 },
  { path: "room.ema", min: 0.01, max: 0.5 },
  { path: "room.quietDb", min: -80, max: -20 },
  { path: "room.loudDb", min: -40, max: 0 },
  { path: "room.loudMin", min: 0, max: 1 },
  { path: "room.flatMin", min: 0, max: 1 },
  { path: "room.lowConf", min: 0, max: 1 },
  { path: "room.lowConfWarnS", min: 5, max: 600 },
  { path: "clip.peakDbfs", min: -6, max: 0 },
  { path: "clip.trimDb", min: -6, max: -0.5 },
  { path: "clip.trimCooldownS", min: 0.05, max: 5 },
  { path: "clip.recoverS", min: 1, max: 120 },
  { path: "clip.recoverDb", min: 0.1, max: 3 },
  { path: "clip.recoverMarginDb", min: 1, max: 20 },
  { path: "clip.recentS", min: 0.5, max: 10 },
  { path: "calibration.durationS", min: 3, max: 20 },
  { path: "calibration.peakThreshDb", min: 1, max: 12 },
  { path: "calibration.predipDb", min: -6, max: 0 },
  { path: "calibration.predipCount", min: 0, max: 2, int: true },
  { path: "calibration.settleS", min: 0.2, max: 10 },
  { path: "calibration.minLevelDbfs", min: -80, max: -20 },
  { path: "calibration.roomQ", min: 1, max: 10 },
  { path: "calibration.predipQ", min: 2, max: 15 },
  { path: "phase.corrMin", min: 0.1, max: 0.9 },
  { path: "phase.invertCorr", min: -0.9, max: -0.1 },
  { path: "phase.combLagMs", min: 0.05, max: 3 },
  { path: "phase.maxLagMs", min: 0.5, max: 10 },
  { path: "phase.ema", min: 0.01, max: 0.5 },
  { path: "phase.sustain", min: 1, max: 50, int: true },
  { path: "phase.actCooldownS", min: 1, max: 60 },
  { path: "phase.warnIntervalS", min: 5, max: 600 },
  { path: "unmask.freq", min: 500, max: 8000 },
  { path: "unmask.q", min: 0.5, max: 5 },
  { path: "unmask.depthDb", min: -8, max: 0 },
  { path: "unmask.voxGateDb", min: -70, max: -10 },
  { path: "unmask.attack", min: 0.01, max: 1 },
  { path: "unmask.release", min: 0.005, max: 1 },
  { path: "unmask.writeEpsDb", min: 0.1, max: 2 },
  { path: "unmask.voxEma", min: 0.01, max: 1 },
  { path: "unmask.logDb", min: -8, max: 0 },
  { path: "unmask.logIntervalS", min: 1, max: 120 },
  { path: "coach.ttlS", min: 2, max: 60 },
  { path: "show.openingBars", min: 0, max: 32, int: true },
  { path: "show.openingFallbackS", min: 0, max: 60 },
  { path: "engine.deadCriticalS", min: 0.5, max: 10 },
  { path: "engine.latencyEma", min: 0.01, max: 1 },
  { path: "engine.perfEma", min: 0.01, max: 1 },
  { path: "engine.perfMaxDecay", min: 0.9, max: 1 },
  { path: "link.probeS", min: 0.25, max: 5 },
  { path: "link.staleS", min: 0.5, max: 10 },
  { path: "link.downS", min: 2, max: 30 },
  { path: "link.steadyS", min: 0.25, max: 10 },
  { path: "link.syncRetryS", min: 0.1, max: 5 },
  { path: "link.syncTries", min: 1, max: 10, int: true },
  { path: "link.resyncS", min: 1, max: 60 },
  { path: "safety.manualPerS", min: 20, max: 500, int: true },
  { path: "safety.autoPerS", min: 20, max: 500, int: true },
  { path: "safety.totalPerS", min: 50, max: 1000, int: true },
  { path: "safety.echoTolDb", min: 0.05, max: 2 },
  { path: "safety.lockMoves", min: 2, max: 20, int: true },
  { path: "safety.lockWindowS", min: 5, max: 600 },
  { path: "safety.commandPerS", min: 20, max: 1000, int: true },
];

function tunable(path: string): Tunable {
  const want = path.trim().toLowerCase();
  const hit = TUNABLE.find((t) => t.path.toLowerCase() === want);
  if (hit === undefined) throw new TuningError(`'${path.trim()}' is not a tuning setting (list them with --list-tuning)`);
  return hit;
}

const shown = (v: unknown): string => (typeof v === "number" ? String(Number(v.toPrecision(6))) : String(v));

function defaultValue(path: TuningPath): unknown {
  const [section, key] = path.split(".");
  return Reflect.get(Reflect.get(defaultTuning(), section ?? ""), key ?? "");
}

export function checkedOverride(path: string, raw: string | number, source: string): TuningOverride {
  const t = tunable(path);
  const text = String(raw).trim();
  const value = typeof raw === "number" ? raw : /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(value)) throw new TuningError(`${t.path} must be a number, not '${text}'`);
  if (t.int === true && !Number.isInteger(value)) throw new TuningError(`${t.path} must be a whole number, not ${text}`);
  if (value < t.min || value > t.max) throw new TuningError(`${t.path} = ${text} is outside ${t.min} to ${t.max}`);
  return { path: t.path, value, source };
}

export function parseOverride(text: string, source: string): TuningOverride {
  const at = text.indexOf("=");
  if (at <= 0) throw new TuningError(`'${text}' should look like section.name=value, for example feedback.ringDb=10`);
  return checkedOverride(text.slice(0, at), text.slice(at + 1), source);
}

function merged(overrides: readonly TuningOverride[]): Tuning {
  const t = defaultTuning();
  for (const o of overrides) {
    const [section, key] = tunable(o.path).path.split(".");
    if (section === undefined || key === undefined) continue;
    const next: Record<string, unknown> = { ...Reflect.get(t, section) };
    next[key] = o.value;
    Reflect.set(t, section, Object.freeze(next));
  }
  if (t.room.quietDb >= t.room.loudDb) {
    throw new TuningError(`room.quietDb (${t.room.quietDb}) must be below room.loudDb (${t.room.loudDb})`);
  }
  return t;
}

let active: readonly TuningOverride[] = [];

export function setTuning(overrides: readonly TuningOverride[]): void {
  const t = merged(overrides);
  Object.assign(C, t);
  active = overrides.map((o) => ({ ...o }));
}

export function activeTuning(): readonly TuningOverride[] {
  return active;
}

export function pinDefaultTuning(): () => void {
  const keep = active;
  Object.assign(C, defaultTuning());
  return () => setTuning(keep);
}

export function tuningLines(overrides: readonly TuningOverride[] = active): string[] {
  const last = new Map<string, TuningOverride>();
  for (const o of overrides) last.set(o.path, o);
  return [...last.values()].map((o) => `${o.path} = ${o.value} (default ${shown(defaultValue(tunable(o.path).path))}, from ${o.source})`);
}

export function tuningTable(): string {
  const rows = TUNABLE.map(
    (t) =>
      `  ${t.path.padEnd(28)} ${shown(defaultValue(t.path)).padStart(8)}   ${t.min} to ${t.max}${t.int === true ? ", whole numbers" : ""}`,
  );
  return ["Tuning settings (name, default, allowed range):", ...rows].join("\n");
}
