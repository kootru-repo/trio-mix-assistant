export interface TickPlan {
  sleepS: number;
  resumed: boolean;
  gapS: number;
}

export interface TickSchedulerOptions {
  tick: number;
  maxLagS: number;
}

export class TickScheduler {
  private readonly opts: TickSchedulerOptions;
  private nextT = 0;

  constructor(opts: TickSchedulerOptions) {
    this.opts = opts;
  }

  start(now: number): void {
    if (Number.isFinite(now)) this.nextT = now;
  }

  plan(now: number): TickPlan {
    if (!Number.isFinite(now)) return { sleepS: this.opts.tick, resumed: false, gapS: 0 };
    this.nextT += this.opts.tick;
    const lag = now - this.nextT;
    if (lag > this.opts.maxLagS) {
      this.nextT = now + this.opts.tick;
      return { sleepS: this.opts.tick, resumed: true, gapS: lag };
    }
    return { sleepS: Math.max(0, this.nextT - now), resumed: false, gapS: 0 };
  }
}

export interface WallWatchOptions {
  jumpS: number;
}

export class WallWatch {
  private readonly opts: WallWatchOptions;
  private prev: { mono: number; wall: number } | null = null;

  constructor(opts: WallWatchOptions) {
    this.opts = opts;
  }

  observe(mono: number, wall: number): number | null {
    if (!Number.isFinite(mono) || !Number.isFinite(wall)) return null;
    const prev = this.prev;
    this.prev = { mono, wall };
    if (prev === null) return null;
    const step = wall - prev.wall - (mono - prev.mono);
    return Math.abs(step) > this.opts.jumpS ? step : null;
  }

  reset(): void {
    this.prev = null;
  }
}
