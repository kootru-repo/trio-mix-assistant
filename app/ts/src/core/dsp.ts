import { C } from "./config.ts";
import type { CalibrationConfig } from "./config.ts";
import { hanning, irfft, magnitude, rfft } from "./fft.ts";
import { roundTo } from "./numfmt.ts";
import type { Rng } from "./rng.ts";

export type Samples = ArrayLike<number>;

export interface ChannelFeatures {
  rmsDbfs: number;
  peakDbfs: number;
  fbFreq: number | null;
  contrastDb: number;
  harmonicity: number;
  spectrum: Float64Array;
}

export const emptyFeatures = (): ChannelFeatures => ({
  rmsDbfs: -90,
  peakDbfs: -90,
  fbFreq: null,
  contrastDb: 0,
  harmonicity: 0,
  spectrum: new Float64Array(0),
});

const median = (xs: ArrayLike<number>): number => {
  const n = xs.length;
  if (n === 0) return Number.NaN;
  const sorted = Float64Array.from(xs as ArrayLike<number>).sort();
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const toDb = (mag: Float64Array): Float64Array => {
  const db = new Float64Array(mag.length);
  for (let i = 0; i < mag.length; i++) db[i] = 20 * Math.log10(mag[i]! + 1e-9);
  return db;
};

const argmax = (xs: ArrayLike<number>): number => {
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i]! > xs[best]!) best = i;
  return best;
};

export interface AnalyseOptions {
  ring?: boolean;
  ringDb?: number;
}

export function analyseBlock(samples: Samples, sr: number = C.SAMPLE_RATE, opts: AnalyseOptions = {}): ChannelFeatures {
  const n = samples.length;
  if (n === 0) return emptyFeatures();
  let sumSq = 0;
  let peakAbs = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i]!;
    sumSq += v * v;
    const a = Math.abs(v);
    if (a > peakAbs) peakAbs = a;
  }
  if (!Number.isFinite(sumSq)) return emptyFeatures();
  const rms = Math.sqrt(sumSq / n) + 1e-12;
  const peak = peakAbs + 1e-12;
  const f: ChannelFeatures = {
    rmsDbfs: 20 * Math.log10(rms),
    peakDbfs: 20 * Math.log10(peak),
    fbFreq: null,
    contrastDb: 0,
    harmonicity: 0,
    spectrum: new Float64Array(0),
  };
  const win = hanning(n);
  const windowed = new Float64Array(n);
  for (let i = 0; i < n; i++) windowed[i] = samples[i]! * win[i]!;
  const mag = magnitude(rfft(windowed));
  f.spectrum = mag;
  if (mag.length) {
    const db = toDb(mag);
    let maxDb = db[0]!;
    for (let i = 1; i < db.length; i++) if (db[i]! > maxDb) maxDb = db[i]!;
    const floor = median(db);
    f.contrastDb = maxDb - floor;
    const k = opts.ring === false ? null : findRingBin(db, opts.ringDb);
    if (k !== null) {
      f.fbFreq = binToHz(parabolicPeak(db, k), mag.length, sr);
      f.harmonicity = harmonicityOf(db, k, floor);
    }
  }
  return f;
}

export const binToHz = (k: number, nbins: number, sr: number): number => (k * (sr / 2)) / (nbins - 1);

export function parabolicPeak(db: Float64Array, k: number): number {
  if (k <= 0 || k >= db.length - 1) return k;
  const a = db[k - 1]!;
  const b = db[k]!;
  const c = db[k + 1]!;
  const denom = a - 2 * b + c;
  if (denom === 0) return k;
  const delta = (0.5 * (a - c)) / denom;
  if (!(delta >= -0.5 && delta <= 0.5)) return k;
  return k + delta;
}

export function findRingBin(db: Float64Array, ringDb: number = C.feedback.ringDb): number | null {
  if (db.length < 16) return null;
  const k = argmax(db);
  if (k === 0) return null;
  const lo = Math.max(0, k - 6);
  const hi = Math.min(db.length, k + 7);
  const neighbourhood: number[] = [];
  for (let i = lo; i < k; i++) neighbourhood.push(db[i]!);
  for (let i = k + 1; i < hi; i++) neighbourhood.push(db[i]!);
  if (neighbourhood.length === 0) return null;
  return db[k]! - median(neighbourhood) > ringDb ? k : null;
}

export function harmonicityOf(db: Float64Array, k: number, floor: number = median(db)): number {
  const fund = db[k]! - floor;
  if (fund <= 0) return 0;
  const partials: number[] = [];
  for (const h of [2, 3]) {
    const kb = k * h;
    if (kb < db.length) partials.push(Math.max(0, db[kb]! - floor));
  }
  if (partials.length < 2) return 0;
  return Math.min(1, Math.min(...partials) / fund);
}

export class RollingRingDetector {
  private readonly n: number;
  private readonly sr: number;
  private readonly ringDb: number;
  private buf = new Float32Array(0);
  private readonly win: Float64Array;

  constructor(fftSize: number = C.feedback.detectFft, sr: number = C.SAMPLE_RATE, ringDb: number = C.feedback.ringDb) {
    this.n = Math.trunc(fftSize);
    this.sr = sr;
    this.ringDb = ringDb;
    this.win = hanning(this.n);
  }

  get fftSize(): number {
    return this.n;
  }

  get sampleRate(): number {
    return this.sr;
  }

