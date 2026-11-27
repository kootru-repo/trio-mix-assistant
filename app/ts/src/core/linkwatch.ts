export type LinkState = "waiting" | "up" | "stale" | "down";

export interface LinkWatchOptions {
  probeS: number;
  staleS: number;
  downS: number;
  steadyS: number;
}

export interface LinkTick {
  state: LinkState;
  changed: boolean;
  probe: boolean;
  recovered: boolean;
}

export class LinkWatch {
  private readonly opts: LinkWatchOptions;
  private current: LinkState = "waiting";
  private run: { start: number; last: number } | null = null;
  private firstTick: number | null = null;
  private lastProbe: number | null = null;

  constructor(opts: LinkWatchOptions) {
    this.opts = { ...opts };
  }

  get state(): LinkState {
    return this.current;
  }

  heard(now: number): void {
    const start = this.run === null || now - this.run.last > this.opts.staleS ? now : this.run.start;
    this.run = { start, last: now };
  }

  tick(now: number): LinkTick {
    const origin = this.firstTick ?? now;
    this.firstTick = origin;
    const prev = this.current;
    const next = this.next(now, prev);
    this.current = next;
    const changed = next !== prev;
    return {
      state: next,
      changed,
      probe: this.probe(now, this.run === null ? origin : this.run.last),
      recovered: changed && next === "up" && prev !== "waiting",
    };
  }

  reset(): void {
    this.current = "waiting";
    this.run = null;
    this.firstTick = null;
    this.lastProbe = null;
  }

  private next(now: number, prev: LinkState): LinkState {
    if (this.run === null) {
      return "waiting";
    }
    const silence = now - this.run.last;
    const steady = silence <= this.opts.staleS && now - this.run.start >= this.opts.steadyS;
    if (prev === "waiting") {
      return steady ? "up" : "waiting";
    }
    if (silence > this.opts.downS) {
      return "down";
    }
    if (silence > this.opts.staleS) {
      return prev === "down" ? "down" : "stale";
    }
    if (steady) {
      return "up";
    }
    return prev === "up" ? "stale" : prev;
  }

  private probe(now: number, since: number): boolean {
    if (now - since <= this.opts.probeS) {
      return false;
    }
    if (this.lastProbe !== null && now - this.lastProbe < this.opts.probeS) {
      return false;
    }
    this.lastProbe = now;
    return true;
  }
}
