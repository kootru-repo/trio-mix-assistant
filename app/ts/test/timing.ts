const REFERENCE_MS = 4;

let factor: number | null = null;

function calibrationWork(): number {
  let x = 0;
  for (let i = 1; i <= 400_000; i++) x += Math.sqrt(i) % 7;
  return x;
}

export function slowness(): number {
  if (factor !== null) return factor;
  calibrationWork();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    calibrationWork();
    best = Math.min(best, performance.now() - t0);
  }
  factor = Math.max(1, best / REFERENCE_MS);
  return factor;
}

export const budgetMs = (ms: number): number => ms * slowness();
