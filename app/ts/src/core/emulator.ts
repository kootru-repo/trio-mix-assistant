import type { Clock } from "./clock.ts";
import { C } from "./config.ts";
import { dbToFader, faderToDb } from "./console.ts";
import { argFloat, argInt, argText } from "./oscargs.ts";
import { encodeMeterBlob, encodeMessage, decodePacket, oscBlob, oscFloat, oscInt, oscStr } from "./oscwire.ts";
import type { OscArg } from "./oscwire.ts";
import { fixed, signed } from "./numfmt.ts";
import type { Peer, UdpEndpoint, UdpFactory } from "./transport.ts";

export type AppSender = (addr: string, args: OscArg[]) => void;

export interface EmulatedDeskOptions {
  listenPort?: number;
  listenHost?: string;
  appIp?: string;
  appPort?: number;
  meterHz?: number;
  nMeters?: number;
  externalMoves?: boolean;
  localIp?: string;
  nodeScn?: string | null;
  onTrace?: ((line: string) => void) | null;
}

interface MeterSub {
  client: Peer;
  alias: string;
  path: string;
  count: number;
  last: number;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const peerKey = (p: Peer): string => `${p.host}:${p.port}`;

function chFromAddr(addr: string): number | null {
  const parts = addr.split("/");
  if (parts.length >= 5 && parts[1] === "ch" && parts[3] === "mix") {
    const p = parts[2]!;
    return /^\s*[+-]?\d+\s*$/.test(p) ? Number.parseInt(p.trim(), 10) : null;
  }
  return null;
}

const METER_COUNTS = new Map<number, number>([
  [0, 70],
  [1, 96],
  [2, 49],
  [3, 22],
  [4, 82],
  [5, 27],
  [6, 4],
  [7, 16],
  [8, 6],
  [9, 32],
  [10, 32],
  [11, 5],
  [12, 4],
  [13, 48],
  [14, 80],
  [15, 50],
  [16, 48],
]);

const FLOAT_LEAVES = new Set([
  "fader",
  "level",
  "gain",
  "trim",
  "pan",
  "f",
  "g",
  "q",
  "mix",
  "threshold",
  "ratio",
  "attack",
  "release",
  "hold",
  "depth",
  "time",
  "hpf",
  "lpf",
]);

const SCOLOR = [
  "OFF",
  "RD",
  "GN",
  "YE",
  "BL",
  "MG",
  "CY",
  "WH",
  "OFFi",
  "RDi",
  "GNi",
  "YEi",
  "BLi",
  "MGi",
  "CYi",
  "WHi",
];

const mixSend = (m: RegExpMatchArray): string =>
  Number.parseInt(m[1]!, 10) % 2 ? "ON -oo +0 POST 0" : "ON -oo";

const NODE_RULES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^\/(?:ch|auxin|fxrtn)\/\d{2}\/mix\/(\d{2})$/, mixSend],
  [/^\/bus\/\d{2}\/mix\/(\d{2})$/, mixSend],
  [/^\/-libs\/(?:ch|fx|r|mon)\/\d{3}$/, () => '0 "" 0 %0000000000000000 0'],
  [/^\/-show\/showfile\/cue\/\d{3}$/, () => '0 "" 0 0 0 0 0 0 0'],
  [/^\/-show\/showfile\/scene\/\d{3}$/, () => '"" "" %000000000 0'],
  [/^\/-show\/showfile\/snippet\/\d{3}$/, () => '"" 0 0 0 0 0'],
  [/^\/outputs\/main\/\d{2}\/delay$/, () => "OFF 0.3"],
  [/^\/outputs\/(?:main|aes)\/\d{2}$/, () => "0 POST OFF"],
  [/^\/outputs\/rec\/\d{2}$/, () => "0 POST"],
  [/^\/outputs\/p16\/\d{2}$/, () => "0 POST OFF 0"],
];

function fmtParam(v: OscArg): string {
  if (v.t === "f") return fixed(v.v, 4);
  if (v.t === "s") return v.v.includes(" ") || v.v === "" ? `"${v.v}"` : v.v;
  return argText(v);
}

function defaultFor(addr: string): OscArg[] {
  const leaf = addr.slice(addr.lastIndexOf("/") + 1);
  if (leaf === "name" || leaf === "source") return [oscStr("")];
  if (FLOAT_LEAVES.has(leaf)) return [oscFloat(0.0)];
  return [oscInt(0)];
}

