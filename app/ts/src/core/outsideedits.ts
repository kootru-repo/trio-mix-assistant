export interface OutsideEditOptions {
  echoTolDb: number;
  echoWindowS: number;
  lockMoves: number;
  lockWindowS: number;
}

export type EditKind = "echo" | "outside";

interface Write {
  db: number;
  t: number;
}

export const MAX_WRITES_PER_CHANNEL = 64;

export class OutsideEdits {
  private readonly opts: OutsideEditOptions;
  private readonly writes = new Map<number, Write[]>();
  private readonly moves = new Map<number, number[]>();
  private readonly locks = new Set<number>();

  constructor(opts: OutsideEditOptions) {
    this.opts = { ...opts };
  }

  noteWrite(ch: number, db: number, now: number): void {
    if (!Number.isFinite(db)) return;
    const kept = (this.writes.get(ch) ?? []).filter((w) => now - w.t <= this.opts.echoWindowS);
    kept.push({ db, t: now });
    this.writes.set(ch, kept.slice(-MAX_WRITES_PER_CHANNEL));
  }

  classify(ch: number, db: number, now: number): EditKind {
    if (!Number.isFinite(db)) return "echo";
    const writes = this.writes.get(ch) ?? [];
    const echo = writes.some((w) => now - w.t <= this.opts.echoWindowS && Math.abs(db - w.db) <= this.opts.echoTolDb);
    return echo ? "echo" : "outside";
  }

  noteOutside(ch: number, now: number): boolean {
    if (this.locks.has(ch)) return false;
    const kept = (this.moves.get(ch) ?? []).filter((t) => now - t <= this.opts.lockWindowS);
    kept.push(now);
    this.moves.set(ch, kept.slice(-this.opts.lockMoves));
    if (kept.length < this.opts.lockMoves) return false;
    this.locks.add(ch);
    return true;
  }

  locked(ch: number): boolean {
    return this.locks.has(ch);
  }

  unlock(ch: number): void {
    this.locks.delete(ch);
    this.moves.delete(ch);
  }

  lockedChannels(): number[] {
    return [...this.locks].sort((a, b) => a - b);
  }

  reset(): void {
    this.writes.clear();
    this.moves.clear();
    this.locks.clear();
  }
}
