import { formatHhmmss } from "../core/clock.ts";
import type { Clock } from "../core/clock.ts";

export class SystemClock implements Clock {
  monotonic(): number {
    return performance.now() / 1000;
  }

  perfCounter(): number {
    return performance.now() / 1000;
  }

  time(): number {
    return Date.now() / 1000;
  }

  sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, seconds) * 1000);
    });
  }

  hhmmss(): string {
    return formatHhmmss(this.time(), false);
  }
}