export class EmulatedDesk {
  listenPort: number;
  readonly listenHost: string;
  readonly appHost: string;
  readonly appPort: number;
  meterHz: number;
  nMeters: number;
  externalMoves: boolean;
  fader = new Map<number, number>();
  mute = new Map<number, boolean>();
  scene: number | null = null;
  subscribed = false;
  recvCount = 0;
  echoCount = 0;
  metersSent = 0;
  params = new Map<string, OscArg[]>();
  remotes = new Map<string, Peer>();
  sceneNames = new Map<number, string>();
  meterSubs = new Map<string, MeterSub>();
  reqSeen = new Set<string>();
  reqLog: string[] = [];
  onTrace: ((line: string) => void) | null;
  localIp: string;
  nodeScn: string | null;
  private table: Map<string, string> | null = null;
  private readonly udp: UdpFactory;
  private readonly clock: Clock;
  private endpoint: UdpEndpoint | null = null;
  private appSender: AppSender | null = null;
  private stopped = false;
  private meterTask: Promise<void> | null = null;
  private extTask: Promise<void> | null = null;
  private tick = 0;

  constructor(udp: UdpFactory, clock: Clock, opts: EmulatedDeskOptions = {}) {
    this.udp = udp;
    this.clock = clock;
    this.listenPort = opts.listenPort ?? C.CONSOLE_PORT;
    this.listenHost = opts.listenHost ?? "0.0.0.0";
    this.appHost = opts.appIp ?? "127.0.0.1";
    this.appPort = opts.appPort ?? C.LOCAL_PORT;
    this.meterHz = opts.meterHz ?? 10.0;
    this.nMeters = opts.nMeters ?? 16;
    this.externalMoves = opts.externalMoves ?? false;
    this.localIp = opts.localIp ?? "127.0.0.1";
    this.nodeScn = opts.nodeScn ?? null;
    this.onTrace = opts.onTrace ?? null;
    this.seedParams();
  }

  get meterTaskStarted(): boolean {
    return this.meterTask !== null;
  }

  setNodeScn(text: string | null): void {
    this.nodeScn = text;
    this.table = null;
  }

  setAppSender(sender: AppSender | null): void {
    this.appSender = sender;
  }

  private sendApp(addr: string, args: OscArg[]): void {
    if (this.appSender !== null) this.appSender(addr, args);
  }

  handleFader(addr: string, args: readonly OscArg[]): void {
    const ch = chFromAddr(addr);
    this.recvCount++;
    if (ch !== null && args.length > 0) {
      const pos = argFloat(args[0]);
      if (pos === null) return;
      this.fader.set(ch, pos);
      if (this.subscribed && this.appSender !== null) {
        this.echoCount++;
        this.sendApp(`/ch/${pad2(ch)}/mix/fader`, [oscFloat(pos)]);
      }
    }
  }

  handleMute(addr: string, args: readonly OscArg[]): void {
    const ch = chFromAddr(addr);
    this.recvCount++;
    if (ch !== null && args.length > 0) {
      const v = argFloat(args[0]);
      if (v === null) return;
      this.mute.set(ch, v === 0);
    }
  }

  handleScene(_addr: string, args: readonly OscArg[]): void {
    this.recvCount++;
    if (args.length > 0) {
      const n = argInt(args[0]);
      if (n !== null) this.scene = n;
    }
  }

  private addMeterSub(client: Peer, addr: string, args: readonly OscArg[]): void {
    let alias: string;
    let path: string;
    if (addr === "/meters" && args.length > 0) {
      alias = path = argText(args[0]!);
    } else if ((addr === "/batchsubscribe" || addr === "/formatsubscribe") && args.length >= 2) {
      alias = argText(args[0]!);
      path = argText(args[1]!);
    } else {
      return;
    }
    const m = /^meters\/(\d+)$/.exec(path.replace(/^\/+/, ""));
    if (!m) return;
    const count = METER_COUNTS.get(Number.parseInt(m[1]!, 10)) ?? 96;
    if (!alias.startsWith("/")) alias = "/" + alias;
    this.meterSubs.set(`${peerKey(client)}|${alias}`, {
      client,
      alias,
      path,
      count,
      last: this.clock.monotonic(),
    });
    this.startMeters();
  }

