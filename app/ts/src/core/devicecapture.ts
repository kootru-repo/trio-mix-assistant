import { CaptureError, CaptureSourceBase } from "./capture.ts";
import type { CaptureStatus, Frame } from "./capture.ts";
import type { Clock } from "./clock.ts";
import { C } from "./config.ts";
import { pyRound, pyRoundTo } from "./pyfmt.ts";

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
}

export interface AudioOutputSink {
  play(samples: Float32Array, sampleRate: number, device: AudioDeviceId | null): void | Promise<void>;
}

export interface RankedInput {
  index: number;
  name: string | null;
  channels: number;
  samplerate: number;
  hostapi: string;
}

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export interface SoundDeviceCaptureOptions {
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
}

interface QueuedFrame {
  data: Float32Array;
  ncols: number;
}

const QUEUE_MAX = 32;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const errName = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

const pyRepr = (v: AudioDeviceId | null): string => {
  if (v === null) return "None";
  if (typeof v === "number") return String(v);
  return `'${v}'`;
};

const pyStr = (v: AudioDeviceId | null): string => (v === null ? "None" : String(v));

export class SoundDeviceCapture extends CaptureSourceBase {
  readonly SILENCE_AFTER = 4;
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
  underruns = 0;
  silentSince: number | null = null;
  ovrMarkT: number | null = null;
  ovrMarkVal = 0;

  private gain: number;
  private readonly factory: AudioInputFactory;
  private readonly clock: Clock;
  private readonly outputSink: AudioOutputSink | null;
  private q: QueuedFrame[] = [];
  private stream: AudioInputStream | null = null;
  private last: QueuedFrame | null = null;
  private consecUnderruns = 0;
  private peak = 0;
  private overloadFlag = false;
  private devName: string | null = null;

