import { C } from "../config.ts";
import type { ChannelFeatures } from "../dsp.ts";
import { fixed, roundTo, signed } from "../numfmt.ts";
import { chan, clamp, need } from "./base.ts";
import { ProtectJobs } from "./protect.ts";

export class LevelJobs extends ProtectJobs {
  rideToward(ch: number, feat: ChannelFeatures, targetOut: number, now: number, minInterval: number, kind: string): void {
    const a = 1 / 24;
    const e = need(this.inEma, ch);
    const ema = e === null ? feat.rmsDbfs : (1 - a) * e + a * feat.rmsDbfs;
    this.inEma.set(ch, ema);
    if (now < (this.manualHoldUntil.get(ch) ?? -1e9)) return;
    if (now - need(this.lastRideT, ch) < minInterval) return;
    const outputEst = ema + need(this.faderDb, ch);
    const err = targetOut - outputEst;
    if (Math.abs(err) <= C.LEAD_TOLERANCE) return;
    const step = clamp(err, -C.MAX_STEP_DB, C.MAX_STEP_DB);
    const start = need(this.faderDb, ch);
    const newf = clamp(start + step, C.FADER_MIN_DB, C.FADER_MAX_DB);
    this.lastRideT.set(ch, now);
    if (Math.abs(newf - start) < 0.05) return;
    if (this.coachMode) {
      const direction = newf > start ? "up" : "down";
      this.recommend(
        kind,
        ch,
        `${chan(ch)}: output ${signed(outputEst, 1)} dB vs target ${signed(targetOut, 1)} → ` +
          `move the fader ${direction} ${fixed(Math.abs(newf - start), 1)} dB (to ${signed(newf, 1)}).`,
        false,
        {
          output_db: roundTo(outputEst, 1),
          target_db: roundTo(targetOut, 1),
          delta_db: roundTo(newf - start, 2),
          to_db: roundTo(newf, 1),
        },
      );
      return;
    }
    this.faderDb.set(ch, this.con.rampFaderDb(ch, start, newf));
    this.lastMoveT.set(ch, now);
    this.noteLatency(kind);
    this.emit(
      kind,
      `${chan(ch)}: out ${signed(outputEst, 1)} dB vs target ${signed(targetOut, 1)} → ` +
        `fader ${signed(start, 1)}→${signed(need(this.faderDb, ch), 1)} dB`,
      ch,
    );
  }

  handleVocalRide(feat: ChannelFeatures, now: number): void {
    if (!this.enabled["vocal_ride"]) return;
    this.rideToward(C.LEAD_VOCAL_CH, feat, this.leadTarget, now, 0.25, "vocal");
  }

  handleBalance(ch: number, feat: ChannelFeatures, now: number): void {
    const target = this.balanceTargets.get(ch);
    if (!this.enabled["balance"] || target === undefined) return;
    this.rideToward(ch, feat, target, now, 1.0, "balance");
  }

  captureBalance(levels: Map<number, number>): void {
    this.balanceTargets = new Map();
    for (const ch of C.BALANCE_CHANNELS) {
      let lvl: number | null | undefined = this.inEma.get(ch);
      if (lvl === null || lvl === undefined) lvl = levels.get(ch);
      if (lvl !== null && lvl !== undefined) this.balanceTargets.set(ch, lvl + need(this.faderDb, ch));
    }
    const pretty = [...this.balanceTargets].map(([c, v]) => `${chan(c)} ${signed(v, 1)}`).join(", ");
    this.emit("balance", `captured balance targets: ${pretty}`);
  }

  handleStageVolume(feat: ChannelFeatures, now: number): void {
    const lvl = feat.rmsDbfs;
    const prior = this.stageBaseline === null ? lvl : this.stageBaseline;
    const baseline = 0.999 * prior + 0.001 * lvl;
    this.stageBaseline = baseline;
    if (lvl > baseline + C.STAGE_RISE_DB && now - this.lastStageWarn > 30.0) {
      this.lastStageWarn = now;
      this.emit(
        "system",
        `stage volume up ~${fixed(lvl - baseline, 0)} dB over baseline — consider easing back`,
        C.STAGE_MIC_CH,
      );
    }
  }
}
