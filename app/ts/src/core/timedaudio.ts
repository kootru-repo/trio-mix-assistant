import type { Clock } from "./clock.ts";
import type { Config } from "./config.ts";
import type {
  AudioDeviceInfo,
  AudioHostApiInfo,
  AudioInputCallback,
  AudioInputFactory,
  AudioInputOptions,
  AudioInputStream,
} from "./devicecapture.ts";
import { SeededRng } from "./rng.ts";
import type { Rng } from "./rng.ts";

export type ContentFn = (i: number) => Float32Array;

export interface TimedAudioOptions {
  sampleRate?: number;
  blockSize?: number;
  content?: ContentFn | null;
  seed?: number;
  rng?: Rng | null;
  cfg: Config;
}

export class TimedAudioStream implements AudioInputStream {
  readonly channels: number;
  readonly sampleRate: number;
  readonly blockSize: number;
  deliver = true;
  xrunNext = false;
  lastError: unknown = null;
  private readonly callback: AudioInputCallback;
  private readonly clock: Clock;
  private readonly content: ContentFn;
  private readonly rng: Rng;
  private readonly cfg: Config;
  private stopped = true;
  private task: Promise<void> = Promise.resolve();
  private generation = 0;
  private i = 0;

  constructor(callback: AudioInputCallback, channels: number, clock: Clock, opts: TimedAudioOptions) {
    this.callback = callback;
    this.channels = channels;
    this.clock = clock;
    this.cfg = opts.cfg;
    this.sampleRate = opts.sampleRate ?? this.cfg.SAMPLE_RATE;
    this.blockSize = opts.blockSize ?? this.cfg.BLOCK;
    this.rng = opts.rng ?? new SeededRng(opts.seed ?? 5);
    this.content = opts.content ?? ((i) => this.defaultContent(i));
  }

  defaultContent(i: number): Float32Array {
    const n = this.blockSize;
    const ch = this.channels;
    const frame = new Float32Array(n * ch);
    for (let k = 0; k < frame.length; k++) frame[k] = 0.004 * this.rng.standardNormal();
    const measCol = this.cfg.MEAS_MIC_CH - 1;
    if (measCol >= 0 && measCol < ch) {
      const amp = Math.min(0.6, 0.03 * 1.25 ** (i % 60));
      for (let k = 0; k < n; k++) {
        const t = (i * n + k) / this.sampleRate;
        const tone = amp * Math.sin(2 * Math.PI * 2500.0 * t);
        const at = k * ch + measCol;
        frame[at] = frame[at]! + tone;
      }
    }
    return frame;
  }

  private async loop(gen: number): Promise<void> {
    const period = this.blockSize / this.sampleRate;
    let nextT = this.clock.highResolution();
    while (!this.stopped && gen === this.generation) {
      const now = this.clock.highResolution();
      let burst = 0;
      while (nextT <= now && burst < 8) {
        if (this.deliver) {
          const frame = this.content(this.i);
          this.i += 1;
          const xrun = this.xrunNext;
          this.xrunNext = false;
          try {
            this.callback(frame, xrun);
          } catch (e) {
            this.lastError = e;
          }
        }
        nextT += period;
        burst += 1;
      }
      if (nextT <= now) nextT = now + period;
      await this.clock.sleep(Math.max(0.001, Math.min(period, nextT - this.clock.highResolution())));
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const gen = ++this.generation;
    this.task = Promise.all([this.task, this.loop(gen)]).then(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
  }

  close(): void {
    this.stop();
  }

  settled(): Promise<void> {
    return this.task;
  }
}

export class TimedAudioFactory implements AudioInputFactory {
  private readonly clock: Clock;
  private readonly maxChannels: number;
  private readonly cfg: Config;
  static readonly KEEP_STREAMS = 8;
  readonly streams: TimedAudioStream[] = [];

  constructor(clock: Clock, cfg: Config, maxChannels: number = 64) {
    this.clock = clock;
    this.maxChannels = maxChannels;
    this.cfg = cfg;
  }

  queryDevice(): AudioDeviceInfo {
    return { name: "timed audio (emulated)", max_input_channels: this.maxChannels, default_samplerate: this.cfg.SAMPLE_RATE, hostapi: 0 };
  }

  listDevices(): AudioDeviceInfo[] {
    return [this.queryDevice()];
  }

  listHostApis(): AudioHostApiInfo[] {
    return [{ name: "emulated" }];
  }

  defaultInputIndex(): number | null {
    return 0;
  }

  open(options: AudioInputOptions, callback: AudioInputCallback): AudioInputStream {
    const stream = new TimedAudioStream(callback, options.channels, this.clock, {
      sampleRate: options.sampleRate,
      blockSize: options.blockSize,
      cfg: this.cfg,
    });
    this.streams.push(stream);
    if (this.streams.length > TimedAudioFactory.KEEP_STREAMS) this.streams.shift();
    return stream;
  }
}
