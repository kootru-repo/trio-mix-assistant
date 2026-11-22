import { C } from "../config.ts";
import type { ChannelFeatures } from "../dsp.ts";
import { fixed, roundHalfEven, roundTo, signed } from "../numfmt.ts";
import { AssistantBase, chan, need } from "./base.ts";

export class ProtectJobs extends AssistantBase {
  isNearWatch(freq: number, tol: number = 0.06): boolean {
    return [...this.watchFreqs, ...this.venueWatchFreqs].some((w) => w && Math.abs(freq - w) / w < tol);
  }

  allocBusBand(): number {
    for (let b = 1; b <= 6; b++) {
      if (!this.calBusBands.has(b) && !this.fbBusBands.includes(b)) return b;
    }
    if (this.fbBusBands.length) return this.fbBusBands[this.usedBusNotchBand % this.fbBusBands.length]!;
    return -1;
  }

  handleFeedback(ch: number, feat: ChannelFeatures): void {
    if (!this.enabled["feedback"]) return;
    if (feat.fbFreq) {
      const prev = need(this.fbLastFreq, ch);
      const stable = prev !== null && Math.abs(feat.fbFreq - prev) / feat.fbFreq < C.FB_STABLE_TOL;
      const rising = feat.rmsDbfs > need(this.fbLastLevel, ch) + C.FB_RISE_DB;
      const near = this.isNearWatch(feat.fbFreq);
      let needed = Math.max(1, C.FB_SUSTAIN_BLOCKS - (near ? 1 : 0));
      const harm = feat.harmonicity ?? 0;
      if (harm > 0) needed += roundHalfEven(harm * C.FB_HARMONIC_SUSTAIN);
      if (ch === C.MEAS_MIC_CH && this.roomConfidence < 0.7) {
        needed = Math.max(needed, roundHalfEven(needed / Math.max(0.3, this.roomConfidence)));
      }

      if (stable && rising) this.fbStreak.set(ch, need(this.fbStreak, ch) + 1);
      else this.fbStreak.set(ch, Math.max(0, need(this.fbStreak, ch) - 1));

      if (need(this.fbStreak, ch) >= needed) {
        const flag = near ? " [watch-list]" : "";
        const hz = fixed(feat.fbFreq, 0);
        if (ch === C.MEAS_MIC_CH) {
          const band = this.allocBusBand();
          if (band < 0) {
            this.emit("system", "no free main-bus band for a feedback notch");
          } else if (this.coachMode) {
            this.recommend(
              "feedback",
              ch,
              `Feedback ${hz} Hz in the room → cut the MAIN BUS at ${hz} Hz by ${fixed(C.FB_NOTCH_GAIN_DB, 0)} dB ` +
                `(Q ${fixed(C.FB_NOTCH_Q, 0)}); e.g. main PEQ band ${band}.${flag}`,
              false,
              {
                freq: roundTo(feat.fbFreq, 1),
                gain_db: C.FB_NOTCH_GAIN_DB,
                q: C.FB_NOTCH_Q,
                target: "main-bus",
                band,
              },
            );
          } else {
            this.con.setBusEq(band, feat.fbFreq, C.FB_NOTCH_GAIN_DB, C.FB_NOTCH_Q);
            if (!this.fbBusBands.includes(band)) this.fbBusBands.push(band);
            this.usedBusNotchBand += 1;
            this.emit("feedback", `${hz} Hz on ${chan(ch)} → main-bus band ${band}${flag}`, ch);
            this.noteLatency("feedback");
          }
        } else {
          let band = (need(this.usedNotchBand, ch) % 4) + 1;
          if (this.enabled["unmask"] && band === C.UNMASK_BAND) band = (band % 4) + 1;
          if (this.coachMode) {
            this.recommend(
              "feedback",
              ch,
              `Feedback ${hz} Hz on ${chan(ch)} → notch input EQ band ${band} at ${hz} Hz, ` +
                `${fixed(C.FB_NOTCH_GAIN_DB, 0)} dB (Q ${fixed(C.FB_NOTCH_Q, 0)}).${flag}`,
              false,
              {
                freq: roundTo(feat.fbFreq, 1),
                gain_db: C.FB_NOTCH_GAIN_DB,
                q: C.FB_NOTCH_Q,
                target: `ch${ch}`,
                band,
              },
            );
          } else {
            this.con.setEqNotch(ch, band, feat.fbFreq);
            this.usedNotchBand.set(ch, band);
            this.emit("feedback", `${hz} Hz on ${chan(ch)} → notch band ${band}${flag}`, ch);
            this.noteLatency("feedback");
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

  handleClip(ch: number, feat: ChannelFeatures, now: number): void {
    if (!this.enabled["clip"]) return;
    if (feat.peakDbfs > C.CLIP_PEAK_DBFS) {
      if (!this.coachMode && now - need(this.lastClipT, ch) < C.CLIP_TRIM_COOLDOWN_S) return;
      if (this.coachMode) {
        this.recommend(
          "clip",
          ch,
          `${chan(ch)} near clip (${signed(feat.peakDbfs, 1)} dBFS) → trim its preamp/gain ${signed(C.CLIP_TRIM_DB, 0)} dB.`,
          false,
          { peak: roundTo(feat.peakDbfs, 1), trim_db: C.CLIP_TRIM_DB },
        );
        return;
      }
      this.gainDb.set(ch, this.con.nudgeGainDb(ch, need(this.gainDb, ch), C.CLIP_TRIM_DB));
      this.lastClipT.set(ch, now);
      this.emit(
        "clip",
        `${chan(ch)} near clip → preamp ${signed(C.CLIP_TRIM_DB, 0)} dB → ${fixed(need(this.gainDb, ch), 0)} dB`,
        ch,
      );
      this.noteLatency("clip");
    } else if (
      feat.peakDbfs < C.CLIP_PEAK_DBFS - 6.0 &&
      need(this.gainDb, ch) < need(this.nominalGain, ch) &&
      now - need(this.lastClipT, ch) > C.CLIP_RECOVER_S &&
      now - need(this.lastRecoverT, ch) > C.CLIP_RECOVER_S
    ) {
      if (this.coachMode) {
        this.recommend(
          "clip",
          ch,
          `${chan(ch)} is clean but its preamp is still trimmed (${fixed(need(this.gainDb, ch), 0)} dB) → ` +
            `you can restore it toward ${fixed(need(this.nominalGain, ch), 0)} dB.`,
          false,
          { gain_db: roundTo(need(this.gainDb, ch), 1), nominal_db: need(this.nominalGain, ch) },
        );
        return;
      }
      const target = Math.min(need(this.nominalGain, ch), need(this.gainDb, ch) + C.CLIP_RECOVER_DB);
      this.gainDb.set(ch, this.con.nudgeGainDb(ch, need(this.gainDb, ch), target - need(this.gainDb, ch)));
      this.lastRecoverT.set(ch, now);
      this.emit("clip", `${chan(ch)} clean → restoring preamp → ${fixed(need(this.gainDb, ch), 0)} dB`, ch);
    }
  }

  resetNotches(): void {
    let cleared = 0;
    for (const ch of C.CHANNELS.keys()) {
      if (need(this.usedNotchBand, ch)) {
        this.con.clearChannelEq(ch);
        this.usedNotchBand.set(ch, 0);
        this.fbStreak.set(ch, 0);
        cleared++;
      }
    }
    for (const band of this.fbBusBands) {
      this.con.setBusEq(band, 1000.0, 0.0, 2.0);
      cleared++;
    }
    this.fbBusBands = [];
    this.usedBusNotchBand = 0;
    this.emit("system", `cleared ${cleared} parked notch(es)`);
  }
}
