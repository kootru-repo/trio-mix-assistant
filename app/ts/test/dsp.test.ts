import assert from "node:assert/strict";
import test from "node:test";
import { C } from "../src/core/config.ts";
import {
  analyseBlock,
  findResonantPeaks,
  generatePinkNoise,
  octaveBandLevels,
  phaseRelation,
  RollingRingDetector,
} from "../src/core/dsp.ts";
import { hanning, irfft, magnitude, rfft } from "../src/core/fft.ts";
import { SeededRng } from "../src/core/rng.ts";
import { close, closeArray, f32, f64, fixture } from "./helpers.ts";

const fx = fixture("dsp");

test("analyseBlock matches the recorded reference", () => {
  for (const c of fx.analyse) {
    const f = analyseBlock(f32(c.input));
    close(f.rmsDbfs, c.rms_dbfs, 1e-5, 1e-4, `${c.name} rms`);
    close(f.peakDbfs, c.peak_dbfs, 1e-5, 1e-4, `${c.name} peak`);
    close(f.fbFreq, c.fb_freq, 1e-4, 1e-3, `${c.name} fb`);
    close(f.contrastDb, c.contrast_db, 1e-4, 1e-3, `${c.name} contrast`);
    close(f.harmonicity, c.harmonicity, 1e-3, 1e-3, `${c.name} harmonicity`);
    closeArray(f.spectrum, f64(c.spectrum), 1e-4, 1e-6, `${c.name} spectrum`);
  }
});

test("the ring cases are actually detected", () => {
  const byName = Object.fromEntries(fx.analyse.map((c: any) => [c.name, c]));
  assert.ok(byName.ring_2500.fb_freq !== null);
  assert.ok(byName.ring_200.fb_freq !== null);
  assert.equal(byName.noise.fb_freq, null);
  assert.ok(byName.harmonic_rich.harmonicity > 0.3);
});

test("RollingRingDetector matches the recorded reference block by block", () => {
  const all = f32(fx.rolling.blocks);
  const det = new RollingRingDetector();
  const len = fx.rolling.block_len;
  fx.rolling.results.forEach((r: any, i: number) => {
    const [fb, h] = det.update(all.subarray(i * len, (i + 1) * len));
    close(fb, r.fb, 1e-4, 1e-3, `block ${i} fb`);
    close(h, r.h, 1e-3, 1e-3, `block ${i} harmonicity`);
  });
});

test("phaseRelation matches the recorded reference", () => {
  for (const c of fx.phase) {
    const r = phaseRelation(f32(c.a), f32(c.b));
    close(r.zeroCorr, c.zero_corr, 1e-4, 1e-5, `${c.name} zero`);
    close(r.bestCorr, c.best_corr, 1e-4, 1e-5, `${c.name} best`);
    assert.equal(r.lagSamples, c.lag_samples, `${c.name} lag`);
    close(r.lagMs, c.lag_ms, 1e-6, 1e-9, `${c.name} lagMs`);
  }
});

test("octave bands and resonant peaks match the recorded reference on a non-power-of-two input", () => {
  const captured = f32(fx.bands.captured);
  assert.equal(captured.length, 49152);
  const bands = octaveBandLevels(captured);
  assert.equal(bands.size, fx.bands.bands.length);
  for (const [fc, db] of fx.bands.bands) close(bands.get(fc)!, db, 1e-4, 1e-3, `band ${fc}`);
  const { corrections, watchlist } = findResonantPeaks(captured);
  assert.deepEqual(
    corrections.map(([f]) => f),
    fx.bands.corrections.map(([f]: number[]) => f),
  );
  corrections.forEach(([, cut], i) => close(cut, fx.bands.corrections[i][1], 0, 0.11, "cut"));
  watchlist.forEach(([f, ex], i) => {
    assert.equal(f, fx.bands.watchlist[i][0]);
    close(ex, fx.bands.watchlist[i][1], 0, 0.11, "excess");
  });
  assert.ok(corrections.length >= 1, "the 250 Hz room mode is found");
});

test("a flat pink signal yields the same (empty or not) result as the recorded reference", () => {
  const rng = new SeededRng(30);
  const pink = generatePinkNoise(49152 / C.SAMPLE_RATE, rng);
  const { corrections } = findResonantPeaks(pink);
  assert.equal(corrections.length === 0, fx.bands.flat_corrections.length === 0);
});

test("generatePinkNoise hits its level and has a pink slope", () => {
  const p = fx.bands.pink;
  const x = generatePinkNoise(p.seconds, new SeededRng(31));
  assert.equal(x.length, p.n);
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  close(peak, p.peak, 1e-3, 1e-5, "peak");
  const bands = octaveBandLevels(x);
  const fcs = [...bands.keys()].slice(1, 8);
  const xs = fcs.map(Math.log2);
  const ys = fcs.map((f) => bands.get(f)!);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const slope = xs.reduce((s, x2, i) => s + (x2 - mx) * (ys[i]! - my), 0) / xs.reduce((s, x2) => s + (x2 - mx) ** 2, 0);
  assert.ok(Math.abs(slope - p.slope_db_per_octave) < 1.5, `slope ${slope} vs ${p.slope_db_per_octave}`);
});

test("rfft and irfft round-trip for power-of-two and odd lengths", () => {
  for (const n of [8, 1000, 1024, 3001, 49152]) {
    const rng = new SeededRng(n);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = rng.standardNormal();
    const back = irfft(rfft(x), n);
    closeArray(back, x, 1e-7, 1e-9, `n=${n}`);
  }
});

test("rfft of a pure tone peaks at the right bin, and the window handles its edge cases", () => {
  const n = 4096;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 1000 * i) / C.SAMPLE_RATE * (n / n));
  const mag = magnitude(rfft(x));
  let k = 0;
  for (let i = 1; i < mag.length; i++) if (mag[i]! > mag[k]!) k = i;
  assert.ok(Math.abs((k * C.SAMPLE_RATE) / n - 1000) < C.SAMPLE_RATE / n);
  assert.deepEqual([...hanning(1)], [1]);
  assert.equal(hanning(0).length, 0);
  close(hanning(5)[2]!, 1, 0, 1e-12);
});
