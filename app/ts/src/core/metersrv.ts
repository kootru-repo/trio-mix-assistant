import { C } from "./config.ts";
import type { Config } from "./config.ts";
import { faderToDb } from "./console.ts";
import type { DatagramSink } from "./console.ts";
import { argFloat } from "./oscargs.ts";
import { parseInteger } from "./util.ts";
import { decodeMeterBlob, decodePacket } from "./oscwire.ts";
import type { OscArg } from "./oscwire.ts";
import type { Peer, UdpEndpoint, UdpFactory } from "./transport.ts";

const hostKey = (host: string): string =>
  host
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/, "");

export function chFromFaderAddr(addr: string): number | null {
  const parts = addr.split("/");
  if (parts.length === 5 && parts[1] === "ch" && parts[3] === "mix" && parts[4] === "fader") {
    return parseInteger(parts[2]!);
  }
  return null;
}

export interface MeterReceiverOptions {
  onFader?: ((ch: number, db: number) => void) | null;
  onMeters?: ((values: number[]) => void) | null;
  onMessage?: ((address: string, args: readonly OscArg[]) => void) | null;
  ip?: string;
  port?: number;
  allowFrom?: string | null;
  cfg?: Config;
}

export class MeterReceiver {
  onFader: ((ch: number, db: number) => void) | null;
  onMeters: ((values: number[]) => void) | null;
  onHeard: (() => void) | null = null;
  onParam: ((address: string, args: readonly OscArg[]) => void) | null = null;
  onMessage: ((address: string, args: readonly OscArg[]) => void) | null;
  ip: string;
  port: number;
  running = false;
  lastError: unknown = null;
  rejected = 0;
  private readonly allowFrom: string | null;
  private readonly udp: UdpFactory;
  private endpoint: UdpEndpoint | null = null;
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(udp: UdpFactory, opts: MeterReceiverOptions = {}) {
    this.udp = udp;
    this.onFader = opts.onFader ?? null;
    this.onMeters = opts.onMeters ?? null;
    this.onMessage = opts.onMessage ?? null;
    this.ip = opts.ip ?? "0.0.0.0";
    this.port = opts.port ?? (opts.cfg ?? C).LOCAL_PORT;
    const from = opts.allowFrom ?? null;
    this.allowFrom = from !== null && from.trim() !== "" ? hostKey(from) : null;
  }

  handleMeters(args: readonly OscArg[]): void {
    if (!this.running) return;
    const first = args[0];
    if (first && first.t === "b") {
      const vals = decodeMeterBlob(first.v);
      if (this.onMeters) this.onMeters(vals);
    }
  }

  handleFader(address: string, args: readonly OscArg[]): void {
    if (!this.running) return;
    const ch = chFromFaderAddr(address);
    if (ch === null || args.length === 0) return;
    const pos = argFloat(args[0]);
    if (pos === null) return;
    if (this.onFader) this.onFader(ch, faderToDb(pos));
  }

  dispatch(data: Uint8Array, from: Peer | null = null): void {
    if (from !== null && this.allowFrom !== null && hostKey(from.host) !== this.allowFrom) {
      this.rejected += 1;
      return;
    }
    if (this.onHeard !== null && this.running) {
      try {
        this.onHeard();
      } catch (e) {
        this.lastError = e;
      }
    }
    for (const m of decodePacket(data)) {
      try {
        if (this.onMessage !== null && this.running) this.onMessage(m.address, m.args);
        if (this.onParam !== null && this.running && !m.address.startsWith("/meters")) this.onParam(m.address, m.args);
        if (m.address.startsWith("/meters")) this.handleMeters(m.args);
        else if (chFromFaderAddr(m.address) !== null) this.handleFader(m.address, m.args);
      } catch (e) {
        this.lastError = e;
      }
    }
  }

  send(data: Uint8Array, to: Peer): boolean {
    const ep = this.endpoint;
    if (ep === null) return false;
    try {
      ep.send(data, to);
    } catch (e) {
      this.lastError = e;
      return false;
    }
    return true;
  }

  start(): Promise<void> {
    const gen = ++this.generation;
    const run = this.pending.then(() => this.bindFor(gen));
    this.pending = run.catch(() => undefined);
    return run;
  }

  private async bindFor(gen: number): Promise<void> {
    if (gen !== this.generation || this.endpoint !== null) return;
    const ep = await this.udp.bind(this.port, this.ip);
    if (gen !== this.generation) {
      ep.close();
      return;
    }
    this.endpoint = ep;
    this.port = ep.port;
    ep.onMessage((data, from) => this.dispatch(data, from));
    this.running = true;
  }

  stop(): void {
    this.generation++;
    this.running = false;
    const ep = this.endpoint;
    this.endpoint = null;
    if (ep !== null) {
      try {
        ep.close();
      } catch (e) {
        this.lastError = e;
      }
    }
  }
}

export class SharedPortSink implements DatagramSink {
  private readonly rx: MeterReceiver;
  private readonly target: Peer;
  private readonly fallback: DatagramSink;

  constructor(rx: MeterReceiver, target: Peer, fallback: DatagramSink) {
    this.rx = rx;
    this.target = target;
    this.fallback = fallback;
  }

  get failures(): number {
    return this.fallback.failures ?? 0;
  }

  send(data: Uint8Array): void {
    if (!this.rx.send(data, this.target)) this.fallback.send(data);
  }

  close(): void {
    this.fallback.close();
  }
}
