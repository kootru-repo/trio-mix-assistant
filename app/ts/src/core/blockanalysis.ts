import type { Frame } from "./capture.ts";
import { C } from "./config.ts";
import type { Config } from "./config.ts";
import { RollingRingDetector, analyseBlock, phaseRelation } from "./dsp.ts";
import type { ChannelFeatures, PhaseRelation } from "./dsp.ts";

export interface AnalysisConfig {
  channels: readonly number[];
  measCh: number;
  phasePairs: readonly (readonly number[])[];
  sampleRate: number;
  ringDb?: number;
  detectFft?: number;
  maxLagMs?: number;
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

export const analysisConfig = (cfg: Config = C): AnalysisConfig => ({
  channels: [...cfg.CHANNELS.keys()],
  measCh: cfg.MEAS_MIC_CH,
  phasePairs: cfg.PHASE_PAIRS.map((p) => [...p]),
  sampleRate: cfg.SAMPLE_RATE,
  ringDb: cfg.feedback.ringDb,
  detectFft: cfg.feedback.detectFft,
  maxLagMs: cfg.phase.maxLagMs,
});

export const currentAnalysisConfig = (): AnalysisConfig => analysisConfig();

export class BlockAnalyser {
  private readonly cfg: Config;
  private ring: RollingRingDetector | null = null;

  constructor(cfg: Config = C) {
    this.cfg = cfg;
  }

  private ringFor(config: AnalysisConfig): RollingRingDetector {
    const fft = Math.trunc(config.detectFft ?? this.cfg.feedback.detectFft);
    const ring = this.ring;
    if (ring !== null && ring.fftSize === fft && ring.sampleRate === config.sampleRate) return ring;
    const fresh = new RollingRingDetector(fft, config.sampleRate, this.cfg.feedback.ringDb);
    this.ring = fresh;
    return fresh;
  }

  analyse(
    frame: Frame,
    config: AnalysisConfig,
    onError: (exc: unknown) => void = () => undefined,
    wantPhases: boolean = true,
  ): AnalysedBlock {
    const feats = new Map<number, ChannelFeatures>();
    const ringDb = config.ringDb ?? this.cfg.feedback.ringDb;
    const maxLagMs = config.maxLagMs ?? this.cfg.phase.maxLagMs;
    for (const [ch, samples] of frame) {
      if (!config.channels.includes(ch)) continue;
      try {
        const isMeas = ch === config.measCh;
        const feat = analyseBlock(samples, config.sampleRate, { ring: !isMeas, ringDb });
        if (isMeas) {
          const [fbFreq, harmonicity] = this.ringFor(config).update(samples, ringDb);
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
        phases.push({ a, b, relation: phaseRelation(sa, sb, config.sampleRate, maxLagMs) });
      } catch (exc) {
        onError(exc);
      }
    }
    return { feats, phases };
  }
}
