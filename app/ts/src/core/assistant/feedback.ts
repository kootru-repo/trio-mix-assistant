import type { CalibrationResult } from "../calibration.ts";
import { watchFreqs } from "../calibration.ts";
import type { ChannelFeatures } from "../dsp.ts";
import { fixed, roundHalfEven, roundTo } from "../numfmt.ts";
import { chanOf, need, perChannelOf } from "./context.ts";
import type { JobContext } from "./context.ts";

export class FeedbackJob {
  readonly ctx: JobContext;
  fbStreak: Map<number, number>;
  usedNotchBand: Map<number, number>;
  usedBusNotchBand = 0;
  fbBusBands: number[] = [];
  calBusBands = new Set<number>();
  fbLastFreq: Map<number, number | null>;
  fbLastLevel: Map<number, number>;
  coachNotchBand: Map<number, number>;
  coachBusBands: number[] = [];
  coachBusUsed = 0;
  watchFreqs: number[] = [];
  venueWatchFreqs: number[] = [];

  constructor(ctx: JobContext) {
    this.ctx = ctx;
    this.fbStreak = perChannelOf(ctx.cfg, 0);
    this.usedNotchBand = perChannelOf(ctx.cfg, 0);
    this.fbLastFreq = perChannelOf<number | null>(ctx.cfg, null);
    this.fbLastLevel = perChannelOf(ctx.cfg, -90);
    this.coachNotchBand = perChannelOf(ctx.cfg, 0);
  }

  setCalibration(calib: CalibrationResult | null): void {
    this.watchFreqs = calib ? watchFreqs(calib) : [];
  }

  isNearWatch(freq: number, tol: number = this.ctx.cfg.feedback.watchTol): boolean {
    return [...this.watchFreqs, ...this.venueWatchFreqs].some((w) => w && Math.abs(freq - w) / w < tol);
  }

  allocBusBand(taken: readonly number[] = this.fbBusBands, used: number = this.usedBusNotchBand): number {
    for (let b = 1; b <= this.ctx.cfg.BUS_EQ_BANDS; b++) {
      if (!this.calBusBands.has(b) && !taken.includes(b)) return b;
    }
    const reusable = taken.filter((b) => !this.calBusBands.has(b));
    if (reusable.length) return reusable[used % reusable.length]!;
    return -1;
  }

