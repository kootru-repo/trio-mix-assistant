import { zeroPad } from "./util.ts";

export interface Clock {
  monotonic(): number;
  highResolution(): number;
  time(): number;
  sleep(seconds: number): Promise<void>;
  hhmmss(): string;
}



export function formatHhmmss(epochSeconds: number, utc: boolean): string {
  const d = new Date(epochSeconds * 1000);
  return utc
    ? `${zeroPad(d.getUTCHours(), 2)}:${zeroPad(d.getUTCMinutes(), 2)}:${zeroPad(d.getUTCSeconds(), 2)}`
    : `${zeroPad(d.getHours(), 2)}:${zeroPad(d.getMinutes(), 2)}:${zeroPad(d.getSeconds(), 2)}`;
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

  highResolution(): number {
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
