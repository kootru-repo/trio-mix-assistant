import type { ChannelFeatures } from "../dsp.ts";
import { fixed, roundTo, signed } from "../numfmt.ts";
import { NEG_INF } from "../util.ts";
import { chanOf, need, perChannelOf } from "./context.ts";
import type { JobContext } from "./context.ts";

const gainText = (db: number): string => fixed(db, Number.isInteger(Math.round(db * 10) / 10) ? 0 : 1);

export class ClipJob {
  readonly ctx: JobContext;
  lastClipT: Map<number, number>;
  lastRecoverT: Map<number, number>;

  constructor(ctx: JobContext) {
    this.ctx = ctx;
    this.lastClipT = perChannelOf(ctx.cfg, NEG_INF);
    this.lastRecoverT = perChannelOf(ctx.cfg, NEG_INF);
  }

  handle(ch: number, feat: ChannelFeatures, now: number): void {
    const { cfg: C, state, mixer } = this.ctx;
    if (!state.enabled["clip"]) return;
    const coaching = this.ctx.coaching();
    if (feat.peakDbfs > C.clip.peakDbfs) {
      if (!coaching && now - need(this.lastClipT, ch) < C.clip.trimCooldownS) return;
      if (coaching) {
        this.ctx.recommend("clip", ch, `${chanOf(C, ch)} near clip → trim its preamp/gain ${signed(C.clip.trimDb, 0)} dB.`, false, {
          peak: roundTo(feat.peakDbfs, 1),
          trim_db: C.clip.trimDb,
        });
        return;
      }
      state.gainDb.set(ch, mixer.nudgeGainDb(ch, need(state.gainDb, ch), C.clip.trimDb));
      this.lastClipT.set(ch, now);
      this.ctx.emit(
        "clip",
        `${chanOf(C, ch)} near clip → preamp ${signed(C.clip.trimDb, 0)} dB → ${gainText(need(state.gainDb, ch))} dB`,
        ch,
      );
      this.ctx.noteLatency("clip");
    } else if (
      feat.peakDbfs < C.clip.peakDbfs - C.clip.recoverMarginDb &&
      need(state.gainDb, ch) < need(state.nominalGain, ch) &&
      now - need(this.lastClipT, ch) > C.clip.recoverS &&
      now - need(this.lastRecoverT, ch) > C.clip.recoverS
    ) {
      if (coaching) {
        this.ctx.recommend(
          "clip",
          ch,
          `${chanOf(C, ch)} is clean but its preamp is still trimmed (${gainText(need(state.gainDb, ch))} dB) → ` +
            `you can restore it toward ${gainText(need(state.nominalGain, ch))} dB.`,
          false,
          { gain_db: roundTo(need(state.gainDb, ch), 1), nominal_db: need(state.nominalGain, ch) },
        );
        return;
      }
      const target = Math.min(need(state.nominalGain, ch), need(state.gainDb, ch) + C.clip.recoverDb);
      state.gainDb.set(ch, mixer.nudgeGainDb(ch, need(state.gainDb, ch), target - need(state.gainDb, ch)));
      this.lastRecoverT.set(ch, now);
      this.ctx.emit("clip", `${chanOf(C, ch)} clean → restoring preamp → ${gainText(need(state.gainDb, ch))} dB`, ch);
    }
  }
}
