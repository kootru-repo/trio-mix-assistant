import type { CalibrationResult, CalibrationStep } from "../calibration.ts";
import { watchFreqs } from "../calibration.ts";
import type { Clock } from "../clock.ts";
import { C } from "../config.ts";
import type { ConsoleBase } from "../console.ts";
import type { ChannelFeatures } from "../dsp.ts";
import { fixed, percent, roundTo, signed } from "../numfmt.ts";

export interface AssistantEvent {
  time: string;
  kind: string;
  ch: number | null;
  role: string | null;
  msg: string;
  level?: string;
}

export interface CoachRec {
  seq: number;
  mono: number;
  persist: boolean;
  time: string;
  kind: string;
  ch: number | null;
  role: string | null;
  text: string;
  [meta: string]: unknown;
}

export type EventHandler = (ev: AssistantEvent) => void;
export type LatencyHandler = (kind: string, seconds: number) => void;

export interface AssistantOptions {
  calib?: CalibrationResult | null;
  onEvent?: EventHandler | null;
  onLatency?: LatencyHandler | null;
}

export interface PhaseStatus {
  a: number;
  b: number;
  corr: number;
  lag_ms: number;
  status: string;
  inv_a: boolean;
  inv_b: boolean;
}

export const NEG_INF = -1000000000;

export const role = (ch: number | null): string | null => (ch === null ? null : (C.CHANNELS.get(ch) ?? null));

export const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

export function need<T>(m: Map<number, T>, ch: number): T {
  const v = m.get(ch);
  if (v === undefined) throw new Error(`unknown channel ${ch}`);
  return v;
}

export const chan = (ch: number): string => {
  const r = C.CHANNELS.get(ch);
  if (r === undefined) throw new Error(`unknown channel ${ch}`);
  return r;
};

export const coachKey = (kind: string, ch: number | null): string => `${kind}|${ch === null ? "" : ch}`;
export const pairKey = (a: number, b: number): string => `${a},${b}`;

const perChannel = <T>(value: T): Map<number, T> => new Map([...C.CHANNELS.keys()].map((c) => [c, value]));

export class AssistantBase {
  clock: Clock;
  con: ConsoleBase;
  onEvent: EventHandler | null;
  onLatency: LatencyHandler | null;
  blockT0 = 0;
  enabled: Record<string, boolean> = { ...C.DEFAULT_ENABLED };
  leadTarget = C.LEAD_TARGET_DB;

  coachMode = false;
  coachRecs = new Map<string, CoachRec>();
  coachLastText = new Map<string, string>();
  private coachSeq = 0;

  faderDb: Map<number, number>;
  gainDb: Map<number, number>;
  nominalGain: Map<number, number>;

  fbStreak: Map<number, number>;
  usedNotchBand: Map<number, number>;
  usedBusNotchBand = 0;
  fbBusBands: number[] = [];
  calBusBands = new Set<number>();
  fbLastFreq: Map<number, number | null>;
  fbLastLevel: Map<number, number>;

  lastClipT: Map<number, number>;
  lastRecoverT: Map<number, number>;

  inEma: Map<number, number | null>;
  lastRideT: Map<number, number>;
  lastMoveT: Map<number, number>;
  stageBaseline: number | null = null;
  lastStageWarn = -1e9;
  roomLevelDb = -90;
  roomContrastDb = 0;
  roomConfidence = 1;
  lastLowconfWarn = -1e9;
  manualHoldUntil: Map<number, number>;
  balanceTargets = new Map<number, number>();

  polarity: Map<number, boolean>;
  phaseEma = new Map<string, number>();
  phaseLagEma = new Map<string, number>();
  phaseStreak = new Map<string, number>();
  phaseArmed = new Map<string, boolean>();
  phaseStatus = new Map<string, PhaseStatus>();
  lastPhaseAct = new Map<string, number>();
  lastPhaseWarn = new Map<string, number>();

  duckGain = 0;
  duckApplied = new Map<number, number>();
  voxLevelEma: number | null = null;
  lastUnmaskLog = -1e9;

  calib: CalibrationResult | null = null;
  watchFreqs: number[] = [];
  venueWatchFreqs: number[] = [];

  log: AssistantEvent[] = [];

  constructor(console: ConsoleBase, clock: Clock, opts: AssistantOptions = {}) {
    this.clock = clock;
    this.con = console;
    this.onEvent = opts.onEvent ?? null;
    this.onLatency = opts.onLatency ?? null;
    this.faderDb = perChannel(0);
    this.gainDb = perChannel(20);
    this.nominalGain = perChannel(20);
    this.fbStreak = perChannel(0);
    this.usedNotchBand = perChannel(0);
    this.fbLastFreq = perChannel<number | null>(null);
    this.fbLastLevel = perChannel(-90);
    this.lastClipT = perChannel(NEG_INF);
    this.lastRecoverT = perChannel(NEG_INF);
    this.inEma = perChannel<number | null>(null);
    this.lastRideT = perChannel(NEG_INF);
    this.lastMoveT = perChannel(NEG_INF);
    this.manualHoldUntil = perChannel(NEG_INF);
    this.polarity = perChannel(false);
    this.setCalibration(opts.calib ?? null);
  }

  setCalibration(calib: CalibrationResult | null): void {
    this.calib = calib;
    this.watchFreqs = calib ? watchFreqs(calib) : [];
  }

