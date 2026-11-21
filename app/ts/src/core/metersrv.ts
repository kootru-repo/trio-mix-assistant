import { C } from "./config.ts";
import { faderToDb } from "./console.ts";
import { argFloat } from "./oscargs.ts";
import { decodeMeterBlob, decodePacket } from "./oscwire.ts";
import type { OscArg, OscMessage } from "./oscwire.ts";
import type { UdpEndpoint, UdpFactory } from "./transport.ts";

export { decodeMeterBlob, encodeMeterBlob } from "./oscwire.ts";

const INT_TEXT = /^\s*[+-]?\d+\s*$/;

export function chFromFaderAddr(addr: string): number | null {
  const parts = addr.split("/");
  if (parts.length >= 5 && parts[1] === "ch" && parts[3] === "mix" && parts[4] === "fader") {
    const p = parts[2]!;
    return INT_TEXT.test(p) ? Number.parseInt(p.trim(), 10) : null;
  }
  return null;
}

function patternRegex(address: string): RegExp | null {
  let pattern = "^";
  let i = 0;
  while (i < address.length) {
    const c = address[i]!;
    if (c === "*") {
      pattern += "[^/]*";
    } else if (c === "?") {
      pattern += "[^/]";
    } else if (c === "[") {
      pattern += "[";
      i++;
      if (i < address.length && address[i] === "!") {
        pattern += "^";
        i++;
      }
      while (i < address.length && address[i] !== "]") {
        if ("\\^$.|()+*?".includes(address[i]!)) pattern += "\\";
        pattern += address[i]!;
        i++;
      }
      pattern += "]";
    } else if (c === "{") {
      pattern += "(";
      i++;
      while (i < address.length && address[i] !== "}") {
        const ch = address[i]!;
        if (ch === ",") pattern += "|";
        else if ("\\^$.|()[]+*?".includes(ch)) pattern += "\\" + ch;
        else pattern += ch;
        i++;
      }
      pattern += ")";
    } else if ("\\^$.|()[]+?".includes(c)) {
      pattern += "\\" + c;
    } else {
      pattern += c;
    }
    i++;
  }
  pattern += "$";
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function routeMatches(key: string, address: string): boolean {
  const direct = patternRegex(address);
  if (direct === null) return false;
  if (direct.test(key)) return true;
  return key.includes("*") && new RegExp("^" + key.replaceAll("*", ".*?") + "$").test(address);
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
  private readonly udp: UdpFactory;
  private endpoint: UdpEndpoint | null = null;

  constructor(udp: UdpFactory, opts: MeterReceiverOptions = {}) {
    this.udp = udp;
    this.onFader = opts.onFader ?? null;
    this.onMeters = opts.onMeters ?? null;
    this.ip = opts.ip ?? "0.0.0.0";
    this.port = opts.port ?? C.LOCAL_PORT;
  }

  handleMeters(_address: string, args: readonly OscArg[]): void {
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
    let messages: OscMessage[];
    try {
      messages = decodePacket(data);
    } catch {
      return;
    }
    for (const m of messages) {
      try {
        if (routeMatches("/meters*", m.address)) this.handleMeters(m.address, m.args);
        if (routeMatches("/ch/*/mix/fader", m.address)) this.handleFader(m.address, m.args);
      } catch {
        continue;
      }
    }
  }

  async start(): Promise<void> {
    const ep = await this.udp.bind(this.port, this.ip);
    this.endpoint = ep;
    this.port = ep.port;
    ep.onMessage((data) => this.dispatch(data));
    this.running = true;
  }

  stop(): void {
    this.running = false;
    const ep = this.endpoint;
    this.endpoint = null;
    if (ep !== null) {
      try {
        ep.close();
      } catch {
        return;
      }
    }
  }
}
