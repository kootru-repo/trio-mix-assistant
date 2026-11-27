import { BlockAnalyser, analysisConfig } from "./blockanalysis.ts";
import type { AnalysedBlock, AnalysisConfig } from "./blockanalysis.ts";
import { CaptureError, CaptureSourceBase } from "./capture.ts";
import type { BlockHandler, CaptureStatus, Frame } from "./capture.ts";
import type { Clock } from "./clock.ts";
import { C } from "./config.ts";
import type { Config } from "./config.ts";
import { DeviceCapture } from "./devicecapture.ts";
import { activeTuning } from "./tuning.ts";
import type { TuningOverride } from "./tuning.ts";
import type { AudioDeviceId, AudioInputFactory } from "./devicecapture.ts";

export interface CaptureConfig {
  device: AudioDeviceId | null;
  outputDevice: AudioDeviceId | null;
  channelMap: [number, number][];
  measCh: number;
  gainDb: number;
  sampleRate: number;
  block: number;
  analysis: AnalysisConfig;
  tuning: TuningOverride[];
}

export type CaptureCall =
  | { op: "restart" }
  | { op: "captureMeas"; seconds: number }
  | { op: "autoGain" }
  | { op: "pink"; samples: Float32Array };

export type ToCapture = { type: "open"; config: CaptureConfig } | { type: "close" } | { type: "call"; id: number; call: CaptureCall };

export interface CaptureReport {
  status: CaptureStatus;
  gainDb: number;
  autoDb: number | null;
}

export type CallValue = boolean | Float32Array | null;

export type FromCapture =
  | { type: "opened"; report: CaptureReport }
  | { type: "failed"; message: string }
  | { type: "block"; at: number; block: AnalysedBlock }
  | { type: "report"; report: CaptureReport }
  | { type: "result"; id: number; value: CallValue; report: CaptureReport | null }
  | { type: "closed" };