  handleSubscribe(_addr: string, _args: readonly OscArg[] = []): void {
    this.recvCount++;
    this.subscribed = true;
    this.startMeters();
  }

  handleXremote(_addr: string, _args: readonly OscArg[] = []): void {
    this.recvCount++;
    this.subscribed = true;
  }

  handleDefault(_addr: string, _args: readonly OscArg[] = []): void {
    this.recvCount++;
  }

  private seedParams(): void {
    for (let ch = 1; ch <= 32; ch++) {
      const role = C.CHANNELS.get(ch);
      const name = role ? Array.from(C.ROLE_LABELS.get(role) ?? role).slice(0, 12).join("") : "";
      const p = `/ch/${pad2(ch)}`;
      this.params.set(`${p}/config/name`, [oscStr(name)]);
      this.params.set(`${p}/config/color`, [oscInt((ch % 8) + 1)]);
      this.params.set(`${p}/config/icon`, [oscInt(1)]);
      this.params.set(`${p}/mix/fader`, [oscFloat(dbToFader(0.0))]);
      this.params.set(`${p}/mix/on`, [oscInt(1)]);
    }
    this.params.set("/main/st/mix/fader", [oscFloat(dbToFader(0.0))]);
    this.params.set("/main/st/mix/on", [oscInt(1)]);
    this.params.set("/main/st/config/name", [oscStr("Main LR")]);
    this.params.set("/-prefs/name", [oscStr(C.X32_NAME)]);
  }

  private reply(client: Peer, addr: string, args: readonly OscArg[]): void {
    const ep = this.endpoint;
    if (ep === null) return;
    try {
      ep.send(encodeMessage(addr, args), client);
    } catch {
      return;
    }
  }

  private push(addr: string, args: readonly OscArg[], exclude: Peer | null = null): void {
    const skip = exclude === null ? null : peerKey(exclude);
    for (const [key, r] of [...this.remotes]) {
      if (key === skip) continue;
      this.reply(r, addr, args);
    }
  }

  private logReq(addr: string, args: readonly OscArg[]): void {
    const key = addr === "/node" && args.length > 0 ? `${addr} ${argText(args[0]!)}` : addr;
    if (!this.reqSeen.has(key)) {
      this.reqSeen.add(key);
      if (this.reqLog.length < 1000) this.reqLog.push(key);
      if (this.onTrace !== null) this.onTrace(`  [emu] editor asked: ${key}`);
    }
  }

  private nodeTable(): Map<string, string> {
    if (this.table === null) {
      const t = new Map<string, string>();
      if (this.nodeScn !== null) {
        for (const raw of this.nodeScn.split(/\r\n|\n|\r/)) {
          const ln = raw.trimEnd();
          if (ln.startsWith("/")) t.set(ln.split(" ", 1)[0]!, ln);
        }
      }
      this.table = t;
    }
    return this.table;
  }

  private replyNode(client: Peer, args: readonly OscArg[]): void {
    const first = args[0];
    const path = (first ? argText(first) : "").replace(/^\/+|\/+$/g, "");
    const full = "/" + path;
    this.reply(client, "node", [oscStr(this.nodeBody(full) + "\n")]);
  }

  private param(addr: string, fallback: OscArg): OscArg {
    return this.params.get(addr)?.[0] ?? fallback;
  }

