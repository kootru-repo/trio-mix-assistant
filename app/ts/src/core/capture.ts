import type { Config } from "./config.ts";
import type { SimConsole } from "./console.ts";
import { generatePinkNoise } from "./dsp.ts";
import type { Samples } from "./dsp.ts";
import type { AnalysedBlock } from "./blockanalysis.ts";
import { SeededRng } from "./rng.ts";
import type { Rng } from "./rng.ts";

export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

export type Frame = Map<number, Float32Array>;

export interface CaptureStatus {
  kind: string;
  [key: string]: unknown;
}

export type BlockHandler = (block: AnalysedBlock, ageS: number) => void;

export interface CaptureSource {
  subscribe?(handler: BlockHandler): void;
  ready?(): Promise<void>;
  settled?(): Promise<void>;
  start(): void;
  stop(): void;
  block(): Frame;
  captureMeas(seconds: number): Promise<Samples | null>;
  emitPinkNoise(samples: Float32Array): Promise<boolean>;
  dead(): boolean;
  silent(): boolean;
  restart(): Promise<boolean>;
  status(): CaptureStatus;
}

export abstract class CaptureSourceBase implements CaptureSource {
  start(): void {}

  stop(): void {}

  abstract block(): Frame;

  captureMeas(_seconds: number): Promise<Samples | null> {
    return Promise.resolve(null);
  }

  emitPinkNoise(_samples: Float32Array): Promise<boolean> {
    return Promise.resolve(true);
  }

  dead(): boolean {
    return false;
  }

  silent(): boolean {
    return false;
  }

  restart(): Promise<boolean> {
    return Promise.resolve(false);
  }

  status(): CaptureStatus {
    return { kind: "none" };
  }
}

export function simRoomCapture(rng: Rng, cfg: Config): Float64Array {
  const noise = generatePinkNoise(cfg.calibration.durationS, rng, cfg.SAMPLE_RATE, cfg.calibration.noiseDbfs);
  const out = new Float64Array(noise.length);
  for (let i = 0; i < noise.length; i++) {
    const t = i / cfg.SAMPLE_RATE;
    out[i] = noise[i]! + 0.3 * Math.sin(2 * Math.PI * 250.0 * t) + 0.22 * Math.sin(2 * Math.PI * 2500.0 * t);
  }
  return out;
}

export class SimCapture extends CaptureSourceBase {
  static readonly NOISE = 0.008;
  static readonly RING_FREQ = 2500.0;
  static readonly BOOM_FREQ = 250.0;

  private readonly con: SimConsole;
  private readonly cfg: Config;
  readonly rng: Rng;
  private n = 0;
  private blockI = 0;
  private ringAmp = 0;
  private nextRing = 40;
  private clipUntil = -1;
  private nextClip = 90;

  constructor(console: SimConsole, cfg: Config, seed: number | bigint = 7, rng: Rng | null = null) {
    super();
    this.con = console;
    this.cfg = cfg;
    this.rng = rng ?? new SeededRng(seed);
  }

  private gaintrimLin(ch: number): number {
    const trim = (this.con.gainDb.get(ch) ?? 20) - 20;
    return 10 ** (trim / 20);
  }

  private normals(): Float64Array {
    const out = new Float64Array(this.cfg.BLOCK);
    for (let i = 0; i < this.cfg.BLOCK; i++) out[i] = this.rng.standardNormal();
    return out;
  }

  block(): Frame {
    const cfg = this.cfg;
    const nb = cfg.BLOCK;
    const t = new Float64Array(nb);
    for (let k = 0; k < nb; k++) t[k] = (this.n + k) / cfg.SAMPLE_RATE;
    this.n += nb;
    this.blockI += 1;
    const i = this.blockI;
    const frame: Frame = new Map();
    const sin = (freq: number, k: number): number => Math.sin((2 * Math.PI * freq * t[k]!) as number);

    for (const [ch, roleName] of cfg.CHANNELS) {
      const x = this.normals();
      for (let k = 0; k < nb; k++) x[k] = SimCapture.NOISE * x[k]!;
      const lin = this.gaintrimLin(ch);
      if (roleName === "lead_vox") {
        for (let k = 0; k < nb; k++) {
          const env = 10 ** ((3.0 * Math.sin((2 * Math.PI * t[k]!) / 20.0)) / 20.0);
          const vib = 220.0 * (1 + 0.015 * Math.sin(2 * Math.PI * 5.0 * t[k]!));
          x[k] = x[k]! + 0.5 * env * Math.sin(2 * Math.PI * vib * t[k]!);
        }
      } else if (roleName === "harm_vox_l") {
        for (let k = 0; k < nb; k++) x[k] = x[k]! + 0.06 * sin(330.0, k);
      } else if (roleName === "harm_vox_r") {
        for (let k = 0; k < nb; k++) x[k] = x[k]! + 0.06 * sin(440.0, k);
      } else if (roleName === "acoustic_gtr") {
        const extra = this.normals();
        for (let k = 0; k < nb; k++) x[k] = x[k]! + 0.09 * sin(196.0, k) + 0.03 * extra[k]!;
      } else if (roleName === "bass_di") {
        for (let k = 0; k < nb; k++) x[k] = x[k]! + 0.12 * sin(82.0, k);
      } else if (roleName === "cajon") {
        const extra = this.normals();
        for (let k = 0; k < nb; k++) x[k] = x[k]! + 0.05 * extra[k]!;
      } else if (roleName === "keys_aux") {
        for (let k = 0; k < nb; k++) x[k] = x[k]! + 0.07 * sin(262.0, k);
      }
      if (roleName === "cajon" && i <= this.clipUntil) {
        for (let k = 0; k < nb; k++) x[k] = x[k]! + 0.95 * sin(700.0, k);
      }
      const out = new Float32Array(nb);
      for (let k = 0; k < nb; k++) out[k] = x[k]! * lin;
      frame.set(ch, out);
    }

    const room = this.normals();
    for (let k = 0; k < nb; k++) room[k] = SimCapture.NOISE * room[k]! + 0.055 * sin(SimCapture.BOOM_FREQ, k);
    if (i >= this.nextRing && this.ringAmp === 0) this.ringAmp = 0.05;
    if (this.ringAmp > 0) {
      if (this.con.isTamed(cfg.MEAS_MIC_CH, SimCapture.RING_FREQ)) {
        this.ringAmp *= 0.55;
        if (this.ringAmp < 0.01) {
          this.ringAmp = 0;
          this.nextRing = i + 120;
        }
      } else {
        this.ringAmp = Math.min(0.9, this.ringAmp * 1.25);
      }
      for (let k = 0; k < nb; k++) room[k] = room[k]! + this.ringAmp * sin(SimCapture.RING_FREQ, k);
    }
    frame.set(cfg.MEAS_MIC_CH, Float32Array.from(room));

    if (i >= this.nextClip && i > this.clipUntil) {
      this.clipUntil = i + 5;
      this.nextClip = i + 160;
    }
    return frame;
  }

  override captureMeas(_seconds: number): Promise<Samples | null> {
    return Promise.resolve(simRoomCapture(this.rng, this.cfg));
  }

  override status(): CaptureStatus {
    return { kind: "simulation" };
  }
}