export interface CapturePort {
  post(message: ToCapture): void;
  onMessage(handler: (message: FromCapture) => void): void;
  onExit(handler: (reason: string) => void): void;
  close(): void;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class CaptureHost {
  static readonly HEARTBEAT_S = 0.2;

  private readonly factory: AudioInputFactory;
  private readonly clock: Clock;
  private readonly post: (message: FromCapture) => void;
  private readonly stamp: () => number;
  private readonly cfg: Config;
  private cap: DeviceCapture | null = null;
  private analyser: BlockAnalyser;
  private analysis: AnalysisConfig | null = null;
  private gen = 0;

  constructor(factory: AudioInputFactory, clock: Clock, post: (message: FromCapture) => void, stamp: () => number, cfg: Config = C) {
    this.factory = factory;
    this.clock = clock;
    this.post = post;
    this.stamp = stamp;
    this.cfg = cfg;
    this.analyser = new BlockAnalyser(cfg);
  }

  handle(message: ToCapture): void {
    if (message.type === "open") this.open(message.config);
    else if (message.type === "close") void this.close();
    else void this.call(message.id, message.call);
  }

  private report(cap: DeviceCapture): CaptureReport {
    return { status: cap.status(), gainDb: cap.gainDb, autoDb: cap.autoDb };
  }

  private open(config: CaptureConfig): void {
    this.shutdown();
    const gen = this.gen;
    this.analyser = new BlockAnalyser(this.cfg);
    this.analysis = config.analysis;
    let cap: DeviceCapture;
    try {
      cap = new DeviceCapture({
        factory: this.factory,
        clock: this.clock,
        device: config.device,
        outputDevice: config.outputDevice,
        channelMap: new Map(config.channelMap),
        sampleRate: config.sampleRate,
        block: config.block,
        measCh: config.measCh,
        gainDb: config.gainDb,
        cfg: this.cfg,
      });
      cap.subscribeFrames((frame) => this.onFrame(gen, frame));
      this.cap = cap;
      cap.start();
    } catch (e) {
      this.post({ type: "failed", message: errText(e) });
      void this.heartbeat(gen);
      return;
    }
    this.post({ type: "opened", report: this.report(cap) });
    void this.heartbeat(gen);
  }

  private onFrame(gen: number, frame: Frame): void {
    if (gen !== this.gen || this.analysis === null) return;
    this.post({ type: "block", at: this.stamp(), block: this.analyser.analyse(frame, this.analysis) });
  }

  private async heartbeat(gen: number): Promise<void> {
    while (gen === this.gen) {
      await this.clock.sleep(CaptureHost.HEARTBEAT_S);
      const cap = this.cap;
      if (gen !== this.gen || cap === null) return;
      this.post({ type: "report", report: this.report(cap) });
    }
  }

  shutdown(): void {
    this.gen++;
    const cap = this.cap;
    this.cap = null;
    if (cap === null) return;
    try {
      cap.stop();
    } catch {
      return;
    }
  }

  private async close(): Promise<void> {
    this.shutdown();
    if (this.factory.idle) await this.factory.idle();
    this.post({ type: "closed" });
  }

  private async run(cap: DeviceCapture, call: CaptureCall): Promise<CallValue> {
    if (call.op === "restart") return cap.restart();
    if (call.op === "captureMeas") return cap.captureMeas(call.seconds);
    if (call.op === "pink") return cap.emitPinkNoise(call.samples);
    await cap.autoGain();
    return true;
  }

  private async call(id: number, call: CaptureCall): Promise<void> {
    const cap = this.cap;
    if (cap === null) {
      this.post({ type: "result", id, value: null, report: null });
      return;
    }
    let value: CallValue = null;
    try {
      value = await this.run(cap, call);
    } catch {
      value = null;
    }
    this.post({ type: "result", id, value, report: this.cap === cap ? this.report(cap) : null });
  }
}

export interface RemoteCaptureOptions {
  connect: () => CapturePort;
  clock: Clock;
  stamp: () => number;
  device?: AudioDeviceId | null;
  outputDevice?: AudioDeviceId | null;
  channelMap?: Map<number, number> | null;
  gainDb?: number;
  sampleRate?: number;
  block?: number;
  measCh?: number | null;
  cfg?: Config;
}

type LinkState = "idle" | "opening" | "open" | "down";

const noop = (): void => undefined;

export class RemoteCapture extends CaptureSourceBase {
  readonly STALE_S = 0.25;
  readonly QUIET_S = 3.0;
  readonly CONFIRM_S = 0.2;
  readonly CLOSE_WAIT_S = 2.5;
  readonly CALL_WAIT_S = 6.0;

  device: AudioDeviceId | null;
  gainDb: number;
  autoDb: number | null = null;
  lastError: string | null = null;
  stale = 0;
  lagMs = 0;

  private readonly opts: RemoteCaptureOptions;
  private readonly clock: Clock;
  private readonly cfg: Config;
  private port: CapturePort | null = null;
  private state: LinkState = "idle";
  private handler: BlockHandler | null = null;
  private last: CaptureReport | null = null;
  private opening: Promise<void> = Promise.resolve();
  private openDone: { ok: () => void; fail: (e: Error) => void } = { ok: noop, fail: noop };
  private settling: Promise<void> = Promise.resolve();
  private readonly calls = new Map<number, (value: CallValue) => void>();
  private nextId = 1;
  private lastHeard = 0;
  private quietSeen: number | null = null;
  private restarting: Promise<boolean> | null = null;

  constructor(opts: RemoteCaptureOptions) {
    super();
    this.opts = opts;
    this.clock = opts.clock;
    this.cfg = opts.cfg ?? C;
    this.device = opts.device ?? null;
    this.gainDb = Number(opts.gainDb ?? 0.0);
  }

