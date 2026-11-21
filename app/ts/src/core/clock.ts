export interface Clock {
  monotonic(): number;
  perfCounter(): number;
  time(): number;
  sleep(seconds: number): Promise<void>;
  hhmmss(): string;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function formatHhmmss(epochSeconds: number, utc: boolean): string {
  const d = new Date(epochSeconds * 1000);
  return utc
    ? `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
    : `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export class ManualClock implements Clock {
  private now: number;
  private wall: number;

  constructor(start: number = 0, wall: number = 0) {
    this.now = start;
    this.wall = wall;
  }

  advance(seconds: number): void {
    this.now += seconds;
    this.wall += seconds;
  }

  monotonic(): number {
    return this.now;
  }

  perfCounter(): number {
    return this.now;
  }

  time(): number {
    return this.wall;
  }

  sleep(seconds: number): Promise<void> {
    this.advance(Math.max(0, seconds));
    return Promise.resolve();
  }

  hhmmss(): string {
    return formatHhmmss(this.wall, true);
  }
}
