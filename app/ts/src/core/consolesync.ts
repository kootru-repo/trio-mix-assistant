import { faderToDb } from "./console.ts";
import type { OscArg } from "./oscwire.ts";
import { zeroPad } from "./util.ts";

export interface SyncValues {
  faderDb: number | null;
  gainDb: number | null;
  inverted: boolean | null;
}

export type SyncStatus = "idle" | "pending" | "done" | "failed";

export interface ConsoleSyncOptions {
  channels: readonly number[];
  send: (address: string) => void;
  retryS: number;
  tries: number;
}

type Kind = "fader" | "gain" | "invert";

interface Ask {
  ch: number;
  kind: Kind;
}

const unitFloat = (args: readonly OscArg[]): number | null => {
  const a = args[0];
  if (a === undefined || a.t !== "f") return null;
  if (!Number.isFinite(a.v) || a.v < 0 || a.v > 1) return null;
  return a.v;
};

const flag = (args: readonly OscArg[]): boolean | null => {
  const a = args[0];
  if (a === undefined || a.t !== "i") return null;
  if (a.v === 0) return false;
  if (a.v === 1) return true;
  return null;
};

export class ConsoleSync {
  private readonly opts: ConsoleSyncOptions;
  private readonly asks = new Map<string, Ask>();
  private readonly pending = new Set<string>();
  private values = new Map<number, SyncValues>();
  private status: SyncStatus = "idle";
  private tries = 0;
  private lastSend: number | null = 0;

  constructor(opts: ConsoleSyncOptions) {
    this.opts = opts;
    for (const ch of opts.channels) {
      this.asks.set(`/ch/${zeroPad(ch, 2)}/mix/fader`, { ch, kind: "fader" });
      this.asks.set(`/headamp/${zeroPad(ch - 1, 3)}/gain`, { ch, kind: "gain" });
      this.asks.set(`/ch/${zeroPad(ch, 2)}/preamp/invert`, { ch, kind: "invert" });
    }
  }

  get active(): boolean {
    return this.status === "pending";
  }

  begin(now: number): void {
    this.values = new Map();
    for (const ch of this.opts.channels) this.values.set(ch, { faderDb: null, gainDb: null, inverted: null });
    this.pending.clear();
    for (const address of this.asks.keys()) this.pending.add(address);
    this.status = this.pending.size === 0 ? "done" : "pending";
    this.tries = 1;
    this.lastSend = Number.isFinite(now) ? now : null;
    for (const address of this.pending) this.opts.send(address);
  }

  handle(address: string, args: readonly OscArg[]): boolean {
    if (!this.active || !this.pending.has(address)) return false;
    const ask = this.asks.get(address)!;
    const v = this.values.get(ask.ch)!;
    if (ask.kind === "invert") {
      const b = flag(args);
      if (b === null) return false;
      v.inverted = b;
    } else {
      const f = unitFloat(args);
      if (f === null) return false;
      if (ask.kind === "fader") v.faderDb = faderToDb(f);
      else v.gainDb = f * 72 - 12;
    }
    this.pending.delete(address);
    if (this.pending.size === 0) this.status = "done";
    return true;
  }

  poll(now: number): SyncStatus {
    if (!this.active || !Number.isFinite(now)) return this.status;
    if (this.lastSend === null) {
      this.lastSend = now;
      return this.status;
    }
    if (now - this.lastSend < this.opts.retryS) return this.status;
    if (this.tries < this.opts.tries) {
      this.tries += 1;
      this.lastSend = now;
      for (const address of this.pending) this.opts.send(address);
      return this.status;
    }
    const faderMissing = [...this.pending].some((a) => this.asks.get(a)!.kind === "fader");
    this.status = faderMissing ? "failed" : "done";
    return this.status;
  }

  result(): Map<number, SyncValues> {
    const out = new Map<number, SyncValues>();
    for (const ch of this.opts.channels) {
      const v = this.values.get(ch);
      out.set(ch, v === undefined ? { faderDb: null, gainDb: null, inverted: null } : { ...v });
    }
    return out;
  }

  missing(): string[] {
    return [...this.pending];
  }
}
