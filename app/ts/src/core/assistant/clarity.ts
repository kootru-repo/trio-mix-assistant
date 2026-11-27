import type { ChannelFeatures, PhaseRelation } from "../dsp.ts";
import { fixed, roundHalfEven, roundTo, signed } from "../numfmt.ts";
import { pairKey, perChannelOf, roleLabelOf } from "./context.ts";
import type { JobContext } from "./context.ts";

export interface PhaseStatus {
  a: number;
  b: number;
  corr: number;
  lag_ms: number;
  status: string;
  inv_a: boolean;
  inv_b: boolean;
}

export class PhaseJob {
  readonly ctx: JobContext;
  polarity: Map<number, boolean>;
  phaseEma = new Map<string, number>();
  phaseLagEma = new Map<string, number>();
  phaseStreak = new Map<string, number>();
  phaseArmed = new Map<string, boolean>();
  phaseStatus = new Map<string, PhaseStatus>();
  lastPhaseAct = new Map<string, number>();
  lastPhaseWarn = new Map<string, number>();
  private readonly forget: (key: string) => void;

  constructor(ctx: JobContext, forget: (key: string) => void) {
    this.ctx = ctx;
    this.forget = forget;
    this.polarity = perChannelOf(ctx.cfg, false);
  }

  private warn(key: string, ch: number, msg: string, now: number): void {
    if (now - (this.lastPhaseWarn.get(key) ?? -1e9) > this.ctx.cfg.phase.warnIntervalS) {
      this.lastPhaseWarn.set(key, now);
      this.ctx.emit("phase", msg, ch);
    }
  }

  handle(a: number, b: number, rel: PhaseRelation, now: number): void {
    const C = this.ctx.cfg;
    if (!this.ctx.state.enabled["phase"]) return;
    const key = pairKey(a, b);
    const al = C.phase.ema;
    const ce = this.phaseEma.get(key);
    this.phaseEma.set(key, ce === undefined ? rel.zeroCorr : (1 - al) * ce + al * rel.zeroCorr);
    if (Math.abs(rel.bestCorr) >= C.phase.corrMin) {
      const le = this.phaseLagEma.get(key);
      this.phaseLagEma.set(key, le === undefined ? rel.lagMs : (1 - al) * le + al * rel.lagMs);
    }
    const corr = this.phaseEma.get(key)!;
    const lag = this.phaseLagEma.get(key) ?? 0;
    const adviceKey = `phase|${key}`;
    const ra = roleLabelOf(C, a);
    const rb = roleLabelOf(C, b);

    const inverted = corr < C.phase.invertCorr;
    const related = Math.abs(corr) >= C.phase.corrMin;
    const comb = related && !inverted && Math.abs(lag) > C.phase.combLagMs;
    const status = inverted ? "inverted" : comb ? "comb" : related ? "aligned" : "unrelated";

    if (inverted) {
      this.phaseStreak.set(key, (this.phaseStreak.get(key) ?? 0) + 1);
    } else {
      this.phaseStreak.set(key, Math.max(0, (this.phaseStreak.get(key) ?? 0) - 1));
      if (status === "aligned" || status === "unrelated") this.phaseArmed.set(key, true);
    }

    this.phaseStatus.set(key, {
      a,
      b,
      corr: roundTo(corr, 2),
      lag_ms: roundTo(lag, 2),
      status,
      inv_a: this.polarity.get(a) ?? false,
      inv_b: this.polarity.get(b) ?? false,
    });

    if (status === "inverted") {
      const armed = this.phaseArmed.get(key) ?? true;
      const ready =
        (this.phaseStreak.get(key) ?? 0) >= C.phase.sustain && now - (this.lastPhaseAct.get(key) ?? -1e9) > C.phase.actCooldownS;
      if (this.ctx.coaching()) {
        this.ctx.recommend(
          "phase",
          a,
          `${ra} & ${rb} are OUT OF POLARITY (corr ${signed(corr, 2)}) → invert phase on ${rb}.`,
          true,
          { pair: [a, b], status: "inverted", corr: roundTo(corr, 2) },
          adviceKey,
        );
      } else if (ready && armed) {
        const newpol = !(this.polarity.get(b) ?? false);
        this.ctx.mixer.setPolarity(b, newpol);
        this.polarity.set(b, newpol);
        this.lastPhaseAct.set(key, now);
        this.phaseArmed.set(key, false);
        this.phaseStreak.set(key, 0);
        this.ctx.emit("phase", `${ra} & ${rb} out of polarity → flipped phase on ${rb} (${newpol ? "inverted" : "normal"})`, b);
        this.ctx.noteLatency("phase");
      } else if (ready && !armed) {
        this.warn(`${key}|flip`, a, `${ra} & ${rb} still out of polarity after a flip → check mic placement / the card tap point.`, now);
      }
    } else if (status === "comb") {
      const msg = `${ra} & ${rb} arrive ~${fixed(Math.abs(lag), 2)} ms apart (comb filtering) → time-align them or move the mic.`;
      if (this.ctx.coaching()) {
        this.ctx.recommend("phase", a, msg, true, { pair: [a, b], status: "comb", lag_ms: roundTo(lag, 2) }, adviceKey);
      } else {
        this.warn(`${key}|comb`, a, msg, now);
      }
    } else {
      this.forget(adviceKey);
    }
  }
}

