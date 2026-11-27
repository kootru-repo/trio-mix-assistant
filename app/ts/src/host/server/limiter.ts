import { isIPv6 } from "node:net";
import type { SafetyConfig } from "../../core/config.ts";
import { ipBytes } from "../tls/x509.ts";

export type LimiterClock = () => number;

interface Entry {
  fails: number;
  lockedUntil: number;
  strikes: number;
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
  readonly maxLockS = 900.0;
  readonly delayS = 0.3;
  readonly globalWindowS = 60.0;
  readonly globalAttempts = 20;
  readonly globalFreshAttempts = 30;
  readonly maxClients = 256;
  readonly maxTrusted = 64;
  private readonly clock: LimiterClock;
  private readonly clients = new Map<string, Entry>();
  private readonly recent: Recent[] = [];
  private readonly trusted = new Set<string>();

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
    if (!this.trusted.has(key) && this.recent.length >= cap) return false;
    if (entry === undefined) {
      this.evict(now);
      entry = { fails: 0, lockedUntil: 0, strikes: 0 };
      this.clients.set(key, entry);
    }
    entry.fails += 1;
    if (entry.fails >= this.maxFails) {
      entry.fails = 0;
      entry.lockedUntil = now + Math.min(this.maxLockS, this.lockS * 2 ** entry.strikes);
      entry.strikes += 1;
    }
    this.recent.push({ t: now, key });
    return true;
  }

  success(addr: string): void {
    const key = limiterKey(addr);
    this.clients.delete(key);
    this.trusted.delete(key);
    if (this.trusted.size >= this.maxTrusted) {
      for (const oldest of this.trusted) {
        this.trusted.delete(oldest);
        break;
      }
    }
    this.trusted.add(key);
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
      if (v.lockedUntil <= now && v.fails === 0 && v.strikes === 0) this.clients.delete(key);
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

export class AddressCounter {
  readonly limit: number;
  private readonly counts = new Map<string, number>();

  constructor(limit: number) {
    this.limit = limit;
  }

  get size(): number {
    return this.counts.size;
  }

  take(key: string): boolean {
    const n = this.counts.get(key) ?? 0;
    if (n >= this.limit) return false;
    this.counts.set(key, n + 1);
    return true;
  }

  release(key: string): void {
    const n = (this.counts.get(key) ?? 0) - 1;
    if (n <= 0) this.counts.delete(key);
    else this.counts.set(key, n);
  }
}

interface Bucket {
  tokens: number;
  t: number;
}

export class CommandBudget {
  readonly rate: number;
  readonly burst: number;
  readonly maxKeys = 256;
  dropped = 0;
  private readonly clock: LimiterClock;
  private readonly buckets = new Map<string, Bucket>();

  constructor(rate: number = 200, burst: number = 400, clock: LimiterClock = () => performance.now() / 1000) {
    this.rate = rate;
    this.burst = burst;
    this.clock = clock;
  }

  allow(key: string): boolean {
    const now = this.clock();
    let b = this.buckets.get(key);
    if (b === undefined) {
      if (this.buckets.size >= this.maxKeys) {
        for (const [k, v] of [...this.buckets]) {
          if (now - v.t > this.burst / this.rate) this.buckets.delete(k);
        }
        if (this.buckets.size >= this.maxKeys) {
          this.dropped += 1;
          return false;
        }
      }
      b = { tokens: this.burst, t: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.burst, b.tokens + Math.max(0, now - b.t) * this.rate);
    b.t = Math.max(b.t, now);
    if (b.tokens < 1) {
      this.dropped += 1;
      return false;
    }
    b.tokens -= 1;
    return true;
  }
}

export const GLOBAL_COMMAND_KEY = "*";

export const globalCommandBudget = (safety: Readonly<SafetyConfig>, clock: LimiterClock = () => performance.now() / 1000): CommandBudget =>
  new CommandBudget(safety.commandPerS, safety.commandBurst, clock);