  nodeBody(full: string): string {
    if (full === "/-show/showfile/show") {
      return `${full} "${C.X32_NAME}" 0 0 0 0 0 0 0 0 0 0 "${C.X32_FW}"`;
    }
    let m = /^\/-show\/showfile\/scene\/(\d{3})$/.exec(full);
    if (m) {
      const name = this.sceneNames.get(Number.parseInt(m[1]!, 10));
      if (name !== undefined) return `${full} "${name}" "" %111111111 1`;
    }
    m = /^\/ch\/(\d{2})\/config$/.exec(full);
    if (m) {
      const nameArg = this.param(full + "/name", oscStr(""));
      const color = (argInt(this.param(full + "/color", oscInt(1))) ?? 1) & 15;
      return `${full} "${argText(nameArg)}" 1 ${SCOLOR[color]} ${Number.parseInt(m[1]!, 10)}`;
    }
    m = /^\/ch\/(\d{2})\/mix$/.exec(full);
    if (m) {
      const ch = Number.parseInt(m[1]!, 10);
      const pos = this.fader.get(ch) ?? argFloat(this.param(`${full}/fader`, oscFloat(0.75))) ?? 0.75;
      const lvl = pos <= 0 ? "-oo" : signed(faderToDb(pos), 1);
      const on = this.mute.get(ch) ? "OFF" : "ON";
      return `${full} ${on} ${lvl} ON +0 OFF -oo`;
    }
    const table = this.nodeTable();
    const hit = table.get(full);
    if (hit !== undefined) return hit;
    for (const [rx, bodyFor] of NODE_RULES) {
      const rm = rx.exec(full);
      if (rm) return `${full} ${bodyFor(rm)}`;
    }
    const own = this.params.get(full);
    if (own !== undefined) return `${full} ` + own.map(fmtParam).join(" ");
    const kids = [...this.params.keys()].filter((a) => a.startsWith(full + "/"));
    if (kids.length > 0) {
      const parts: string[] = [];
      for (const k of kids.sort(codePointCompare)) {
        const v = this.params.get(k)!;
        if (v.length > 0) parts.push(fmtParam(v[0]!));
      }
      return `${full} ` + parts.join(" ");
    }
    return full;
  }

  handleAny(client: Peer, addr: string, args: readonly OscArg[]): void {
    this.logReq(addr, args);
    const isApp = client.host === this.appHost && client.port === this.appPort;

    if (addr === "/info") {
      this.reply(client, "/info", [
        oscStr(C.X32_SERVER_VER),
        oscStr(C.X32_NAME),
        oscStr(C.X32_MODEL),
        oscStr(C.X32_FW),
      ]);
      return;
    }
    if (addr === "/xinfo") {
      this.reply(client, "/xinfo", [
        oscStr(this.localIp),
        oscStr(C.X32_NAME),
        oscStr(C.X32_MODEL),
        oscStr(C.X32_FW),
      ]);
      return;
    }
    if (addr === "/status") {
      this.reply(client, "/status", [oscStr("active"), oscStr(this.localIp), oscStr(C.X32_NAME)]);
      return;
    }
    if (addr === "/node") {
      this.replyNode(client, args);
      return;
    }
    if (addr === "/xremote" || addr === "/formatsubscribe" || addr === "/batchsubscribe" || addr === "/meters") {
      if (!isApp) {
        this.remotes.set(peerKey(client), client);
        this.addMeterSub(client, addr, args);
      }
      if (addr === "/batchsubscribe") this.handleSubscribe(addr, args);
      else if (addr !== "/meters") this.handleXremote(addr, args);
      return;
    }
    if (addr === "/unsubscribe" || addr === "/renew") {
      this.recvCount++;
      const now = this.clock.monotonic();
      const who = peerKey(client);
      for (const [key, sub] of [...this.meterSubs]) {
        if (peerKey(sub.client) === who) {
          if (addr === "/renew") sub.last = now;
          else this.meterSubs.delete(key);
        }
      }
      return;
    }
    if (addr === "/showdump") {
      this.reply(client, "node", [
        oscStr(`/-show/showfile/show "${C.X32_NAME}" 0 0 0 0 0 0 0 0 0 0 "${C.X32_FW}"\n`),
      ]);
      return;
    }

    const ch = chFromAddr(addr);
    if (ch !== null && addr.endsWith("/mix/fader")) {
      if (args.length > 0) {
        this.handleFader(addr, args);
        const pos = argFloat(args[0]);
        if (pos === null) return;
        this.params.set(addr, [oscFloat(pos)]);
        this.push(addr, [oscFloat(pos)], client);
        if (!isApp) this.sendApp(addr, [oscFloat(pos)]);
      } else {
        const cur = this.fader.get(ch) ?? argFloat(this.param(addr, oscFloat(0.0))) ?? 0.0;
        this.reply(client, addr, [oscFloat(cur)]);
      }
      return;
    }
    if (ch !== null && addr.endsWith("/mix/on")) {
      if (args.length > 0) {
        this.handleMute(addr, args);
        const v = argFloat(args[0]);
        if (v === null) return;
        this.params.set(addr, [oscInt(Math.trunc(v))]);
        this.push(addr, [oscInt(Math.trunc(v))], client);
      } else {
        this.reply(client, addr, [oscInt(this.mute.get(ch) ? 0 : 1)]);
      }
      return;
    }
    if (addr === "/-action/goscene") {
      if (args.length > 0) this.handleScene(addr, args);
      return;
    }

    if (args.length === 0) {
      let val = this.params.get(addr);
      if (val === undefined) {
        val = defaultFor(addr);
        this.params.set(addr, val);
      }
      this.reply(client, addr, val);
      this.recvCount++;
      return;
    }
    this.params.set(addr, [...args]);
    this.push(addr, args, client);
    this.handleDefault(addr, args);
  }

