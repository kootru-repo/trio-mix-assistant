import { CaptureError, CaptureSourceBase } from "./capture.ts";
import type { CaptureStatus, Frame } from "./capture.ts";
import type { Clock } from "./clock.ts";
import type { Config } from "./config.ts";
import { roundHalfEven, roundTo } from "./numfmt.ts";
import { parseInteger } from "./util.ts";

export type AudioDeviceId = number | string;

export interface AudioDeviceInfo {
  name?: string | null;
  max_input_channels?: number;
  default_samplerate?: number;
  hostapi?: number;
}

export interface AudioHostApiInfo {
  name: string;
}

export interface AudioInputOptions {
  device: AudioDeviceId | null;
  channels: number;
  sampleRate: number;
  blockSize: number;
}

export type AudioInputCallback = (indata: Float32Array, xrun: boolean) => void;

export interface AudioInputStream {
  start(): void;
  stop(): void;
  close(): void;
}

export interface AudioInputFactory {
  queryDevice(device: AudioDeviceId | null): AudioDeviceInfo;
  listDevices(): AudioDeviceInfo[];
  listHostApis(): AudioHostApiInfo[];
  defaultInputIndex(): number | null;
  open(options: AudioInputOptions, callback: AudioInputCallback): AudioInputStream;
  outputSink?(): AudioOutputSink | null;
  idle?(): Promise<void>;
}

export interface AudioOutputSink {
  readonly lastError?: string | null;
  play(samples: Float32Array, sampleRate: number, device: AudioDeviceId | null): void | Promise<void>;
}

export interface RankedInput {
  index: number;
  name: string | null;
  channels: number;
  samplerate: number;
  hostapi: string;
}

export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArgumentError";
  }
}

export interface DeviceCaptureOptions {
  factory: AudioInputFactory;
  clock: Clock;
  device?: AudioDeviceId | null;
  channelMap?: Map<number, number> | null;
  sampleRate?: number;
  block?: number;
  measCh?: number | null;
  outputDevice?: AudioDeviceId | null;
  outputSink?: AudioOutputSink | null;
  gainDb?: number;
  cfg: Config;
}

interface QueuedFrame {
  data: Float32Array;
  ncols: number;
}

interface MeasTap {
  dev: number;
  need: number;
  got: number;
  chunks: Float32Array[];
  resolve: (out: Float32Array | null) => void;
}

function joinChunks(chunks: readonly Float32Array[], got: number, need: number): Float32Array | null {
  if (chunks.length === 0 || got < need * 0.9) return null;
  const out = new Float32Array(Math.min(got, need));
  let pos = 0;
  for (const c of chunks) {
    if (pos >= out.length) break;
    const take = Math.min(c.length, out.length - pos);
    out.set(c.subarray(0, take), pos);
    pos += take;
  }
  return out;
}

const QUEUE_MAX = 32;
const BACKLOG_MAX = 2;
const REOPEN_ATTEMPTS = 4;
const REOPEN_WAIT_S = 0.5;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const errName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

const deviceLabel = (v: AudioDeviceId | null): string => (v === null ? "(default)" : JSON.stringify(v));

const quietly = (fn: () => void): void => {
  try {
    fn();
  } catch {
    return;
  }
};

const SILENT_LEVEL_DB = -90;

const strOf = (v: AudioDeviceId | null): string => (v === null ? "default" : String(v));

export class DeviceCapture extends CaptureSourceBase {
  readonly SILENCE_AFTER = 4;
  readonly DEAD_AFTER_S = 0.5;
  readonly DEAD_CONFIRM_S = 0.1;
  readonly SILENCE_FLOOR = 1e-4;
  readonly SILENCE_HOLD_S = 5.0;
  readonly OVERLOAD_RATE = 10.0;

  device: AudioDeviceId | null;
  outputDevice: AudioDeviceId | null;
  gainDb: number;
  readonly samplerate: number;
  readonly blocksize: number;
  readonly measCh: number;
  readonly channelMap: Map<number, number>;
  readonly ndev: number;
  autoDb: number | null = null;
  overruns = 0;
  skipped = 0;
  lastError: string | null = null;
  underruns = 0;
  silentSince: number | null = null;
  ovrMarkT: number | null = null;
  ovrMarkVal = 0;
  skipMarkVal = 0;

