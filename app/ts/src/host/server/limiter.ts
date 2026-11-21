export type LimiterClock = () => number;

interface Entry {
  fails: number;
  lockedUntil: number;
}

export class LoginLimiter {
  readonly maxFails = 5;
  readonly lockS = 30.0;
  readonly delayS = 0.3;
  readonly globalWindowS = 60.0;
  readonly globalAttempts = 20;
  readonly maxClients = 256;
  private readonly clock: LimiterClock;
  private readonly clients = new Map<string, Entry>();
  private readonly recent: number[] = [];

  constructor(clock: LimiterClock = () => performance.now() / 1000) {
    this.clock = clock;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  admit(addr: string): boolean {
    const now = this.clock();
    while (this.recent.length > 0 && now - this.recent[0]! > this.globalWindowS) this.recent.shift();
    let entry = this.clients.get(addr);
    if (entry !== undefined && now < entry.lockedUntil) return false;
    if (this.recent.length >= this.globalAttempts) return false;
    if (entry === undefined) {
      this.evict(now);
      entry = { fails: 0, lockedUntil: 0 };
      this.clients.set(addr, entry);
    }
    entry.fails += 1;
    if (entry.fails >= this.maxFails) {
      entry.fails = 0;
      entry.lockedUntil = now + this.lockS;
    }
    this.recent.push(now);
    return true;
  }

  success(addr: string): void {
    this.clients.delete(addr);
    this.recent.pop();
  }

  locked(addr: string): boolean {
    const entry = this.clients.get(addr);
    return entry !== undefined && this.clock() < entry.lockedUntil;
  }

  private evict(now: number): void {
    if (this.clients.size < this.maxClients) return;
    for (const [key, v] of [...this.clients]) {
      if (v.lockedUntil <= now && v.fails === 0) this.clients.delete(key);
    }
    while (this.clients.size >= this.maxClients) {
      let oldest: string | null = null;
      let best = Infinity;
      for (const [key, v] of this.clients) {
        if (v.lockedUntil < best) {
          best = v.lockedUntil;
          oldest = key;
        }
      }
      if (oldest === null) break;
      this.clients.delete(oldest);
    }
  }
}