  moveFaderExternally(ch: number, db: number): void {
    const pos = dbToFader(db);
    this.fader.set(ch, pos);
    const addr = `/ch/${pad2(ch)}/mix/fader`;
    this.params.set(addr, [oscFloat(pos)]);
    this.sendApp(addr, [oscFloat(pos)]);
    this.push(addr, [oscFloat(pos)]);
  }

  private startMeters(): void {
    if (this.meterTask === null) this.meterTask = this.meterLoop();
  }

  private async waitOrStop(seconds: number): Promise<boolean> {
    let remaining = seconds;
    while (remaining > 1e-9) {
      if (this.stopped) return true;
      const slice = Math.min(remaining, 0.25);
      await this.clock.sleep(slice);
      remaining -= slice;
    }
    return this.stopped;
  }

  private async meterLoop(): Promise<void> {
    const period = 1.0 / this.meterHz;
    while (!(await this.waitOrStop(period))) {
      try {
        this.meterStep();
      } catch {
        continue;
      }
    }
  }

  meterStep(): void {
    if (!(this.subscribed || this.meterSubs.size > 0) || this.appSender === null) return;
    this.tick++;
    const bank = (n: number): number[] => {
      const out: number[] = [];
      for (let k = 0; k < n; k++) out.push(0.3 + 0.2 * Math.sin(this.tick * 0.2 + k));
      return out;
    };
    if (this.subscribed) {
      try {
        this.sendApp("/meters/1", [oscBlob(encodeMeterBlob(bank(this.nMeters)))]);
        this.metersSent++;
      } catch {
        this.metersSent += 0;
      }
    }
    const now = this.clock.monotonic();
    for (const [key, sub] of [...this.meterSubs]) {
      if (now - sub.last > 10.0) {
        this.meterSubs.delete(key);
        continue;
      }
      this.reply(sub.client, sub.alias, [oscBlob(encodeMeterBlob(bank(sub.count)))]);
    }
  }

  static extPick(k: number): number | null {
    const chans = [...C.CHANNELS.keys()].filter((c) => c !== C.MEAS_MIC_CH);
    return chans.length > 0 ? (chans[k % chans.length] ?? null) : null;
  }

  private async extLoop(): Promise<void> {
    let k = 0;
    while (!(await this.waitOrStop(12.0))) {
      if (!this.subscribed) continue;
      const ch = EmulatedDesk.extPick(k);
      if (ch === null) continue;
      k++;
      this.moveFaderExternally(ch, -8.0 + 4.0 * ((k % 3) - 1));
    }
  }

  async start(): Promise<this> {
    const ep = await this.udp.bind(this.listenPort, this.listenHost);
    this.endpoint = ep;
    this.listenPort = ep.port;
    const appPeer: Peer = { host: this.appHost, port: this.appPort };
    this.appSender = (addr, args) => ep.send(encodeMessage(addr, args), appPeer);
    ep.onMessage((data, from) => {
      try {
        for (const m of decodePacket(data)) this.handleAny(from, m.address, m.args);
      } catch {
        return;
      }
    });
    if (this.externalMoves) this.extTask = this.extLoop();
    return this;
  }

  stop(): void {
    this.stopped = true;
    const ep = this.endpoint;
    this.endpoint = null;
    if (ep !== null) {
      try {
        ep.close();
      } catch {
        this.appSender = null;
      }
    }
    this.appSender = null;
  }

  get extLoopStarted(): boolean {
    return this.extTask !== null;
  }
}

function codePointCompare(a: string, b: string): number {
  const ia = Array.from(a);
  const ib = Array.from(b);
  const n = Math.min(ia.length, ib.length);
  for (let i = 0; i < n; i++) {
    const d = ia[i]!.codePointAt(0)! - ib[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return ia.length - ib.length;
}
