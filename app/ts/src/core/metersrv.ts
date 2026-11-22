import { C } from "./config.ts";
import { faderToDb } from "./console.ts";
import { argFloat } from "./oscargs.ts";
import { parseInteger } from "./util.ts";
import { decodeMeterBlob, decodePacket } from "./oscwire.ts";
import type { OscArg } from "./oscwire.ts";
import type { UdpEndpoint, UdpFactory } from "./transport.ts";

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
  ip?: string;
  port?: number;
}

export class MeterReceiver {
  onFader: ((ch: number, db: number) => void) | null;
  onMeters: ((values: number[]) => void) | null;
  ip: string;
  port: number;
  running = false;
  lastError: unknown = null;
  private readonly udp: UdpFactory;
  private endpoint: UdpEndpoint | null = null;
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(udp: UdpFactory, opts: MeterReceiverOptions = {}) {
    this.udp = udp;
    this.onFader = opts.onFader ?? null;
    this.onMeters = opts.onMeters ?? null;
    this.ip = opts.ip ?? "0.0.0.0";
    this.port = opts.port ?? C.LOCAL_PORT;
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

  dispatch(data: Uint8Array): void {
    for (const m of decodePacket(data)) {
      try {
        if (m.address.startsWith("/meters")) this.handleMeters(m.args);
        else if (chFromFaderAddr(m.address) !== null) this.handleFader(m.address, m.args);
      } catch (e) {
        this.lastError = e;
      }
    }
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
    ep.onMessage((data) => this.dispatch(data));
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