  private gain: number;
  private readonly factory: AudioInputFactory;
  private readonly clock: Clock;
  private readonly outputSink: AudioOutputSink | null;
  private q: QueuedFrame[] = [];
  private stream: AudioInputStream | null = null;
  private streamGen = 0;
  private outputOk: boolean;
  private last: QueuedFrame | null = null;
  private consecUnderruns = 0;
  private starvedSince: number | null = null;
  private peak = 0;
  private overloadFlag = false;
  private skippedFlag = false;
  private devName: string | null = null;
  private sink: ((frame: Frame) => void) | null = null;
  private wanted = false;
  private openedAt = 0;
  private lastArrival: number | null = null;
  private taps: MeasTap[] = [];
  delivered = 0;
  private overdueSeen: number | null = null;

  constructor(opts: DeviceCaptureOptions) {
    super();
    this.factory = opts.factory;
    this.clock = opts.clock;
    this.device = opts.device ?? null;
    this.outputDevice = opts.outputDevice ?? null;
    this.outputSink = opts.outputSink ?? opts.factory.outputSink?.() ?? null;
    this.outputOk = this.outputSink !== null;
    this.gainDb = Number(opts.gainDb ?? 0.0);
    this.gain = 10.0 ** (this.gainDb / 20.0);
    const cfg = opts.cfg;
    this.samplerate = opts.sampleRate ?? cfg.SAMPLE_RATE;
    this.blocksize = opts.block ?? cfg.BLOCK;
    this.measCh = opts.measCh ?? cfg.MEAS_MIC_CH;
    if (opts.channelMap && opts.channelMap.size > 0) {
      this.channelMap = opts.channelMap;
    } else {
      const chans = [...cfg.CHANNELS.keys()].sort((a, b) => a - b);
      this.channelMap = new Map(chans.map((ch) => [ch, ch - 1] as [number, number]));
    }
    let top = -Infinity;
    for (const v of this.channelMap.values()) top = Math.max(top, v);
    this.ndev = top + 1;
  }

  onAudio(indata: Float32Array, xrun: boolean = false): void {
    if (xrun) this.overruns += 1;
    if (indata.length === 0) return;
    const data = Float32Array.from(indata);
    if (this.gain !== 1.0) {
      for (let i = 0; i < data.length; i++) data[i] = data[i]! * this.gain;
    }
    if (this.sink !== null) {
      this.pushFrame({ data, ncols: this.ndev }, this.sink);
      return;
    }
    if (this.q.length >= QUEUE_MAX) {
      this.skipped += 1;
      this.q.shift();
    }
    this.q.push({ data, ncols: this.ndev });
  }

  subscribeFrames(handler: (frame: Frame) => void): void {
    this.sink = handler;
  }

  private pushFrame(frame: QueuedFrame, sink: (frame: Frame) => void): void {
    this.lastArrival = this.clock.monotonic();
    this.overdueSeen = null;
    this.delivered += 1;
    this.sampleOverload();
    this.last = frame;
    this.trackSilence(frame);
    if (this.taps.length > 0) this.feedTaps(frame);
    sink(this.mapFrame(frame));
  }

  private feedTaps(frame: QueuedFrame): void {
    const n = Math.floor(frame.data.length / frame.ncols);
    for (const tap of [...this.taps]) {
      if (tap.dev < frame.ncols) {
        const col = new Float32Array(n);
        for (let i = 0; i < n; i++) col[i] = frame.data[i * frame.ncols + tap.dev]!;
        tap.chunks.push(col);
        tap.got += n;
      }
      if (tap.got >= tap.need) this.finishTap(tap);
    }
  }

  private finishTap(tap: MeasTap): void {
    const at = this.taps.indexOf(tap);
    if (at < 0) return;
    this.taps.splice(at, 1);
    tap.resolve(joinChunks(tap.chunks, tap.got, tap.need));
  }

  override start(): void {
    if (this.stream !== null) return;
    this.wanted = true;
    const stream = this.makeInputStream();
    try {
      stream.start();
    } catch (e) {
      quietly(() => stream.close());
      this.streamGen++;
      if (e instanceof CaptureError) throw e;
      throw new CaptureError(`could not start audio device ${deviceLabel(this.device)} (${errName(e)}: ${errText(e)}).`);
    }
    this.stream = stream;
    this.openedAt = this.clock.monotonic();
    this.lastArrival = null;
    this.overdueSeen = null;
  }

