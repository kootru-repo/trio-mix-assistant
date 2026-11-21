import { formatHhmmss } from "../src/core/clock.ts";
import type { Clock } from "../src/core/clock.ts";

interface Sleeper {
  wake: number;
  resolve: () => void;
}

export class StepClock implements Clock {
  private now: number;
  private wall: number;
  private sleepers: Sleeper[] = [];

  constructor(start: number = 0, wall: number = 0) {
    this.now = start;
    this.wall = wall;
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

  hhmmss(): string {
    return formatHhmmss(this.wall, true);
  }

  sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepers.push({ wake: this.now + Math.max(0, seconds), resolve });
    });
  }

  get waiting(): number {
    return this.sleepers.length;
  }

  async advance(seconds: number): Promise<void> {
    const target = this.now + seconds;
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.sleepers.length; i++) {
        const s = this.sleepers[i]!;
        if (s.wake <= target + 1e-12 && (best < 0 || s.wake < this.sleepers[best]!.wake)) best = i;
      }
      if (best < 0) break;
      const [s] = this.sleepers.splice(best, 1);
      this.wall += Math.max(0, s!.wake - this.now);
      this.now = Math.max(this.now, s!.wake);
      s!.resolve();
      for (let k = 0; k < 40; k++) await Promise.resolve();
    }
    this.wall += Math.max(0, target - this.now);
    this.now = Math.max(this.now, target);
  }
}
