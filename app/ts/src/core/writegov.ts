import type { OscArg } from "./oscwire.ts";

export type Lane = "safety" | "manual" | "auto";

export interface GovernorOptions {
  manualPerS: number;
  manualBurst: number;
  autoPerS: number;
  autoBurst: number;
  totalPerS: number;
  repeatS: number;
  stormS: number;
}

export interface GovernorStats {
  sent: number;
  merged: number;
  skipped: number;
  queued: number;
}

type LimitedLane = "manual" | "auto";

interface Bucket {
  tokens: number;
  readonly rate: number;
  readonly cap: number;
}

interface Pending {
  lane: LimitedLane;
  args: readonly OscArg[];
}

interface Emitted {
  args: readonly OscArg[];
  at: number;
}

const EPS = 1e-9;

function bucket(rate: number, cap: number): Bucket {
  return { tokens: cap, rate, cap };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function argEqual(x: OscArg, y: OscArg): boolean {
  if (x.t !== y.t) return false;
  if (x.t === "b") return y.t === "b" && bytesEqual(x.v, y.v);
  return Object.is(x.v, y.v);
}

export function sameArgs(a: readonly OscArg[], b: readonly OscArg[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i];
      return y !== undefined && argEqual(x, y);
    })
  );
}

export class WriteGovernor {
  private readonly opts: GovernorOptions;
  private readonly emit: (address: string, args: readonly OscArg[]) => void;
  private readonly lanes: Record<LimitedLane, Bucket>;
  private readonly total: Bucket;
  private readonly queue = new Map<string, Pending>();
  private readonly last = new Map<string, Emitted>();
  private clock = 0;
  private started = false;
  private autoSince: number | null = null;
  private readonly counts: GovernorStats = { sent: 0, merged: 0, skipped: 0, queued: 0 };

  constructor(opts: GovernorOptions, emit: (address: string, args: readonly OscArg[]) => void) {
    this.opts = opts;
    this.emit = emit;
    this.lanes = { manual: bucket(opts.manualPerS, opts.manualBurst), auto: bucket(opts.autoPerS, opts.autoBurst) };
    this.total = bucket(opts.totalPerS, opts.totalPerS);
  }

  submit(lane: Lane, address: string, args: readonly OscArg[], now: number): void {
    this.refill(now);
    if (lane === "safety") {
      if (args.length > 0 || this.queue.get(address)?.lane === "auto") this.queue.delete(address);
      this.send(address, args);
      this.trackStorm();
      return;
    }
    const pending = this.queue.get(address);
    if (pending) {
      pending.args = args;
      pending.lane = lane;
      this.counts.merged++;
      this.drain();
    } else {
      this.drain();
      this.place(lane, address, args);
    }
    this.trackStorm();
  }

  pump(now: number): void {
    this.refill(now);
    this.drain();
    this.trackStorm();
  }

  backlog(lane?: LimitedLane): number {
    if (lane === undefined) return this.queue.size;
    let n = 0;
    for (const p of this.queue.values()) if (p.lane === lane) n++;
    return n;
  }

  storming(now: number): boolean {
    return this.autoSince !== null && Math.max(now, this.clock) - this.autoSince >= this.opts.stormS;
  }

  clearRepeats(): void {
    this.last.clear();
  }

  stats(): GovernorStats {
    return { ...this.counts };
  }

  private refill(now: number): void {
    if (!Number.isFinite(now)) return;
    if (!this.started) {
      this.started = true;
      this.clock = now;
      return;
    }
    const dt = now - this.clock;
    if (dt <= 0) return;
    this.clock = now;
    for (const b of [this.lanes.manual, this.lanes.auto, this.total]) b.tokens = Math.min(b.cap, b.tokens + b.rate * dt);
  }

  private take(lane: LimitedLane): boolean {
    const b = this.lanes[lane];
    if (b.tokens < 1 - EPS || this.total.tokens < 1 - EPS) return false;
    b.tokens -= 1;
    this.total.tokens -= 1;
    return true;
  }

  private drain(): void {
    for (const [address, p] of this.queue) {
      if (this.total.tokens < 1 - EPS) return;
      if (!this.take(p.lane)) continue;
      this.queue.delete(address);
      this.send(address, p.args);
    }
  }

  private place(lane: LimitedLane, address: string, args: readonly OscArg[]): void {
    if (this.isRepeat(address, args)) {
      this.counts.skipped++;
    } else if (this.backlog(lane) === 0 && this.take(lane)) {
      this.send(address, args);
    } else {
      this.queue.set(address, { lane, args });
      this.counts.queued++;
    }
  }

  private isRepeat(address: string, args: readonly OscArg[]): boolean {
    const prev = this.last.get(address);
    return prev !== undefined && this.clock - prev.at < this.opts.repeatS && sameArgs(prev.args, args);
  }

  private send(address: string, args: readonly OscArg[]): void {
    this.last.set(address, { args, at: this.clock });
    this.counts.sent++;
    this.emit(address, args);
  }

  private trackStorm(): void {
    if (this.backlog("auto") === 0) this.autoSince = null;
    else if (this.autoSince === null) this.autoSince = this.clock;
  }
}