  makeInputStream(): AudioInputStream {
    try {
      const info = this.factory.queryDevice(this.device);
      this.devName = info.name ?? null;
      const maxin = Math.trunc(info.max_input_channels ?? 0);
      if (maxin < this.ndev) {
        throw new CaptureError(
          `audio device '${info.name ?? strOf(this.device)}' has ${maxin} input ` +
            `channel(s) but this setup needs ${this.ndev} ` +
            `(console returns + meas mic). Pick a fuller device or aggregate.`,
        );
      }
    } catch (e) {
      if (e instanceof CaptureError) throw e;
      throw new CaptureError(
        `audio device ${deviceLabel(this.device)} could not be opened ` +
          `(${errName(e)}: ${errText(e)}). Run --list-devices and check --audio-device.`,
      );
    }
    try {
      const gen = ++this.streamGen;
      return this.factory.open(
        { device: this.device, channels: this.ndev, sampleRate: this.samplerate, blockSize: this.blocksize },
        (indata, xrun) => {
          if (gen === this.streamGen) this.onAudio(indata, xrun);
        },
      );
    } catch (e) {
      if (e instanceof CaptureError) throw e;
      throw new CaptureError(
        `could not open audio device ${deviceLabel(this.device)} at ${this.samplerate} Hz ` +
          `(${errName(e)}: ${errText(e)}). It may be in use by another app, or not ` +
          `support ${this.samplerate} Hz.`,
      );
    }
  }

  override stop(): void {
    this.wanted = false;
    const stream = this.stream;
    this.stream = null;
    this.streamGen++;
    if (stream === null) return;
    quietly(() => stream.stop());
    quietly(() => stream.close());
  }

  private mapFrame(frame: QueuedFrame): Frame {
    const { data, ncols } = frame;
    const n = Math.floor(data.length / ncols);
    const out: Frame = new Map();
    for (const [ch, dev] of this.channelMap) {
      const col = new Float32Array(n);
      if (dev < ncols) {
        for (let i = 0; i < n; i++) col[i] = data[i * ncols + dev]!;
      }
      out.set(ch, col);
    }
    return out;
  }

  block(): Frame {
    let frame: QueuedFrame | null = null;
    if (this.q.length > BACKLOG_MAX + 1) {
      frame = this.q[this.q.length - 1]!;
      this.skipped += this.q.length - 1;
      this.q = [];
    } else if (this.q.length > 0) {
      frame = this.q.shift()!;
    }
    this.sampleOverload();
    if (frame !== null) {
      this.consecUnderruns = 0;
      this.starvedSince = null;
      this.last = frame;
      this.trackSilence(frame);
    } else {
      this.underruns += 1;
      this.consecUnderruns += 1;
      this.starvedSince ??= this.clock.monotonic();
      if (this.consecUnderruns > this.SILENCE_AFTER || this.last === null) {
        frame = { data: new Float32Array(this.blocksize * this.ndev), ncols: this.ndev };
      } else {
        frame = this.last;
      }
    }
    return this.mapFrame(frame);
  }

  private trackSilence(frame: QueuedFrame): void {
    const n = Math.floor(frame.data.length / frame.ncols);
    let peak = 0;
    for (const dev of this.channelMap.values()) {
      if (dev >= frame.ncols) continue;
      for (let i = 0; i < n; i++) {
        const a = Math.abs(frame.data[i * frame.ncols + dev]!);
        if (a > peak) peak = a;
      }
    }
    this.peak = peak / this.gain;
    if (this.peak >= this.SILENCE_FLOOR) {
      this.silentSince = null;
    } else if (this.silentSince === null) {
      this.silentSince = this.clock.monotonic();
    }
  }

  override dead(): boolean {
    if (this.sink !== null) {
      if (this.stream === null) return this.wanted;
      const now = this.clock.monotonic();
      if (now - (this.lastArrival ?? this.openedAt) < this.DEAD_AFTER_S) {
        this.overdueSeen = null;
        return false;
      }
      if (this.overdueSeen === null) {
        this.overdueSeen = now;
        return false;
      }
      return now - this.overdueSeen >= this.DEAD_CONFIRM_S;
    }
    if (this.consecUnderruns <= this.SILENCE_AFTER || this.starvedSince === null) return false;
    return this.clock.monotonic() - this.starvedSince >= this.DEAD_AFTER_S;
  }

  override silent(): boolean {
    if (this.stream === null || this.dead() || this.silentSince === null) return false;
    return this.clock.monotonic() - this.silentSince > this.SILENCE_HOLD_S;
  }

