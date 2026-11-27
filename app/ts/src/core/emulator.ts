import type { Clock } from "./clock.ts";
import type { Config } from "./config.ts";
import { dbToFader, faderToDb } from "./console.ts";
import { argFloat, argInt, argText } from "./oscargs.ts";
import { parseInteger, zeroPad } from "./util.ts";
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
  cfg: Config;
}

interface MeterSub {
  client: Peer;
  alias: string;
  path: string;
  count: number;
  last: number;
}

const peerKey = (p: Peer): string => `${p.host}:${p.port}`;

const MAX_ENTRIES = 4096;
const MAX_METER_SUBS = 64;
const MAX_ADDR_LEN = 256;
const MAX_REMOTES = 16;
const SUBSCRIPTION_TTL_S = 10.0;
const MIN_METER_HZ = 0.1;
const MAX_METER_HZ = 1000;

function chFromAddr(addr: string): number | null {
  const parts = addr.split("/");
  if (parts.length === 5 && parts[1] === "ch" && parts[3] === "mix") {
    const ch = parseInteger(parts[2]!);
    return ch !== null && ch >= 1 && ch <= 32 ? ch : null;
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

const SCOLOR = ["OFF", "RD", "GN", "YE", "BL", "MG", "CY", "WH", "OFFi", "RDi", "GNi", "YEi", "BLi", "MGi", "CYi", "WHi"];

const mixSend = (m: RegExpMatchArray): string => (Number.parseInt(m[1]!, 10) % 2 ? "ON -oo +0 POST 0" : "ON -oo");

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
  recvCount = 0;
  echoCount = 0;
  metersSent = 0;
  params = new Map<string, OscArg[]>();
  remotes = new Map<string, Peer>();
  sceneNames = new Map<number, string>();
  meterSubs = new Map<string, MeterSub>();
  reqSeen = new Set<string>();
  reqLog: string[] = [];
  lastError: unknown = null;
  onTrace: ((line: string) => void) | null;
  localIp: string;
  nodeScn: string | null;
  private table: Map<string, string> | null = null;
  private readonly udp: UdpFactory;
  private readonly clock: Clock;
  private readonly cfg: Config;
  private endpoint: UdpEndpoint | null = null;
  private appSender: AppSender | null = null;
  private stopped = false;
  private subscribedFlag = false;
  private subscribedAt: number | null = null;
  private readonly remoteSeen = new Map<string, number>();
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private meterTask: Promise<void> | null = null;
  private tick = 0;

  constructor(udp: UdpFactory, clock: Clock, opts: EmulatedDeskOptions) {
    this.udp = udp;
    this.clock = clock;
    this.cfg = opts.cfg;
    this.listenPort = opts.listenPort ?? this.cfg.CONSOLE_PORT;
    this.listenHost = opts.listenHost ?? "0.0.0.0";
    this.appHost = opts.appIp ?? "127.0.0.1";
    this.appPort = opts.appPort ?? this.cfg.LOCAL_PORT;
    const hz = opts.meterHz ?? 10.0;
    this.meterHz = Number.isFinite(hz) ? Math.min(MAX_METER_HZ, Math.max(MIN_METER_HZ, hz)) : 10.0;
    this.nMeters = opts.nMeters ?? 16;
    this.externalMoves = opts.externalMoves ?? false;
    this.localIp = opts.localIp ?? "127.0.0.1";
    this.nodeScn = opts.nodeScn ?? null;
    this.onTrace = opts.onTrace ?? null;
    this.seedParams();
  }

  get subscribed(): boolean {
    this.expire(this.clock.monotonic());
    return this.subscribedFlag;
  }

  set subscribed(v: boolean) {
    this.subscribedFlag = v;
    this.subscribedAt = null;
  }

  private expire(now: number): void {
    if (this.subscribedFlag && this.subscribedAt !== null && now - this.subscribedAt > SUBSCRIPTION_TTL_S) {
      this.subscribedFlag = false;
      this.subscribedAt = null;
    }
    for (const [key, seen] of [...this.remoteSeen]) {
      if (now - seen > SUBSCRIPTION_TTL_S) {
        this.remoteSeen.delete(key);
        this.remotes.delete(key);
      }
    }
  }

  private addRemote(client: Peer, now: number): void {
    const key = peerKey(client);
    if (!this.remotes.has(key) && this.remotes.size >= MAX_REMOTES) return;
    this.remotes.set(key, client);
    this.remoteSeen.set(key, now);
  }

  private setParam(addr: string, args: readonly OscArg[]): boolean {
    if (addr.length > MAX_ADDR_LEN) return false;
    if (!this.params.has(addr) && this.params.size >= MAX_ENTRIES) return false;
    this.params.set(addr, [...args]);
    return true;
  }

  private markSubscribed(): void {
    this.subscribedFlag = true;
    this.subscribedAt = this.clock.monotonic();
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
    if (this.appSender === null) return;
    try {
      this.appSender(addr, args);
    } catch (e) {
      this.lastError = e;
    }
  }

  handleFader(addr: string, args: readonly OscArg[]): void {
    const ch = chFromAddr(addr);
    this.recvCount++;
    if (ch !== null && args.length > 0) {
      const pos = argFloat(args[0]);
      if (pos === null || !Number.isFinite(pos)) return;
      this.fader.set(ch, pos);
      if (this.subscribed && this.appSender !== null) {
        this.echoCount++;
        this.sendApp(`/ch/${zeroPad(ch, 2)}/mix/fader`, [oscFloat(pos)]);
      }
    }
  }

  handleMute(addr: string, args: readonly OscArg[]): void {
    const ch = chFromAddr(addr);
    this.recvCount++;
    if (ch !== null && args.length > 0) {
      const v = argFloat(args[0]);
      if (v === null || !Number.isFinite(v)) return;
      this.mute.set(ch, v === 0);
    }
  }

  handleScene(args: readonly OscArg[]): void {
    this.recvCount++;
    if (args.length > 0) {
      const n = argInt(args[0]);
      if (n !== null) {
        this.scene = n;
        this.setParam("/-show/prepos/current", [oscInt(n)]);
      }
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
    if (alias.length > MAX_ADDR_LEN) return;
    const subKey = `${peerKey(client)}|${alias}`;
    if (!this.meterSubs.has(subKey) && this.meterSubs.size >= MAX_METER_SUBS) return;
    this.meterSubs.set(subKey, {
      client,
      alias,
      path,
      count,
      last: this.clock.monotonic(),
    });
    this.startMeters();
  }

  handleSubscribe(): void {
    this.recvCount++;
    this.markSubscribed();
    this.startMeters();
  }

  handleXremote(): void {
    this.recvCount++;
    this.markSubscribed();
  }

  handleDefault(): void {
    this.recvCount++;
  }

  private seedParams(): void {
    for (let ch = 1; ch <= 32; ch++) {
      const role = this.cfg.CHANNELS.get(ch);
      const name = role
        ? Array.from(this.cfg.ROLE_LABELS.get(role) ?? role)
            .slice(0, 12)
            .join("")
        : "";
      const p = `/ch/${zeroPad(ch, 2)}`;
      this.params.set(`${p}/config/name`, [oscStr(name)]);
      this.params.set(`${p}/config/color`, [oscInt((ch % 8) + 1)]);
      this.params.set(`${p}/config/icon`, [oscInt(1)]);
      this.params.set(`${p}/mix/fader`, [oscFloat(dbToFader(0.0))]);
      this.params.set(`${p}/mix/on`, [oscInt(1)]);
      this.params.set(`${p}/preamp/invert`, [oscInt(0)]);
      this.params.set(`/headamp/${zeroPad(ch - 1, 3)}/gain`, [oscFloat(Math.fround((20 + 12) / 72))]);
    }
    this.params.set("/main/st/mix/fader", [oscFloat(dbToFader(0.0))]);
    this.params.set("/main/st/mix/on", [oscInt(1)]);
    this.params.set("/main/st/config/name", [oscStr("Main LR")]);
    this.params.set("/-prefs/name", [oscStr(this.cfg.X32_NAME)]);
  }

  private reply(client: Peer, addr: string, args: readonly OscArg[]): void {
    const ep = this.endpoint;
    if (ep === null) return;
    try {
      ep.send(encodeMessage(addr, args), client);
    } catch (e) {
      this.lastError = e;
    }
  }

  private push(addr: string, args: readonly OscArg[], exclude: Peer | null = null): void {
    this.expire(this.clock.monotonic());
    const skip = exclude === null ? null : peerKey(exclude);
    for (const [key, r] of [...this.remotes]) {
      if (key === skip) continue;
      this.reply(r, addr, args);
    }
  }

  private logReq(addr: string, args: readonly OscArg[]): void {
    const key = addr === "/node" && args.length > 0 ? `${addr} ${argText(args[0]!)}` : addr;
    if (key.length > MAX_ADDR_LEN) return;
    if (!this.reqSeen.has(key) && this.reqSeen.size < MAX_ENTRIES) {
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
    const text = first ? argText(first) : "";
    let from = 0;
    let to = text.length;
    while (from < to && text[from] === "/") from++;
    while (to > from && text[to - 1] === "/") to--;
    const full = "/" + text.slice(from, to);
    this.reply(client, "node", [oscStr(this.nodeBody(full) + "\n")]);
  }

  private param(addr: string, fallback: OscArg): OscArg {
    return this.params.get(addr)?.[0] ?? fallback;
  }

  nodeBody(full: string): string {
    if (full === "/-show/showfile/show") {
      return `${full} "${this.cfg.X32_NAME}" 0 0 0 0 0 0 0 0 0 0 "${this.cfg.X32_FW}"`;
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
      for (const k of kids.sort(compareKeys)) {
        const v = this.params.get(k)!;
        if (v.length > 0) parts.push(fmtParam(v[0]!));
      }
      return `${full} ` + parts.join(" ");
    }
    return full;
  }

  handleAny(client: Peer, addr: string, args: readonly OscArg[]): void {
    this.expire(this.clock.monotonic());
    this.logReq(addr, args);
    const isApp = client.host === this.appHost && client.port === this.appPort;

    if (addr === "/info") {
      this.reply(client, "/info", [
        oscStr(this.cfg.X32_SERVER_VER),
        oscStr(this.cfg.X32_NAME),
        oscStr(this.cfg.X32_MODEL),
        oscStr(this.cfg.X32_FW),
      ]);
      return;
    }
    if (addr === "/xinfo") {
      this.reply(client, "/xinfo", [oscStr(this.localIp), oscStr(this.cfg.X32_NAME), oscStr(this.cfg.X32_MODEL), oscStr(this.cfg.X32_FW)]);
      return;
    }
    if (addr === "/status") {
      this.reply(client, "/status", [oscStr("active"), oscStr(this.localIp), oscStr(this.cfg.X32_NAME)]);
      return;
    }
    if (addr === "/node") {
      this.replyNode(client, args);
      return;
    }
    if (addr === "/xremote" || addr === "/formatsubscribe" || addr === "/batchsubscribe" || addr === "/meters") {
      if (!isApp) {
        this.addRemote(client, this.clock.monotonic());
        this.addMeterSub(client, addr, args);
      }
      if (addr === "/batchsubscribe") this.handleSubscribe();
      else if (addr !== "/meters") this.handleXremote();
      return;
    }
    if (addr === "/unsubscribe" || addr === "/renew") {
      this.recvCount++;
      const now = this.clock.monotonic();
      const who = peerKey(client);
      if (addr === "/unsubscribe") {
        this.subscribed = false;
        this.remotes.delete(who);
        this.remoteSeen.delete(who);
      }
      for (const [key, sub] of [...this.meterSubs]) {
        if (peerKey(sub.client) === who) {
          if (addr === "/renew") sub.last = now;
          else this.meterSubs.delete(key);
        }
      }
      return;
    }
    if (addr === "/showdump") {
      this.reply(client, "node", [oscStr(`/-show/showfile/show "${this.cfg.X32_NAME}" 0 0 0 0 0 0 0 0 0 0 "${this.cfg.X32_FW}"\n`)]);
      return;
    }

    const ch = chFromAddr(addr);
    if (ch !== null && addr.endsWith("/mix/fader")) {
      if (args.length > 0) {
        const echoedBefore = this.echoCount;
        this.handleFader(addr, args);
        const pos = argFloat(args[0]);
        if (pos === null || !Number.isFinite(pos)) return;
        this.setParam(addr, [oscFloat(pos)]);
        this.push(addr, [oscFloat(pos)], client);
        if (!isApp && this.echoCount === echoedBefore) this.sendApp(addr, [oscFloat(pos)]);
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
        if (v === null || !Number.isFinite(v)) return;
        this.setParam(addr, [oscInt(Math.trunc(v))]);
        this.push(addr, [oscInt(Math.trunc(v))], client);
      } else {
        this.reply(client, addr, [oscInt(this.mute.get(ch) ? 0 : 1)]);
      }
      return;
    }
    if (addr === "/-action/goscene") {
      if (args.length > 0) this.handleScene(args);
      return;
    }

    if (args.length === 0) {
      let val = this.params.get(addr);
      if (val === undefined) {
        val = defaultFor(addr);
        this.setParam(addr, val);
      }
      this.reply(client, addr, val);
      this.recvCount++;
      return;
    }
    if (!this.setParam(addr, args)) return;
    this.push(addr, args, client);
    this.handleDefault();
  }

  moveFaderExternally(ch: number, db: number): void {
    const pos = dbToFader(db);
    this.fader.set(ch, pos);
    const addr = `/ch/${zeroPad(ch, 2)}/mix/fader`;
    this.setParam(addr, [oscFloat(pos)]);
    this.sendApp(addr, [oscFloat(pos)]);
    this.push(addr, [oscFloat(pos)]);
  }

  private startMeters(): void {
    if (this.meterTask !== null || this.stopped) return;
    const gen = this.generation;
    const task: Promise<void> = this.meterLoop(gen).finally(() => {
      if (this.meterTask === task) this.meterTask = null;
    });
    this.meterTask = task;
  }

  private async waitOrStop(seconds: number, gen: number): Promise<boolean> {
    let remaining = seconds;
    while (remaining > 1e-9) {
      if (this.stopped || gen !== this.generation) return true;
      const slice = Math.min(remaining, 0.25);
      await this.clock.sleep(slice);
      remaining -= slice;
    }
    return this.stopped || gen !== this.generation;
  }

  private async meterLoop(gen: number): Promise<void> {
    const period = 1.0 / this.meterHz;
    while (!(await this.waitOrStop(period, gen))) {
      try {
        this.meterStep();
      } catch (e) {
        this.lastError = e;
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
      this.sendApp("/meters/1", [oscBlob(encodeMeterBlob(bank(this.nMeters)))]);
      this.metersSent++;
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

  static extPick(k: number, cfg: Config): number | null {
    const chans = [...cfg.CHANNELS.keys()].filter((c) => c !== cfg.MEAS_MIC_CH);
    return chans.length > 0 ? (chans[k % chans.length] ?? null) : null;
  }

  private async extLoop(gen: number): Promise<void> {
    let k = 0;
    while (!(await this.waitOrStop(12.0, gen))) {
      if (!this.subscribed) continue;
      const ch = EmulatedDesk.extPick(k, this.cfg);
      if (ch === null) continue;
      k++;
      this.moveFaderExternally(ch, -8.0 + 4.0 * ((k % 3) - 1));
    }
  }

  start(): Promise<this> {
    const gen = ++this.generation;
    this.stopped = false;
    const run = this.pending.then(() => this.bindFor(gen));
    this.pending = run.catch(() => undefined);
    return run.then(() => this);
  }

  private async bindFor(gen: number): Promise<void> {
    if (gen !== this.generation || this.endpoint !== null) return;
    const ep = await this.udp.bind(this.listenPort, this.listenHost);
    if (gen !== this.generation) {
      ep.close();
      return;
    }
    this.endpoint = ep;
    this.listenPort = ep.port;
    const appPeer: Peer = { host: this.appHost, port: this.appPort };
    this.appSender = (addr, args) => ep.send(encodeMessage(addr, args), appPeer);
    ep.onMessage((data, from) => {
      try {
        for (const m of decodePacket(data)) this.handleAny(from, m.address, m.args);
      } catch (e) {
        this.lastError = e;
      }
    });
    if (this.externalMoves) void this.extLoop(gen);
  }

  stop(): void {
    this.generation++;
    this.stopped = true;
    this.meterTask = null;
    const ep = this.endpoint;
    this.endpoint = null;
    this.appSender = null;
    if (ep !== null) {
      try {
        ep.close();
      } catch (e) {
        this.lastError = e;
      }
    }
  }
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