  config(): CaptureConfig {
    const given = this.opts.channelMap;
    const map: [number, number][] =
      given && given.size > 0
        ? [...given]
        : [...this.cfg.CHANNELS.keys()].sort((a, b) => a - b).map((ch) => [ch, ch - 1] as [number, number]);
    return {
      device: this.device,
      outputDevice: this.opts.outputDevice ?? null,
      channelMap: map,
      measCh: this.opts.measCh ?? this.cfg.MEAS_MIC_CH,
      gainDb: this.gainDb,
      sampleRate: this.opts.sampleRate ?? this.cfg.SAMPLE_RATE,
      block: this.opts.block ?? this.cfg.BLOCK,
      analysis: analysisConfig(this.cfg),
      tuning: [...activeTuning()],
    };
  }

  subscribe(handler: BlockHandler): void {
    this.handler = handler;
  }

  override start(): void {
    if (this.state === "opening" || this.state === "open") return;
    this.dropPort();
    let port: CapturePort;
    try {
      port = this.opts.connect();
    } catch (e) {
      this.state = "down";
      this.lastError = `could not start the audio thread: ${errText(e)}`;
      this.opening = Promise.reject(new CaptureError(this.lastError));
      this.opening.catch(noop);
      return;
    }
    this.port = port;
    this.state = "opening";
    this.lastHeard = this.clock.monotonic();
    this.quietSeen = null;
    this.opening = new Promise<void>((ok, fail) => {
      this.openDone = { ok, fail };
    });
    this.opening.catch(noop);
    port.onMessage((m) => {
      if (this.port === port) this.onMessage(m);
    });
    port.onExit((reason) => {
      if (this.port === port) this.onExit(reason);
    });
    port.post({ type: "open", config: this.config() });
  }

  ready(): Promise<void> {
    return this.opening;
  }

  settled(): Promise<void> {
    return this.settling;
  }

  private take(report: CaptureReport | null): void {
    if (report === null) return;
    this.last = report;
    this.gainDb = report.gainDb;
    this.autoDb = report.autoDb;
  }

  private onMessage(m: FromCapture): void {
    this.lastHeard = this.clock.monotonic();
    this.quietSeen = null;
    if (m.type === "block") {
      const age = (this.opts.stamp() - m.at) / 1000;
      this.lagMs = 0.95 * this.lagMs + 0.05 * age * 1000;
      if (age > this.STALE_S) this.stale += 1;
      else if (this.handler !== null) this.handler(m.block, age);
    } else if (m.type === "report") {
      this.take(m.report);
    } else if (m.type === "opened") {
      this.state = "open";
      this.lastError = null;
      this.take(m.report);
      this.openDone.ok();
    } else if (m.type === "failed") {
      this.state = "down";
      this.lastError = m.message;
      this.openDone.fail(new CaptureError(m.message));
    } else if (m.type === "result") {
      this.take(m.report);
      const done = this.calls.get(m.id);
      this.calls.delete(m.id);
      if (done) done(m.value);
    }
  }

  private failCalls(): void {
    const pending = [...this.calls.values()];
    this.calls.clear();
    for (const done of pending) done(null);
  }

  private onExit(reason: string): void {
    this.port = null;
    this.state = "down";
    this.lastError = `the audio thread stopped: ${reason}`;
    this.openDone.fail(new CaptureError(this.lastError));
    this.failCalls();
  }