  private sampleOverload(): void {
    const now = this.clock.monotonic();
    if (this.ovrMarkT === null) {
      this.ovrMarkT = now;
      this.ovrMarkVal = this.overruns;
      this.skipMarkVal = this.skipped;
      return;
    }
    const dt = now - this.ovrMarkT;
    if (dt >= 2.0) {
      const rate = (this.overruns - this.ovrMarkVal) / dt;
      const skipRate = (this.skipped - this.skipMarkVal) / dt;
      this.ovrMarkT = now;
      this.ovrMarkVal = this.overruns;
      this.skipMarkVal = this.skipped;
      this.overloadFlag = rate > this.OVERLOAD_RATE;
      this.skippedFlag = skipRate > this.OVERLOAD_RATE;
    }
  }

  overload(): boolean {
    return this.overloadFlag;
  }

  skippingFrames(): boolean {
    return this.skippedFlag;
  }

  override async restart(): Promise<boolean> {
    this.stop();
    for (let attempt = 1; ; attempt++) {
      await this.factory.idle?.();
      try {
        this.start();
        this.consecUnderruns = 0;
        this.starvedSince = null;
        this.silentSince = null;
        this.lastError = null;
        return true;
      } catch (e) {
        this.lastError = errText(e);
        if (attempt >= REOPEN_ATTEMPTS) return false;
        await this.clock.sleep(REOPEN_WAIT_S);
      }
    }
  }

  private async nextFrame(timeout: number): Promise<QueuedFrame | null> {
    const deadline = this.clock.monotonic() + timeout;
    for (;;) {
      const f = this.q.shift();
      if (f !== undefined) return f;
      if (this.clock.monotonic() >= deadline) return null;
      await this.clock.sleep(0.01);
    }
  }

  override async captureMeas(seconds: number): Promise<Float32Array | null> {
    const dev = this.channelMap.get(this.measCh);
    if (dev === undefined) return null;
    const need = Math.trunc(seconds * this.samplerate);
    if (this.sink !== null) {
      return new Promise((resolve) => {
        const tap: MeasTap = { dev, need, got: 0, chunks: [], resolve };
        this.taps.push(tap);
        void this.clock.sleep(seconds + 3.0).then(() => this.finishTap(tap));
      });
    }
    this.q = [];
    const chunks: Float32Array[] = [];
    let got = 0;
    const deadline = this.clock.monotonic() + seconds + 3.0;
    while (got < need && this.clock.monotonic() < deadline) {
      const frame = await this.nextFrame(0.5);
      if (frame === null) continue;
      if (dev < frame.ncols) {
        const n = Math.floor(frame.data.length / frame.ncols);
        const col = new Float32Array(n);
        for (let i = 0; i < n; i++) col[i] = frame.data[i * frame.ncols + dev]!;
        chunks.push(col);
        got += n;
      }
    }
    return joinChunks(chunks, got, need);
  }

  async autoGain(targetDbfs: number = -32.0, seconds: number = 0.6, maxDb: number = 48.0): Promise<number> {
    this.gainDb = 0.0;
    this.gain = 1.0;
    await this.clock.sleep(0.4);
    const rec = await this.captureMeas(seconds);
    if (rec === null || rec.length === 0) {
      this.autoDb = null;
      return 0.0;
    }
    let acc = 0;
    for (let i = 0; i < rec.length; i++) acc += rec[i]! * rec[i]!;
    const rms = Math.sqrt(acc / rec.length) + 1e-9;
    const levelDb = 20.0 * Math.log10(rms);
    this.autoDb = levelDb;
    if (levelDb < SILENT_LEVEL_DB) return 0.0;
    const boost = Math.max(0.0, Math.min(maxDb, targetDbfs - levelDb));
    this.gainDb = roundTo(boost, 1);
    this.gain = 10.0 ** (this.gainDb / 20.0);
    return this.gainDb;
  }

  override async emitPinkNoise(samples: Float32Array): Promise<boolean> {
    try {
      if (this.outputSink === null) {
        this.outputOk = false;
        return false;
      }
      await this.outputSink.play(samples, this.samplerate, this.outputDevice);
      this.outputOk = true;
      return true;
    } catch {
      this.outputOk = false;
      return false;
    }
  }

  override status(): CaptureStatus {
    return {
      kind: "audio",
      overruns: this.overruns,
      skipped: this.skipped,
      underruns: this.underruns,
      blocks: this.delivered,
      dead: this.dead(),
      silent: this.silent(),
      overload: this.overload(),
      skipping: this.skippingFrames(),
      lastError: this.lastError,
      peak: roundTo(this.peak, 5),
      name: this.devName,
      device: strOf(this.device),
      channels: this.ndev,
      outputUnavailable: !this.outputOk,
      outputError: this.outputSink?.lastError ?? null,
    };
  }
}