  handle(ch: number, feat: ChannelFeatures): void {
    const { cfg: C, state, mixer } = this.ctx;
    if (!state.enabled["feedback"]) {
      need(this.fbStreak, ch);
      this.fbStreak.set(ch, 0);
      this.fbLastFreq.set(ch, null);
      this.fbLastLevel.set(ch, feat.rmsDbfs);
      return;
    }
    if (feat.fbFreq) {
      const prev = need(this.fbLastFreq, ch);
      const stable = prev !== null && Math.abs(feat.fbFreq - prev) / feat.fbFreq < C.feedback.stableTol;
      const rising = feat.rmsDbfs > need(this.fbLastLevel, ch) + C.feedback.riseDb;
      const near = this.isNearWatch(feat.fbFreq);
      let needed = Math.max(1, C.feedback.sustainBlocks - (near ? 1 : 0));
      const harm = feat.harmonicity ?? 0;
      if (harm > 0) needed += roundHalfEven(harm * C.feedback.harmonicSustain);
      if (ch === C.MEAS_MIC_CH && state.roomConfidence < C.feedback.lowConf) {
        needed = Math.max(needed, roundHalfEven(needed / Math.max(C.feedback.confFloor, state.roomConfidence)));
      }

      const grew = stable && rising;
      if (grew) this.fbStreak.set(ch, need(this.fbStreak, ch) + 1);
      else this.fbStreak.set(ch, Math.max(0, need(this.fbStreak, ch) - 1));

      if (grew && need(this.fbStreak, ch) >= needed) {
        const flag = near ? " [watch-list]" : "";
        const hz = fixed(feat.fbFreq, 0);
        if (ch === C.MEAS_MIC_CH) {
          const coaching = this.ctx.coaching();
          const band = coaching
            ? this.allocBusBand([...new Set([...this.fbBusBands, ...this.coachBusBands])], this.coachBusUsed)
            : this.allocBusBand();
          if (band < 0) {
            this.ctx.emit("system", "no free main-bus band for a feedback notch");
          } else if (coaching) {
            if (!this.coachBusBands.includes(band)) this.coachBusBands.push(band);
            this.coachBusUsed += 1;
            this.ctx.recommend(
              "feedback",
              ch,
              `Feedback ${hz} Hz in the room → cut the MAIN BUS at ${hz} Hz by ${fixed(C.feedback.notchGainDb, 0)} dB ` +
                `(Q ${fixed(C.feedback.notchQ, 0)}); e.g. main PEQ band ${band}.${flag}`,
              false,
              {
                freq: roundTo(feat.fbFreq, 1),
                gain_db: C.feedback.notchGainDb,
                q: C.feedback.notchQ,
                target: "main-bus",
                band,
              },
            );
          } else {
            mixer.setBusEq(band, feat.fbFreq, C.feedback.notchGainDb, C.feedback.notchQ);
            if (!this.fbBusBands.includes(band)) this.fbBusBands.push(band);
            this.usedBusNotchBand += 1;
            this.ctx.emit("feedback", `${hz} Hz on ${chanOf(C, ch)} → main-bus band ${band}${flag}`, ch);
            this.ctx.noteLatency("feedback");
          }
        } else {
          const coaching = this.ctx.coaching();
          const counter = coaching ? this.coachNotchBand : this.usedNotchBand;
          let band = ((coaching ? need(counter, ch) || need(this.usedNotchBand, ch) : need(counter, ch)) % C.CHANNEL_EQ_BANDS) + 1;
          if (state.enabled["unmask"] && band === C.unmask.band && C.CHANNEL_EQ_BANDS > 1) band = (band % C.CHANNEL_EQ_BANDS) + 1;
          if (coaching) {
            this.coachNotchBand.set(ch, band);
            this.ctx.recommend(
              "feedback",
              ch,
              `Feedback ${hz} Hz on ${chanOf(C, ch)} → notch input EQ band ${band} at ${hz} Hz, ` +
                `${fixed(C.feedback.notchGainDb, 0)} dB (Q ${fixed(C.feedback.notchQ, 0)}).${flag}`,
              false,
              {
                freq: roundTo(feat.fbFreq, 1),
                gain_db: C.feedback.notchGainDb,
                q: C.feedback.notchQ,
                target: `ch${ch}`,
                band,
              },
            );
          } else {
            mixer.setEqNotch(ch, band, feat.fbFreq);
            this.usedNotchBand.set(ch, band);
            this.ctx.emit("feedback", `${hz} Hz on ${chanOf(C, ch)} → notch band ${band}${flag}`, ch);
            this.ctx.noteLatency("feedback");
          }
        }
        this.fbStreak.set(ch, 0);
      }
      this.fbLastFreq.set(ch, feat.fbFreq);
      this.fbLastLevel.set(ch, feat.rmsDbfs);
    } else {
      this.fbStreak.set(ch, Math.max(0, need(this.fbStreak, ch) - 1));
      this.fbLastFreq.set(ch, null);
      this.fbLastLevel.set(ch, feat.rmsDbfs);
    }
  }

  resetNotches(): void {
    const C = this.ctx.cfg;
    let cleared = 0;
    for (const ch of C.CHANNELS.keys()) {
      if (need(this.usedNotchBand, ch)) {
        this.ctx.mixer.clearChannelEq(ch);
        this.usedNotchBand.set(ch, 0);
        cleared++;
      }
      this.fbStreak.set(ch, 0);
      this.coachNotchBand.set(ch, 0);
    }
    for (const band of this.fbBusBands) {
      this.ctx.mixer.setBusEq(band, C.EQ_FLAT_FREQ, 0.0, C.EQ_FLAT_Q);
      cleared++;
    }
    this.fbBusBands = [];
    this.usedBusNotchBand = 0;
    this.coachBusBands = [];
    this.coachBusUsed = 0;
    this.ctx.emit("system", `cleared ${cleared} parked notch(es)`);
  }
}
