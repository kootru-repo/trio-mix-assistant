import type { Frame } from "./capture.ts";
import { C } from "./config.ts";
import { RollingRingDetector, analyseBlock, phaseRelation } from "./dsp.ts";
import type { ChannelFeatures, PhaseRelation } from "./dsp.ts";

export interface AnalysisConfig {
  channels: readonly number[];
  measCh: number;
  phasePairs: readonly (readonly number[])[];
  sampleRate: number;
}

export interface PhaseReading {
  a: number;
  b: number;
  relation: PhaseRelation;
}

export interface AnalysedBlock {
  feats: Map<number, ChannelFeatures>;
  phases: PhaseReading[];
}

export const currentAnalysisConfig = (): AnalysisConfig => ({
  channels: [...C.CHANNELS.keys()],
  measCh: C.MEAS_MIC_CH,
  phasePairs: C.PHASE_PAIRS.map((p) => [...p]),
  sampleRate: C.SAMPLE_RATE,
});

export class BlockAnalyser {
  private readonly ring = new RollingRingDetector();

  analyse(
    frame: Frame,
    config: AnalysisConfig,
    onError: (exc: unknown) => void = () => undefined,
    wantPhases: boolean = true,
  ): AnalysedBlock {
    const feats = new Map<number, ChannelFeatures>();
    for (const [ch, samples] of frame) {
      if (!config.channels.includes(ch)) continue;
      try {
        const isMeas = ch === config.measCh;
        const feat = analyseBlock(samples, config.sampleRate, { ring: !isMeas });
        if (isMeas) {
          const [fbFreq, harmonicity] = this.ring.update(samples);
          feat.fbFreq = fbFreq;
          feat.harmonicity = harmonicity;
        }
        feats.set(ch, feat);
      } catch (exc) {
        onError(exc);
      }
    }
    const phases: PhaseReading[] = [];
    for (const [a, b] of wantPhases ? config.phasePairs : []) {
      if (a === undefined || b === undefined) continue;
      const sa = frame.get(a);
      const sb = frame.get(b);
      if (sa === undefined || sb === undefined) continue;
      try {
        phases.push({ a, b, relation: phaseRelation(sa, sb, config.sampleRate) });
      } catch (exc) {
        onError(exc);
      }
    }
    return { feats, phases };
  }
}