export class UnmaskJob {
  readonly ctx: JobContext;
  duckGain = 0;
  duckApplied = new Map<number, number>();
  voxLevelEma: number | null = null;
  lastUnmaskLog = -1e9;

  constructor(ctx: JobContext) {
    this.ctx = ctx;
  }

  targets(): number[] {
    const C = this.ctx.cfg;
    if (C.UNMASK_CHANNELS.length) return C.UNMASK_CHANNELS.filter((c) => C.CHANNELS.has(c));
    const exclude = new Set<number | null>([C.LEAD_VOCAL_CH, C.MEAS_MIC_CH, C.STAGE_MIC_CH]);
    return [...C.CHANNELS.keys()].filter((c) => !exclude.has(c));
  }

  release(): void {
    const C = this.ctx.cfg;
    for (const ch of [...this.duckApplied.keys()]) {
      this.ctx.mixer.setEqBand(ch, C.unmask.band, C.unmask.freq, 0.0, C.unmask.q, true);
    }
    this.duckApplied.clear();
    this.duckGain = 0;
  }

  handle(voxFeat: ChannelFeatures, now: number): void {
    const C = this.ctx.cfg;
    if (!this.ctx.state.enabled["unmask"]) return;
    const a = C.unmask.voxEma;
    this.voxLevelEma = this.voxLevelEma === null ? voxFeat.rmsDbfs : (1 - a) * this.voxLevelEma + a * voxFeat.rmsDbfs;
    const targets = this.targets();
    if (this.ctx.coaching()) {
      const roles = targets.map((c) => roleLabelOf(C, c)).join(", ");
      this.ctx.recommend(
        "unmask",
        C.LEAD_VOCAL_CH,
        `To unmask the vocal: dip ~${fixed(C.unmask.freq, 0)} Hz by ${fixed(Math.abs(C.unmask.depthDb), 0)} dB ` +
          `(Q ${fixed(C.unmask.q, 1)}) on ${roles} while the vocal is up.`,
        true,
        { freq: roundHalfEven(C.unmask.freq), depth_db: C.unmask.depthDb, channels: [...targets] },
      );
      return;
    }
    const present = this.voxLevelEma > C.unmask.voxGateDb;
    const target = present ? C.unmask.depthDb : 0;
    const coef = target < this.duckGain ? C.unmask.attack : C.unmask.release;
    this.duckGain = (1 - coef) * this.duckGain + coef * target;
    for (const ch of targets) {
      if (Math.abs(this.duckGain - (this.duckApplied.get(ch) ?? 0)) >= C.unmask.writeEpsDb) {
        const g = roundTo(this.duckGain, 1);
        this.ctx.mixer.setEqBand(ch, C.unmask.band, C.unmask.freq, g, C.unmask.q, true);
        this.duckApplied.set(ch, this.duckGain);
      }
    }
    if (present && this.duckGain < C.unmask.logDb && now - this.lastUnmaskLog > C.unmask.logIntervalS) {
      this.lastUnmaskLog = now;
      this.ctx.emit(
        "unmask",
        `vocal up → ducking ${fixed(C.unmask.freq, 0)} Hz ${signed(this.duckGain, 1)} dB on ${targets.length} instrument(s)`,
      );
    }
  }
}
