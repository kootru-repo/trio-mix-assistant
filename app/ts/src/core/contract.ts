import type { Clock } from "./clock.ts";
import { decodePacket, encodeMessage, oscBlob, oscFloat, oscInt, oscStr } from "./oscwire.ts";
import type { OscArg } from "./oscwire.ts";
import type { DatagramHandler, Peer, UdpEndpoint, UdpFactory } from "./transport.ts";

export const CONTRACT_FORMAT = 1;
export const DOC_ADDRESS = "192.0.2.1";
const MAX_PER_STEP = 400;
const MAX_METER_PACKETS = 5;

export interface RawExchange {
  step: string;
  dir: "out" | "in";
  bytes: Uint8Array;
}

export class RecordingUdpFactory implements UdpFactory {
  private readonly inner: UdpFactory;
  readonly exchanges: RawExchange[] = [];
  private readonly perStep = new Map<string, { all: number; meters: number }>();
  step = "start";

  constructor(inner: UdpFactory) {
    this.inner = inner;
  }

  private keep(dir: "out" | "in", data: Uint8Array): void {
    const n = this.perStep.get(this.step) ?? { all: 0, meters: 0 };
    const meters = decodePacket(data).some((m) => m.address.startsWith("/meters"));
    if (n.all >= MAX_PER_STEP || (meters && n.meters >= MAX_METER_PACKETS)) return;
    n.all += 1;
    if (meters) n.meters += 1;
    this.perStep.set(this.step, n);
    this.exchanges.push({ step: this.step, dir, bytes: Uint8Array.from(data) });
  }

  async bind(port: number, host: string): Promise<UdpEndpoint> {
    const ep = await this.inner.bind(port, host);
    const keep = (dir: "out" | "in", data: Uint8Array): void => this.keep(dir, data);
    return {
      get port() {
        return ep.port;
      },
      send(data: Uint8Array, to: Peer): void {
        keep("out", data);
        ep.send(data, to);
      },
      onMessage(handler: DatagramHandler): void {
        ep.onMessage((data, from) => {
          keep("in", data);
          handler(data, from);
        });
      },
      close(): void {
        ep.close();
      },
    };
  }
}

export const PROBES: readonly [string, OscArg[]][] = [
  ["/info", []],
  ["/xinfo", []],
  ["/status", []],
  ["/node", [oscStr("ch/01/mix")]],
  ["/node", [oscStr("ch/01/config")]],
  ["/ch/01/mix/fader", []],
  ["/ch/01/mix/on", []],
  ["/ch/01/preamp/invert", []],
  ["/headamp/000/gain", []],
  ["/main/st/mix/fader", []],
  ["/-prefs/name", []],
  ["/meters", [oscStr("/meters/1")]],
];

export async function runProbes(udp: UdpFactory, to: Peer, clock: Clock, waitS: number = 0.3, meterWindowS: number = 1): Promise<void> {
  const ep = await udp.bind(0, "0.0.0.0");
  ep.onMessage(() => undefined);
  try {
    for (const [address, args] of PROBES) {
      ep.send(encodeMessage(address, args), to);
      await clock.sleep(address === "/meters" ? meterWindowS : waitS);
    }
  } finally {
    ep.close();
  }
}

export type FixtureArg = { t: "i" | "f"; v: number } | { t: "s"; v: string } | { t: "b"; v: string };

export interface FixtureMessage {
  dir: "out" | "in";
  address: string;
  args: FixtureArg[];
}

export interface KnownDifference {
  id: string;
  text: string;
  address: string;
}

export interface ContractFixture {
  format: number;
  model: string;
  firmware: string;
  source: "console" | "emulator";
  known_differences: KnownDifference[];
  steps: { step: string; messages: FixtureMessage[] }[];
}

const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const NAME_AT: Readonly<Record<string, number>> = { "/info": 1, "/xinfo": 1, "/status": 2, "/-prefs/name": 0 };

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g) ?? [], (h) => Number.parseInt(h, 16));

function scrubArg(address: string, i: number, a: OscArg): FixtureArg {
  if (a.t === "b") return { t: "b", v: address.startsWith("/meters") ? hex(a.v.slice(0, 4)) : hex(a.v) };
  if (a.t !== "s") return { t: a.t, v: a.v };
  if (NAME_AT[address] === i || /\/config\/name$/.test(address)) return { t: "s", v: "" };
  let v = a.v.replace(IPV4, DOC_ADDRESS);
  if (address === "node" || address === "/node") v = v.replace(/"[^"\n]*"/g, '""');
  return { t: "s", v };
}

export function modelOf(exchanges: readonly RawExchange[]): { model: string; firmware: string } {
  for (const x of exchanges) {
    if (x.dir !== "in") continue;
    for (const m of decodePacket(x.bytes)) {
      if (m.address === "/info" && m.args.length >= 4) return { model: String(m.args[2]!.v), firmware: String(m.args[3]!.v) };
    }
  }
  return { model: "unknown", firmware: "unknown" };
}

export function buildFixture(
  exchanges: readonly RawExchange[],
  source: "console" | "emulator",
  known: KnownDifference[] = [],
): ContractFixture {
  const steps: { step: string; messages: FixtureMessage[] }[] = [];
  for (const x of exchanges) {
    let s = steps.at(-1);
    if (s === undefined || s.step !== x.step) {
      s = { step: x.step, messages: [] };
      steps.push(s);
    }
    for (const m of decodePacket(x.bytes))
      s.messages.push({ dir: x.dir, address: m.address, args: m.args.map((a, i) => scrubArg(m.address, i, a)) });
  }
  return { format: CONTRACT_FORMAT, ...modelOf(exchanges), source, known_differences: known, steps };
}

export function toOscArgs(args: readonly FixtureArg[]): OscArg[] {
  return args.map((a) => (a.t === "b" ? oscBlob(unhex(a.v)) : a.t === "s" ? oscStr(a.v) : a.t === "i" ? oscInt(a.v) : oscFloat(a.v)));
}

const shapeOf = (m: FixtureMessage): string => `${m.dir} ${m.address} ${m.args.map((a) => a.t).join("")}`;

export function compareShapes(expected: ContractFixture, actual: ContractFixture, step: string): string[] {
  const want = expected.steps.find((s) => s.step === step)?.messages.map(shapeOf) ?? [];
  const got = actual.steps.find((s) => s.step === step)?.messages.map(shapeOf) ?? [];
  const known = new Set(expected.known_differences.map((k) => k.address));
  const differ: string[] = [];
  const count = (xs: string[]): Map<string, number> => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const w = count(want);
  const g = count(got);
  for (const shape of new Set([...w.keys(), ...g.keys()])) {
    const address = shape.split(" ")[1]!;
    if (known.has(address) || address.startsWith("/meters")) continue;
    const a = w.get(shape) ?? 0;
    const b = g.get(shape) ?? 0;
    if (a !== b) differ.push(`${shape}: recorded ${a}, emulator ${b}`);
  }
  return differ.sort();
}

export function parseFixture(text: string): ContractFixture {
  const d: unknown = JSON.parse(text);
  if (typeof d !== "object" || d === null || (d as { format?: unknown }).format !== CONTRACT_FORMAT)
    throw new Error("not a contract fixture of this format");
  return d as ContractFixture;
}