  update(samples: Samples, ringDb: number = this.ringDb): [number | null, number] {
    if (samples.length) {
      const merged = new Float32Array(this.buf.length + samples.length);
      merged.set(this.buf, 0);
      for (let i = 0; i < samples.length; i++) merged[this.buf.length + i] = samples[i]!;
      this.buf = merged.length > this.n ? merged.slice(merged.length - this.n) : merged;
    }
    const buf = this.buf;
    if (buf.length < 16) return [null, 0];
    const w = buf.length === this.n ? this.win : hanning(buf.length);
    const windowed = new Float64Array(buf.length);
    for (let i = 0; i < buf.length; i++) windowed[i] = buf[i]! * w[i]!;
    const mag = magnitude(rfft(windowed));
    const db = toDb(mag);
    const k = findRingBin(db, ringDb);
    if (k === null) return [null, 0];
    return [binToHz(parabolicPeak(db, k), mag.length, this.sr), harmonicityOf(db, k)];
  }
}

export interface PhaseRelation {
  zeroCorr: number;
  bestCorr: number;
  lagSamples: number;
  lagMs: number;
}

const noPhase = (): PhaseRelation => ({ zeroCorr: 0, bestCorr: 0, lagSamples: 0, lagMs: 0 });

export function phaseRelation(
  a: Samples,
  b: Samples,
  sr: number = C.SAMPLE_RATE,
  maxLagMs: number = C.phase.maxLagMs,
): PhaseRelation {
  const n = Math.min(a.length, b.length);
  if (n < 16) return noPhase();
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  for (let i = 0; i < n; i++) {
    x[i] = a[i]! - ma;
    y[i] = b[i]! - mb;
  }
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let i = 0; i < n; i++) {
    xx += x[i]! * x[i]!;
    yy += y[i]! * y[i]!;
    xy += x[i]! * y[i]!;
  }
  const na = Math.sqrt(xx);
  const nb = Math.sqrt(yy);
  if (na < 1e-9 || nb < 1e-9) return noPhase();
  const denom = na * nb;
  const zero = xy / denom;
  let maxLag = Math.trunc((maxLagMs / 1000) * sr);
  maxLag = Math.max(1, Math.min(maxLag, n - 1));
  let bestLag = -maxLag;
  let bestVal = 0;
  let bestAbs = -1;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let s = 0;
    const j0 = Math.max(0, -lag);
    const j1 = Math.min(n, n - lag);
    for (let j = j0; j < j1; j++) s += x[j + lag]! * y[j]!;
    const v = s / denom;
    if (Math.abs(v) > bestAbs) {
      bestAbs = Math.abs(v);
      bestVal = v;
      bestLag = lag;
    }
  }
  return { zeroCorr: zero, bestCorr: bestVal, lagSamples: bestLag, lagMs: (bestLag / sr) * 1000 };
}

export function generatePinkNoise(
  seconds: number,
  rng: Rng,
  sr: number = C.SAMPLE_RATE,
  levelDbfs: number = C.calibration.noiseDbfs,
): Float32Array {
  const n = Math.trunc(seconds * sr);
  const white = new Float64Array(n);
  for (let i = 0; i < n; i++) white[i] = rng.standardNormal();
  const spec = rfft(white);
  for (let k = 0; k < spec.re.length; k++) {
    const f = Math.max(k === 0 ? 1 : k, 1) * (sr / n);
    const scale = 1 / Math.sqrt(f);
    spec.re[k] = spec.re[k]! * scale;
    spec.im[k] = spec.im[k]! * scale;
  }
  const pink = irfft(spec, n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(pink[i]!);
    if (a > peak) peak = a;
  }
  const gain = (1 / (peak + 1e-9)) * 10 ** (levelDbfs / 20);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pink[i]! * gain;
  return out;
}

export function octaveBandLevels(
  samples: Samples,
  sr: number = C.SAMPLE_RATE,
  bands: readonly number[] = C.calibration.octaveBands,
): Map<number, number> {
  const n = samples.length;
  const win = hanning(n);
  const windowed = new Float64Array(n);
  for (let i = 0; i < n; i++) windowed[i] = samples[i]! * win[i]!;
  const mag = magnitude(rfft(windowed));
  const out = new Map<number, number>();
  for (const fc of bands) {
    const lo = fc / Math.SQRT2;
    const hi = fc * Math.SQRT2;
    let sum = 0;
    let count = 0;
    for (let k = 0; k < mag.length; k++) {
      const f = (k * sr) / n;
      if (f >= lo && f < hi) {
        sum += mag[k]! * mag[k]!;
        count++;
      }
    }
    if (count > 0) out.set(fc, 20 * Math.log10(Math.sqrt(sum / count) + 1e-9));
  }
  return out;
}

export type BandPair = [number, number];

export function findResonantPeaks(
  captured: Samples,
  sr: number = C.SAMPLE_RATE,
  precomputed: Map<number, number> | null = null,
  cal: Readonly<CalibrationConfig> = C.calibration,
): { corrections: BandPair[]; watchlist: BandPair[] } {
  const bands = precomputed ?? octaveBandLevels(captured, sr, cal.octaveBands);
  const fcs = [...bands.keys()];
  const vals = fcs.map((f) => bands.get(f)!);
  const corrections: BandPair[] = [];
  const watch: BandPair[] = [];
  for (let i = 0; i < fcs.length; i++) {
    if (i === 0 || i === fcs.length - 1) continue;
    const avg = ((vals[i - 1] ?? 0) + vals[i]! + (vals[i + 1] ?? 0)) / 3;
    const excess = vals[i]! - avg;
    if (excess > cal.peakThreshDb) {
      const cut = Math.max(cal.maxCutDb, -excess);
      corrections.push([fcs[i]!, roundTo(cut, 1)]);
      watch.push([fcs[i]!, roundTo(excess, 1)]);
    }
  }
  watch.sort((a, b) => b[1] - a[1]);
  return { corrections, watchlist: watch };
}
