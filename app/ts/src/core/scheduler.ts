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
    this.nextT = now;
  }

  plan(now: number): TickPlan {
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
  private offset: number | null = null;

  constructor(opts: WallWatchOptions) {
    this.opts = opts;
  }

  observe(mono: number, wall: number): number | null {
    const current = wall - mono;
    if (this.offset === null) {
      this.offset = current;
      return null;
    }
    const drift = current - this.offset;
    if (Math.abs(drift) > this.opts.jumpS) {
      this.offset = current;
      return drift;
    }
    return null;
  }

  reset(): void {
    this.offset = null;
  }
}
