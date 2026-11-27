import type { Config } from "../config.ts";
import type { ChannelFeatures } from "../dsp.ts";
import { fixed, percent, roundTo } from "../numfmt.ts";
import type { JobContext } from "./context.ts";

export function roomConfidence(cfg: Config, levelDb: number, contrastDb: number): number {
  const quiet = cfg.room.quietDb,
    loudDb = cfg.room.loudDb,
    floor = cfg.room.loudMin;
  const loud = levelDb <= quiet ? 1 : levelDb >= loudDb ? floor : 1 - ((1 - floor) * (levelDb - quiet)) / (loudDb - quiet);
  const flat = contrastDb >= cfg.feedback.ringDb ? 1 : Math.max(cfg.room.flatMin, contrastDb / cfg.feedback.ringDb);
  return roundTo(loud * flat, 3);
}

export class RoomModel {
  readonly ctx: JobContext;
  roomLevelDb = -90;
  roomContrastDb = 0;
  lastLowconfWarn = -1e9;

  constructor(ctx: JobContext) {
    this.ctx = ctx;
  }

  update(feat: ChannelFeatures, now: number): void {
    const cfg = this.ctx.cfg;
    const a = cfg.room.ema;
    this.roomLevelDb = (1 - a) * this.roomLevelDb + a * feat.rmsDbfs;
    this.roomContrastDb = (1 - a) * this.roomContrastDb + a * feat.contrastDb;
    const conf = roomConfidence(cfg, this.roomLevelDb, this.roomContrastDb);
    this.ctx.state.roomConfidence = conf;
    if (conf < cfg.room.lowConf && now - this.lastLowconfWarn > cfg.room.lowConfWarnS) {
      this.lastLowconfWarn = now;
      this.ctx.emit(
        "system",
        `room-mic SNR low (conf ${percent(conf, 0)}) — feedback detection is being more conservative`,
        cfg.MEAS_MIC_CH,
      );
    }
  }
}

export class StageJob {
  readonly ctx: JobContext;
  stageBaseline: number | null = null;
  lastStageWarn = -1e9;

  constructor(ctx: JobContext) {
    this.ctx = ctx;
  }

  handle(feat: ChannelFeatures, now: number): void {
    const cfg = this.ctx.cfg;
    const lvl = feat.rmsDbfs;
    const prior = this.stageBaseline === null ? lvl : this.stageBaseline;
    const baseline = (1 - cfg.stage.baselineEma) * prior + cfg.stage.baselineEma * lvl;
    this.stageBaseline = baseline;
    if (lvl > baseline + cfg.stage.riseDb && now - this.lastStageWarn > cfg.stage.warnIntervalS) {
      this.lastStageWarn = now;
      this.ctx.emit("system", `stage volume up ~${fixed(lvl - baseline, 0)} dB over baseline — consider easing back`, cfg.STAGE_MIC_CH);
    }
  }
}
