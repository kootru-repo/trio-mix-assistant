import { C } from "../config.ts";
import type { ChannelFeatures, PhaseRelation } from "../dsp.ts";
import { fixed, roundHalfEven, roundTo, signed } from "../numfmt.ts";
import { coachKey, pairKey } from "./base.ts";
import { LevelJobs } from "./levels.ts";

const label = (ch: number): string => C.CHANNELS.get(ch) ?? `ch${ch}`;

export class ClarityJobs extends LevelJobs {
  private phaseWarn(key: string, ch: number, msg: string, now: number): void {
    if (now - (this.lastPhaseWarn.get(key) ?? -1e9) > C.PHASE_WARN_INTERVAL) {
      this.lastPhaseWarn.set(key, now);
      this.emit("phase", msg, ch);
    }
  }

  private clearPhase(a: number): void {
    const key = coachKey("phase", a);
    this.coachRecs.delete(key);
    this.coachLastText.delete(key);
  }

  handlePhase(a: number, b: number, rel: PhaseRelation, now: number): void {
    if (!this.enabled["phase"]) return;
    const key = pairKey(a, b);
    const al = C.PHASE_EMA;
    const ce = this.phaseEma.get(key);
    this.phaseEma.set(key, ce === undefined ? rel.zeroCorr : (1 - al) * ce + al * rel.zeroCorr);
    if (Math.abs(rel.bestCorr) >= C.PHASE_CORR_MIN) {
      const le = this.phaseLagEma.get(key);
      this.phaseLagEma.set(key, le === undefined ? rel.lagMs : (1 - al) * le + al * rel.lagMs);
    }
    const corr = this.phaseEma.get(key)!;
    const lag = this.phaseLagEma.get(key) ?? 0;
    const ra = label(a);
    const rb = label(b);

    const inverted = corr < C.PHASE_INVERT_CORR;
    const related = Math.abs(corr) >= C.PHASE_CORR_MIN;
    const comb = related && !inverted && Math.abs(lag) > C.PHASE_COMB_LAG_MS;
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
        (this.phaseStreak.get(key) ?? 0) >= C.PHASE_SUSTAIN &&
        now - (this.lastPhaseAct.get(key) ?? -1e9) > C.PHASE_ACT_COOLDOWN;
      if (this.coachMode) {
        this.recommend(
          "phase",
          a,
          `${ra} & ${rb} are OUT OF POLARITY (corr ${signed(corr, 2)}) → invert phase on ${rb}.`,
          true,
          { pair: [a, b], status: "inverted", corr: roundTo(corr, 2) },
        );
      } else if (ready && armed) {
        const newpol = !(this.polarity.get(b) ?? false);
        this.con.setPolarity(b, newpol);
        this.polarity.set(b, newpol);
        this.lastPhaseAct.set(key, now);
        this.phaseArmed.set(key, false);
        this.phaseStreak.set(key, 0);
        this.emit(
          "phase",
          `${ra} & ${rb} out of polarity → flipped phase on ${rb} (${newpol ? "inverted" : "normal"})`,
          b,
        );
        this.noteLatency("phase");
      } else if (ready && !armed) {
        this.phaseWarn(
          key,
          a,
          `${ra} & ${rb} still out of polarity after a flip → check mic placement / the card tap point.`,
          now,
        );
      }
    } else if (status === "comb") {
      const msg = `${ra} & ${rb} arrive ~${fixed(Math.abs(lag), 2)} ms apart (comb filtering) → time-align them or move the mic.`;
      if (this.coachMode) {
        this.recommend("phase", a, msg, true, { pair: [a, b], status: "comb", lag_ms: roundTo(lag, 2) });
      } else {
        this.phaseWarn(key, a, msg, now);
      }
    } else {
      this.clearPhase(a);
    }
  }

  handleUnmask(voxFeat: ChannelFeatures, now: number): void {
    if (!this.enabled["unmask"]) return;
    const a = 1 / 6;
    this.voxLevelEma = this.voxLevelEma === null ? voxFeat.rmsDbfs : (1 - a) * this.voxLevelEma + a * voxFeat.rmsDbfs;
    const targets = this.unmaskTargets();
    if (this.coachMode) {
      const roles = targets.map((c) => label(c)).join(", ");
      this.recommend(
        "unmask",
        C.LEAD_VOCAL_CH,
        `To unmask the vocal: dip ~${fixed(C.UNMASK_FREQ, 0)} Hz by ${fixed(Math.abs(C.UNMASK_DEPTH_DB), 0)} dB ` +
          `(Q ${fixed(C.UNMASK_Q, 1)}) on ${roles} while the vocal is up.`,
        true,
        { freq: roundHalfEven(C.UNMASK_FREQ), depth_db: C.UNMASK_DEPTH_DB, channels: [...targets] },
      );
      return;
    }
    const present = this.voxLevelEma > C.UNMASK_VOX_GATE_DB;
    const target = present ? C.UNMASK_DEPTH_DB : 0;
    const coef = target < this.duckGain ? C.UNMASK_ATTACK : C.UNMASK_RELEASE;
    this.duckGain = (1 - coef) * this.duckGain + coef * target;
    for (const ch of targets) {
      if (Math.abs(this.duckGain - (this.duckApplied.get(ch) ?? 0)) >= C.UNMASK_WRITE_EPS) {
        const g = roundTo(this.duckGain, 1);
        this.con.setEqBand(ch, C.UNMASK_BAND, C.UNMASK_FREQ, g, C.UNMASK_Q, true);
        this.duckApplied.set(ch, this.duckGain);
      }
    }
    if (present && this.duckGain < -1.0 && now - this.lastUnmaskLog > 10.0) {
      this.lastUnmaskLog = now;
      this.emit(
        "unmask",
        `vocal up → ducking ${fixed(C.UNMASK_FREQ, 0)} Hz ${signed(this.duckGain, 1)} dB on ${targets.length} instrument(s)`,
      );
    }
  }
}