const apiNameOf = (d: AudioDeviceInfo, hostapis: readonly AudioHostApiInfo[]): string => {
  const h = d.hostapi;
  if (typeof h === "number" && Number.isInteger(h) && h >= 0 && h < hostapis.length) return hostapis[h]!.name;
  return "";
};

export function rankInputs(
  devs: readonly AudioDeviceInfo[],
  hostapis: readonly AudioHostApiInfo[],
  defaultName: string | null,
  preferSr: number,
): RankedInput[] {
  const cands: [number, AudioDeviceInfo][] = [];
  devs.forEach((d, i) => {
    if ((d.max_input_channels ?? 0) > 0) cands.push([i, d]);
  });

  const score = (d: AudioDeviceInfo): number => {
    const name = d.name || "";
    let s = 0.0;
    if (defaultName && name === defaultName) s += 10.0;
    if (roundHalfEven(d.default_samplerate || 0) === preferSr) s += 5.0;
    const api = apiNameOf(d, hostapis);
    if (api.includes("ASIO")) {
      s += 4.0;
    } else if (["WASAPI", "Core Audio", "ALSA", "JACK"].some((k) => api.includes(k))) {
      s += 3.0;
    } else if (api.includes("WDM-KS")) {
      s -= 8.0;
    }
    const lower = name.toLowerCase();
    if (["array", "built-in", "built in", "internal"].some((k) => lower.includes(k))) s -= 15.0;
    s += Math.min(2.0, (d.max_input_channels ?? 0) * 0.01);
    return s;
  };

  const scored = cands.map((c) => ({ c, s: score(c[1]) }));
  scored.sort((a, b) => b.s - a.s);
  return scored.map(({ c: [i, d] }) => ({
    index: i,
    name: d.name ?? null,
    channels: Math.trunc(d.max_input_channels ?? 1),
    samplerate: roundHalfEven(d.default_samplerate || preferSr),
    hostapi: apiNameOf(d, hostapis),
  }));
}

export function pickInput(
  devs: readonly AudioDeviceInfo[],
  hostapis: readonly AudioHostApiInfo[],
  defaultName: string | null,
  preferSr: number,
): RankedInput | null {
  const r = rankInputs(devs, hostapis, defaultName, preferSr);
  return r[0] ?? null;
}

export function autodetectInputs(factory: AudioInputFactory, preferSr: number): RankedInput[] {
  try {
    const devs = factory.listDevices();
    const apis = factory.listHostApis();
    const di = factory.defaultInputIndex();
    const name = di !== null && Number.isInteger(di) && di >= 0 && di < devs.length ? (devs[di]!.name ?? null) : null;
    return rankInputs(devs, apis, name, preferSr);
  } catch {
    return [];
  }
}

export function parseChannelMap(spec: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const raw of spec.split(",")) {
    const pair = raw.trim();
    if (pair === "") continue;
    const k = pair.indexOf(":");
    if (k < 0) throw new InvalidArgumentError(`entry '${pair}' must be console:device (e.g. 8:9)`);
    const ch = parseInteger(pair.slice(0, k));
    const dev = parseInteger(pair.slice(k + 1));
    if (ch === null || dev === null) throw new InvalidArgumentError(`entry '${pair}' has non-integer channel/column`);
    if (ch < 1 || dev < 0) throw new InvalidArgumentError(`entry '${pair}': console channel >= 1, device column >= 0`);
    out.set(ch, dev);
  }
  if (out.size === 0) throw new InvalidArgumentError("channel-map is empty");
  return out;
}

export function formatDeviceList(devs: readonly AudioDeviceInfo[], apis: readonly AudioHostApiInfo[]): string {
  const lines: string[] = [];
  devs.forEach((d, i) => {
    if ((d.max_input_channels ?? 0) > 0) {
      const h = d.hostapi;
      const api = typeof h === "number" && Number.isInteger(h) && h >= 0 && h < apis.length ? apis[h]!.name : "?";
      const sr = Math.trunc(d.default_samplerate ?? 0);
      lines.push(`  [${i}] ${d.name}  (${d.max_input_channels} in, ${sr} Hz, ${api})`);
    }
  });
  return "Input devices:\n" + (lines.length > 0 ? lines.join("\n") : "  (none found)");
}

export function listAudioDevices(factory: AudioInputFactory): string {
  try {
    return formatDeviceList(factory.listDevices(), factory.listHostApis());
  } catch (e) {
    return `could not list audio devices: ${errText(e)}`;
  }
}