  constructor(opts: SoundDeviceCaptureOptions) {
    super();
    this.factory = opts.factory;
    this.clock = opts.clock;
    this.device = opts.device ?? null;
    this.outputDevice = opts.outputDevice ?? null;
    this.outputSink = opts.outputSink ?? null;
    this.gainDb = Number(opts.gainDb ?? 0.0);
    this.gain = 10.0 ** (this.gainDb / 20.0);
    this.samplerate = opts.sampleRate ?? C.SAMPLE_RATE;
    this.blocksize = opts.block ?? C.BLOCK;
    this.measCh = opts.measCh ?? C.MEAS_MIC_CH;
    if (opts.channelMap && opts.channelMap.size > 0) {
      this.channelMap = opts.channelMap;
    } else {
      const chans = [...C.CHANNELS.keys()].sort((a, b) => a - b);
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
    if (this.q.length >= QUEUE_MAX) {
      this.overruns += 1;
      this.q.shift();
    }
    this.q.push({ data, ncols: this.ndev });
  }

  override start(): void {
    if (this.stream !== null) return;
    const stream = this.makeInputStream();
    stream.start();
    this.stream = stream;
  }

  makeInputStream(): AudioInputStream {
    try {
      const info = this.factory.queryDevice(this.device);
      this.devName = info.name ?? null;
      const maxin = Math.trunc(info.max_input_channels ?? 0);
      if (maxin < this.ndev) {
        throw new CaptureError(
          `audio device '${info.name ?? pyStr(this.device)}' has ${maxin} input ` +
            `channel(s) but this setup needs ${this.ndev} ` +
            `(console returns + meas mic). Pick a fuller device or aggregate.`,
        );
      }
    } catch (e) {
      if (e instanceof CaptureError) throw e;
      throw new CaptureError(
        `audio device ${pyRepr(this.device)} could not be opened ` +
          `(${errName(e)}: ${errText(e)}). Run --list-devices and check --audio-device.`,
      );
    }
    try {
      return this.factory.open(
        { device: this.device, channels: this.ndev, sampleRate: this.samplerate, blockSize: this.blocksize },
        (indata, xrun) => this.onAudio(indata, xrun),
      );
    } catch (e) {
      if (e instanceof CaptureError) throw e;
      throw new CaptureError(
        `could not open audio device ${pyRepr(this.device)} at ${this.samplerate} Hz ` +
          `(${errName(e)}: ${errText(e)}). It may be in use by another app, or not ` +
          `support ${this.samplerate} Hz.`,
      );
    }
  }

  override stop(): void {
    if (this.stream !== null) {
      try {
        this.stream.stop();
        this.stream.close();
      } catch {
        this.stream = null;
      }
      this.stream = null;
    }
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
    if (this.q.length > 0) {
      frame = this.q[this.q.length - 1]!;
      this.q = [];
    }
    if (frame !== null) {
      this.consecUnderruns = 0;
      this.last = frame;
      this.trackSilence(frame);
    } else {
      this.underruns += 1;
      this.consecUnderruns += 1;
      if (this.consecUnderruns > this.SILENCE_AFTER || this.last === null) {
        frame = { data: new Float32Array(this.blocksize * this.ndev), ncols: this.ndev };
      } else {
        frame = this.last;
      }
    }
    return this.mapFrame(frame);
  }

  private trackSilence(frame: QueuedFrame): void {
    let peak = 0;
    for (let i = 0; i < frame.data.length; i++) {
      const a = Math.abs(frame.data[i]!);
      if (a > peak) peak = a;
    }
    this.peak = peak;
    if (this.peak >= this.SILENCE_FLOOR) {
      this.silentSince = null;
    } else if (this.silentSince === null) {
      this.silentSince = this.clock.monotonic();
    }
  }

  override dead(): boolean {
    return this.consecUnderruns > this.SILENCE_AFTER;
  }

  override silent(): boolean {
    if (this.stream === null || this.dead() || this.silentSince === null) return false;
    return this.clock.monotonic() - this.silentSince > this.SILENCE_HOLD_S;
  }

  overload(): boolean {
    const now = this.clock.monotonic();
    if (this.ovrMarkT === null) {
      this.ovrMarkT = now;
      this.ovrMarkVal = this.overruns;
      return false;
    }
    const dt = now - this.ovrMarkT;
    if (dt >= 2.0) {
      const rate = (this.overruns - this.ovrMarkVal) / dt;
      this.ovrMarkT = now;
      this.ovrMarkVal = this.overruns;
      this.overloadFlag = rate > this.OVERLOAD_RATE;
    }
    return this.overloadFlag;
  }

  override restart(): Promise<boolean> {
    this.stop();
    try {
      this.start();
      this.consecUnderruns = 0;
      this.silentSince = null;
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
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
    if (chunks.length === 0) return null;
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
    const boost = Math.max(0.0, Math.min(maxDb, targetDbfs - levelDb));
    this.gainDb = pyRoundTo(boost, 1);
    this.gain = 10.0 ** (this.gainDb / 20.0);
    return this.gainDb;
  }

  override async emitPinkNoise(samples: Float32Array): Promise<boolean> {
    try {
      if (this.outputSink === null) return false;
      await this.outputSink.play(samples, this.samplerate, this.outputDevice);
      return true;
    } catch {
      return false;
    }
  }

  override status(): CaptureStatus {
    return {
      kind: "audio",
      overruns: this.overruns,
      underruns: this.underruns,
      dead: this.dead(),
      silent: this.silent(),
      overload: this.overload(),
      peak: pyRoundTo(this.peak, 5),
      name: this.devName,
      device: pyStr(this.device),
      channels: this.ndev,
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
  preferSr: number = C.SAMPLE_RATE,
): RankedInput[] {
  const cands: [number, AudioDeviceInfo][] = [];
  devs.forEach((d, i) => {
    if ((d.max_input_channels ?? 0) > 0) cands.push([i, d]);
  });

  const score = (d: AudioDeviceInfo): number => {
    const name = d.name || "";
    let s = 0.0;
    if (defaultName && name === defaultName) s += 10.0;
    if (pyRound(d.default_samplerate || 0) === preferSr) s += 5.0;
    const api = apiNameOf(d, hostapis);
    if (api.includes("ASIO")) {
      s += 4.0;
    } else if (["WASAPI", "Core Audio", "ALSA", "JACK"].some((k) => api.includes(k))) {
      s += 3.0;
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
    samplerate: pyRound(d.default_samplerate || preferSr),
    hostapi: apiNameOf(d, hostapis),
  }));
}

export function pickInput(
  devs: readonly AudioDeviceInfo[],
  hostapis: readonly AudioHostApiInfo[],
  defaultName: string | null,
  preferSr: number = C.SAMPLE_RATE,
): RankedInput | null {
  const r = rankInputs(devs, hostapis, defaultName, preferSr);
  return r[0] ?? null;
}

export function autodetectInputs(factory: AudioInputFactory, preferSr: number = C.SAMPLE_RATE): RankedInput[] {
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

const INT_RE = /^[+-]?\d+(_\d+)*$/;

const pyInt = (s: string): number | null => {
  const t = s.trim();
  if (!INT_RE.test(t)) return null;
  return Number(t.replace(/_/g, ""));
};

export function parseChannelMap(spec: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const raw of spec.split(",")) {
    const pair = raw.trim();
    if (pair === "") continue;
    const k = pair.indexOf(":");
    if (k < 0) throw new ValueError(`entry '${pair}' must be console:device (e.g. 8:9)`);
    const ch = pyInt(pair.slice(0, k));
    const dev = pyInt(pair.slice(k + 1));
    if (ch === null || dev === null) throw new ValueError(`entry '${pair}' has non-integer channel/column`);
    if (ch < 1 || dev < 0) throw new ValueError(`entry '${pair}': console channel >= 1, device column >= 0`);
    out.set(ch, dev);
  }
  if (out.size === 0) throw new ValueError("channel-map is empty");
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