  emit(kind: string, msg: string, ch: number | null = null): void {
    const ev: AssistantEvent = { time: this.clock.hhmmss(), kind, ch, role: role(ch), msg };
    this.log.push(ev);
    if (this.log.length > 200) this.log.shift();
    if (this.onEvent) this.onEvent(ev);
  }

  setCoachMode(on: boolean): void {
    if (on === this.coachMode) return;
    this.coachMode = on;
    if (on) {
      this.releaseUnmask();
    } else {
      this.coachRecs.clear();
      this.coachLastText.clear();
    }
    this.emit(
      "system",
      on
        ? "coach mode ON — the assistant advises every automatic move (mix " +
            "corrections, scene recall, guest mutes) instead of applying it; " +
            "only your own manual moves act"
        : "coach mode off",
    );
  }

  recommend(
    kind: string,
    ch: number | null,
    text: string,
    persist: boolean = false,
    meta: Record<string, unknown> = {},
  ): void {
    this.coachSeq += 1;
    const key = coachKey(kind, ch);
    this.coachRecs.set(key, {
      seq: this.coachSeq,
      mono: this.clock.monotonic(),
      persist,
      time: this.clock.hhmmss(),
      kind,
      ch,
      role: role(ch),
      text,
      ...meta,
    });
    if (this.coachLastText.get(key) !== text) {
      this.coachLastText.set(key, text);
      this.emit("coach", text, ch);
    }
  }

  coachSnapshot(now: number | null = null): CoachRec[] {
    const t = now ?? this.clock.monotonic();
    const live: CoachRec[] = [];
    for (const key of [...this.coachRecs.keys()]) {
      const rec = this.coachRecs.get(key)!;
      if (!rec.persist && t - rec.mono > C.COACH_TTL_S) {
        this.coachRecs.delete(key);
        this.coachLastText.delete(key);
      } else {
        live.push(rec);
      }
    }
    live.sort((a, b) => b.seq - a.seq);
    return live;
  }

  coachCalibration(steps: CalibrationStep[]): void {
    if (!steps.length) {
      this.recommend("calibration", null, "Room measured — no problem peaks; leave the main bus flat.", true, {
        steps: [],
      });
      return;
    }
    const parts = steps.map(
      (s) =>
        `band ${s.band} ${fixed(s.hz, 0)} Hz ${signed(s.gain, 1)} dB (Q ${fixed(s.q, 0)})` +
        (s.kind === "room" ? "" : " pre-dip"),
    );
    const text = "Room calibration → set MAIN-BUS PEQ: " + parts.join("; ") + ".";
    this.recommend("calibration", null, text, true, {
      steps: steps.map((s) => ({ band: s.band, hz: roundTo(s.hz, 1), gain: s.gain, q: s.q, kind: s.kind })),
    });
  }

  noteLatency(kind: string): void {
    if (this.onLatency) this.onLatency(kind, this.clock.perfCounter() - this.blockT0);
  }

  noteManual(ch: number, now: number, hold: number = 5.0): void {
    this.manualHoldUntil.set(ch, now + hold);
  }

  unmaskTargets(): number[] {
    if (C.UNMASK_CHANNELS.length) return C.UNMASK_CHANNELS.filter((c) => C.CHANNELS.has(c));
    const exclude = new Set<number | null>([C.LEAD_VOCAL_CH, C.MEAS_MIC_CH, C.STAGE_MIC_CH]);
    return [...C.CHANNELS.keys()].filter((c) => !exclude.has(c));
  }

  releaseUnmask(): void {
    for (const ch of [...this.duckApplied.keys()]) {
      this.con.setEqBand(ch, C.UNMASK_BAND, C.UNMASK_FREQ, 0.0, C.UNMASK_Q, true);
    }
    this.duckApplied.clear();
    this.duckGain = 0;
  }

  static roomConf(levelDb: number, contrastDb: number): number {
    const loud = levelDb <= -45 ? 1 : levelDb >= -15 ? 0.3 : 1 - (0.7 * (levelDb + 45)) / 30;
    const flat = contrastDb >= C.FB_RING_DB ? 1 : Math.max(0.5, contrastDb / C.FB_RING_DB);
    return roundTo(loud * flat, 3);
  }

  updateRoom(feat: ChannelFeatures, now: number): void {
    const a = 1 / 12;
    this.roomLevelDb = (1 - a) * this.roomLevelDb + a * feat.rmsDbfs;
    this.roomContrastDb = (1 - a) * this.roomContrastDb + a * feat.contrastDb;
    this.roomConfidence = AssistantBase.roomConf(this.roomLevelDb, this.roomContrastDb);
    if (this.roomConfidence < 0.5 && now - this.lastLowconfWarn > 30.0) {
      this.lastLowconfWarn = now;
      this.emit(
        "system",
        `room-mic SNR low (conf ${percent(this.roomConfidence, 0)}) — feedback detection is being more conservative`,
        C.MEAS_MIC_CH,
      );
    }
  }

  snapshot(): Record<string, unknown> {
    const round1 = (m: Map<number, number>): Record<string, number> =>
      Object.fromEntries([...m].map(([c, v]) => [String(c), roundTo(v, 1)]));
    return {
      enabled: { ...this.enabled },
      coach_mode: this.coachMode,
      fader_db: round1(this.faderDb),
      gain_db: round1(this.gainDb),
      notch_bands: Object.fromEntries([...C.CHANNELS.keys()].map((c) => [String(c), need(this.usedNotchBand, c)])),
      lead_target: this.leadTarget,
      balance_targets: round1(this.balanceTargets),
    };
  }
}
