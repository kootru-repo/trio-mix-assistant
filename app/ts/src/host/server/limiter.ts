import { isIPv6 } from "node:net";
import { ipBytes } from "../tls/x509.ts";

export type LimiterClock = () => number;

interface Entry {
  fails: number;
  lockedUntil: number;
}

interface Recent {
  t: number;
  key: string;
}

export const limiterKey = (addr: string): string => {
  const bare = addr.replace(/^::ffff:/i, "");
  if (!isIPv6(bare)) return bare;
  return "v6:" + ipBytes(bare).subarray(0, 8).toString("hex");
};

export class LoginLimiter {
  readonly maxFails = 5;
  readonly lockS = 30.0;
  readonly delayS = 0.3;
  readonly globalWindowS = 60.0;
  readonly globalAttempts = 20;
  readonly globalFreshAttempts = 100;
  readonly maxClients = 256;
  private readonly clock: LimiterClock;
  private readonly clients = new Map<string, Entry>();
  private readonly recent: Recent[] = [];

  constructor(clock: LimiterClock = () => performance.now() / 1000) {
    this.clock = clock;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  admit(addr: string): boolean {
    const key = limiterKey(addr);
    const now = this.clock();
    while (this.recent.length > 0 && now - this.recent[0]!.t > this.globalWindowS) this.recent.shift();
    let entry = this.clients.get(key);
    if (entry !== undefined && now < entry.lockedUntil) return false;
    const fresh = entry === undefined || entry.fails === 0;
    const cap = fresh ? this.globalFreshAttempts : this.globalAttempts;
    if (this.recent.length >= cap) return false;
    if (entry === undefined) {
      this.evict(now);
      entry = { fails: 0, lockedUntil: 0 };
      this.clients.set(key, entry);
    }
    entry.fails += 1;
    if (entry.fails >= this.maxFails) {
      entry.fails = 0;
      entry.lockedUntil = now + this.lockS;
    }
    this.recent.push({ t: now, key });
    return true;
  }

  success(addr: string): void {
    const key = limiterKey(addr);
    this.clients.delete(key);
    for (let i = this.recent.length - 1; i >= 0; i--) {
      if (this.recent[i]!.key === key) {
        this.recent.splice(i, 1);
        return;
      }
    }
  }

  locked(addr: string): boolean {
    const entry = this.clients.get(limiterKey(addr));
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