  private dropPort(): void {
    const port = this.port;
    this.port = null;
    this.failCalls();
    if (port === null) return;
    const before = this.settling;
    const gone = new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        try {
          port.close();
        } catch {
          resolve();
          return;
        }
        resolve();
      };
      port.onMessage((m) => {
        if (m.type === "closed") finish();
      });
      port.onExit(finish);
      try {
        port.post({ type: "close" });
      } catch {
        finish();
      }
      void this.clock.sleep(this.CLOSE_WAIT_S).then(finish);
    });
    this.settling = Promise.all([before, gone]).then(noop);
  }

  override stop(): void {
    this.state = "idle";
    this.openDone.fail(new CaptureError("audio capture was stopped"));
    this.dropPort();
  }

  block(): Frame {
    return new Map();
  }

  override dead(): boolean {
    if (this.state === "down") return true;
    if (this.state !== "open") return false;
    if (this.last !== null && Boolean(this.last.status["dead"])) return true;
    const now = this.clock.monotonic();
    if (now - this.lastHeard <= this.QUIET_S) return false;
    if (this.quietSeen === null) {
      this.quietSeen = now;
      return false;
    }
    return now - this.quietSeen >= this.CONFIRM_S;
  }

  override silent(): boolean {
    return this.state === "open" && this.last !== null && Boolean(this.last.status["silent"]) && !this.dead();
  }

  private call(call: CaptureCall, waitS: number): Promise<CallValue> {
    const port = this.port;
    if (port === null || this.state !== "open") return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise<CallValue>((resolve) => {
      this.calls.set(id, resolve);
      void this.clock.sleep(waitS).then(() => {
        if (!this.calls.delete(id)) return;
        resolve(null);
      });
      try {
        port.post({ type: "call", id, call });
      } catch {
        this.calls.delete(id);
        resolve(null);
      }
    });
  }

  private async reopen(): Promise<boolean> {
    this.stop();
    await this.settling;
    this.start();
    try {
      await this.opening;
      return true;
    } catch {
      return false;
    }
  }

  override restart(): Promise<boolean> {
    if (this.restarting !== null) return this.restarting;
    const run = this.restartOnce().finally(() => {
      this.restarting = null;
    });
    this.restarting = run;
    return run;
  }

  private async restartOnce(): Promise<boolean> {
    if (this.state !== "open" || this.port === null) return this.reopen();
    const quiet = this.clock.monotonic() - this.lastHeard > this.QUIET_S;
    if (quiet) return this.reopen();
    const value = await this.call({ op: "restart" }, this.CALL_WAIT_S);
    if (value === true) {
      this.lastError = null;
      return true;
    }
    if (value === null) return this.reopen();
    const reason = this.last?.status["lastError"];
    this.lastError = typeof reason === "string" && reason ? reason : "the audio device could not be re-opened";
    return false;
  }

  override async captureMeas(seconds: number): Promise<Float32Array | null> {
    const value = await this.call({ op: "captureMeas", seconds }, seconds + this.CALL_WAIT_S);
    return value instanceof Float32Array ? value : null;
  }

  override async emitPinkNoise(samples: Float32Array): Promise<boolean> {
    const seconds = samples.length / (this.opts.sampleRate ?? this.cfg.SAMPLE_RATE);
    return (await this.call({ op: "pink", samples }, seconds + this.CALL_WAIT_S)) === true;
  }

  async autoGain(): Promise<number> {
    await this.call({ op: "autoGain" }, this.CALL_WAIT_S);
    return this.gainDb;
  }

  override status(): CaptureStatus {
    const base: CaptureStatus = this.last?.status ?? {
      kind: "audio",
      name: null,
      device: this.device === null ? "default" : String(this.device),
    };
    return {
      ...base,
      dead: this.dead(),
      silent: this.silent(),
      lastError: this.lastError ?? base["lastError"] ?? null,
      stale: this.stale,
      lag_ms: Math.round(this.lagMs * 10) / 10,
      link: this.state,
    };
  }
}

export function loopbackPort(factory: AudioInputFactory, clock: Clock, stamp: () => number, cfg: Config = C): CapturePort {
  let handler: ((message: FromCapture) => void) | null = null;
  let open = true;
  const later = (fn: () => void): void => void Promise.resolve().then(fn);
  const host = new CaptureHost(
    factory,
    clock,
    (m) =>
      later(() => {
        if (open && handler !== null) handler(m);
      }),
    stamp,
    cfg,
  );
  return {
    post: (m) =>
      later(() => {
        if (open) host.handle(m);
      }),
    onMessage: (h) => {
      const previous = handler;
      handler = previous === null ? h : (m) => (previous(m), h(m));
    },
    onExit: () => undefined,
    close: () => {
      open = false;
      host.shutdown();
    },
  };
}
