import type { ChannelFeatures } from "../dsp.ts";
import { fixed, roundTo, signed } from "../numfmt.ts";
import { NEG_INF, clamp } from "../util.ts";
import { chanOf, need, perChannelOf } from "./context.ts";
import type { JobContext } from "./context.ts";

export class RideJob {
  readonly ctx: JobContext;
  leadTarget: number;
  inEma: Map<number, number | null>;
  lastRideT: Map<number, number>;
  balanceTargets = new Map<number, number>();

  constructor(ctx: JobContext) {
    this.ctx = ctx;
    this.leadTarget = ctx.cfg.ride.leadTargetDb;
    this.inEma = perChannelOf<number | null>(ctx.cfg, null);
    this.lastRideT = perChannelOf(ctx.cfg, NEG_INF);
  }

  rideToward(ch: number, feat: ChannelFeatures, targetOut: number, now: number, minInterval: number, kind: string): void {
    const { cfg, state, mixer } = this.ctx;
    if (this.ctx.locked(ch)) return;
    const a = cfg.ride.ema;
    const e = need(this.inEma, ch);
    const ema = e === null ? feat.rmsDbfs : (1 - a) * e + a * feat.rmsDbfs;
    this.inEma.set(ch, ema);
    if (now < (state.manualHoldUntil.get(ch) ?? -1e9)) return;
    if (now - need(this.lastRideT, ch) < minInterval) return;
    const start = need(state.faderDb, ch);
    if (!(start >= cfg.limits.faderMinDb && start <= cfg.limits.faderMaxDb)) {
      this.lastRideT.set(ch, now);
      return;
    }
    const outputEst = ema + start;
    const err = targetOut - outputEst;
    if (Math.abs(err) <= cfg.ride.toleranceDb) return;
    const step = clamp(err, -cfg.ride.maxStepDb, cfg.ride.maxStepDb);
    const newf = clamp(start + step, cfg.limits.faderMinDb, cfg.limits.faderMaxDb);
    this.lastRideT.set(ch, now);
    if (Math.abs(newf - start) < cfg.ride.minMoveDb) return;
    if (this.ctx.coaching()) {
      const direction = newf > start ? "up" : "down";
      this.ctx.recommend(
        kind,
        ch,
        `${chanOf(cfg, ch)}: output ${signed(outputEst, 1)} dB vs target ${signed(targetOut, 1)} → ` +
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
    state.faderDb.set(ch, mixer.rampFaderDb(ch, start, newf));
    state.lastMoveT.set(ch, now);
    this.ctx.noteLatency(kind);
    this.ctx.emit(
      kind,
      `${chanOf(cfg, ch)}: out ${signed(outputEst, 1)} dB vs target ${signed(targetOut, 1)} → ` +
        `fader ${signed(start, 1)}→${signed(need(state.faderDb, ch), 1)} dB`,
      ch,
    );
  }

  handleVocal(feat: ChannelFeatures, now: number): void {
    if (!this.ctx.state.enabled["vocal_ride"]) return;
    this.rideToward(this.ctx.cfg.LEAD_VOCAL_CH, feat, this.leadTarget, now, this.ctx.cfg.ride.vocalIntervalS, "vocal");
  }

  handleBalance(ch: number, feat: ChannelFeatures, now: number): void {
    const target = this.balanceTargets.get(ch);
    if (!this.ctx.state.enabled["balance"] || target === undefined) return;
    this.rideToward(ch, feat, target, now, this.ctx.cfg.ride.balanceIntervalS, "balance");
  }

  captureBalance(levels: Map<number, number>): void {
    const { cfg, state } = this.ctx;
    this.balanceTargets = new Map();
    for (const ch of cfg.BALANCE_CHANNELS) {
      let lvl: number | null | undefined = this.inEma.get(ch);
      if (lvl === null || lvl === undefined) lvl = levels.get(ch);
      if (lvl !== null && lvl !== undefined) this.balanceTargets.set(ch, lvl + need(state.faderDb, ch));
    }
    const pretty = [...this.balanceTargets].map(([c, v]) => `${chanOf(cfg, c)} ${signed(v, 1)}`).join(", ");
    this.ctx.emit("balance", `captured balance targets: ${pretty}`);
  }
}
