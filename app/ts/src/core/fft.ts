export interface Spectrum {
  re: Float64Array;
  im: Float64Array;
}

const isPow2 = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;

const nextPow2 = (n: number): number => {
  let m = 1;
  while (m < n) m <<= 1;
  return m;
};

const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array }>();

function twiddles(n: number): { cos: Float64Array; sin: Float64Array } {
  let t = twiddleCache.get(n);
  if (!t) {
    const half = n >> 1;
    const cos = new Float64Array(half);
    const sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      const a = (-2 * Math.PI * i) / n;
      cos[i] = Math.cos(a);
      sin[i] = Math.sin(a);
    }
    t = { cos, sin };
    twiddleCache.set(n, t);
  }
  return t;
}

function fftPow2(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  const tw = twiddles(n);
  const sign = inverse ? -1 : 1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let start = 0; start < n; start += len) {
      for (let k = 0; k < half; k++) {
        const wr = tw.cos[k * step]!;
        const wi = sign * tw.sin[k * step]!;
        const a = start + k;
        const b = a + half;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! / n;
      im[i] = im[i]! / n;
    }
  }
}

interface BluesteinPlan {
  n: number;
  m: number;
  wr: Float64Array;
  wi: Float64Array;
  kr: Float64Array;
  ki: Float64Array;
}

const BLUESTEIN_CACHE_MAX = 65536;
const lastPlans: [BluesteinPlan | null, BluesteinPlan | null] = [null, null];

function bluesteinPlan(n: number, inverse: boolean): BluesteinPlan {
  const cached = lastPlans[inverse ? 1 : 0];
  if (cached !== null && cached.n === n) return cached;
  const m = nextPow2(2 * n - 1);
  const sign = inverse ? 1 : -1;
  const wr = new Float64Array(n);
  const wi = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const kk = (k * k) % (2 * n);
    const a = (sign * Math.PI * kk) / n;
    wr[k] = Math.cos(a);
    wi[k] = Math.sin(a);
  }
  const kr = new Float64Array(m);
  const ki = new Float64Array(m);
  kr[0] = wr[0]!;
  ki[0] = -wi[0]!;
  for (let k = 1; k < n; k++) {
    kr[k] = wr[k]!;
    ki[k] = -wi[k]!;
    kr[m - k] = wr[k]!;
    ki[m - k] = -wi[k]!;
  }
  fftPow2(kr, ki, false);
  const plan: BluesteinPlan = { n, m, wr, wi, kr, ki };
  if (n <= BLUESTEIN_CACHE_MAX) lastPlans[inverse ? 1 : 0] = plan;
  return plan;
}

function bluestein(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  const { m, wr, wi, kr: br, ki: bi } = bluesteinPlan(n, inverse);
  const ar = new Float64Array(m);
  const ai = new Float64Array(m);
  for (let k = 0; k < n; k++) {
    ar[k] = re[k]! * wr[k]! - im[k]! * wi[k]!;
    ai[k] = re[k]! * wi[k]! + im[k]! * wr[k]!;
  }
  fftPow2(ar, ai, false);
  for (let i = 0; i < m; i++) {
    const r = ar[i]! * br[i]! - ai[i]! * bi[i]!;
    const q = ar[i]! * bi[i]! + ai[i]! * br[i]!;
    ar[i] = r;
    ai[i] = q;
  }
  fftPow2(ar, ai, true);
  for (let k = 0; k < n; k++) {
    const r = ar[k]! * wr[k]! - ai[k]! * wi[k]!;
    const q = ar[k]! * wi[k]! + ai[k]! * wr[k]!;
    re[k] = inverse ? r / n : r;
    im[k] = inverse ? q / n : q;
  }
}

export function fftInPlace(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  if (n <= 1) return;
  if (isPow2(n)) fftPow2(re, im, inverse);
  else bluestein(re, im, inverse);
}

export function rfft(x: ArrayLike<number>): Spectrum {
  const n = x.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = x[i]!;
  fftInPlace(re, im, false);
  const bins = (n >> 1) + 1;
  return { re: re.slice(0, bins), im: im.slice(0, bins) };
}

export function irfft(spec: Spectrum, n: number): Float64Array {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const bins = (n >> 1) + 1;
  for (let k = 0; k < bins && k < spec.re.length; k++) {
    re[k] = spec.re[k]!;
    im[k] = spec.im[k]!;
  }
  im[0] = 0;
  if (n % 2 === 0 && bins - 1 < spec.re.length) im[n >> 1] = 0;
  for (let k = 1; k < n - bins + 1; k++) {
    re[n - k] = re[k]!;
    im[n - k] = -im[k]!;
  }
  fftInPlace(re, im, true);
  return re;
}

export function magnitude(spec: Spectrum): Float64Array {
  const out = new Float64Array(spec.re.length);
  for (let i = 0; i < out.length; i++) {
    const r = spec.re[i]!;
    const q = spec.im[i]!;
    out[i] = Math.sqrt(r * r + q * q);
  }
  return out;
}

const hanningCache = new Map<number, Float64Array>();

export function hanning(m: number): Float64Array {
  if (m < 1) return new Float64Array(0);
  let w = hanningCache.get(m);
  if (w === undefined) {
    if (m === 1) w = Float64Array.of(1);
    else {
      w = new Float64Array(m);
      for (let i = 0; i < m; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (m - 1));
    }
    if (hanningCache.size >= 8) hanningCache.clear();
    hanningCache.set(m, w);
  }
  return w;
}
