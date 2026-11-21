import { C } from "../config.ts";
import type { ChannelFeatures } from "../dsp.ts";
import { ClarityJobs } from "./clarity.ts";

export class MixAssistant extends ClarityJobs {
  onFeatures(ch: number, feat: ChannelFeatures, now: number): void {
    if (ch === C.MEAS_MIC_CH) {
      this.updateRoom(feat, now);
      this.handleFeedback(ch, feat);
      return;
    }
    if (C.STAGE_MIC_CH !== null && ch === C.STAGE_MIC_CH) {
      this.handleStageVolume(feat, now);
      return;
    }
    this.handleFeedback(ch, feat);
    this.handleClip(ch, feat, now);
    if (ch === C.LEAD_VOCAL_CH) {
      this.handleVocalRide(feat, now);
      this.handleUnmask(feat, now);
    }
    if (C.BALANCE_CHANNELS.includes(ch)) this.handleBalance(ch, feat, now);
  }
}
