import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CaptureError } from "../core/capture.ts";
import type {
  AudioDeviceId,
  AudioOutputSink,
  AudioDeviceInfo,
  AudioHostApiInfo,
  AudioInputCallback,
  AudioInputFactory,
  AudioInputOptions,
  AudioInputStream,
} from "../core/devicecapture.ts";

export const NATIVE_AUDIO_MODULE = "naudiodon2";
export const NATIVE_AUDIO_BINARY = ["build", "Release", "naudiodon.node"];
const SAMPLE_FORMAT_FLOAT32 = 1;
const RELEASE_TIMEOUT_MS = 2000;
const QUEUE_BLOCKS = 32;
const READ_ERRORS_BEFORE_GIVING_UP = 50;

interface NativeRead {
  buf?: Uint8Array;
  finished?: boolean;
  err?: unknown;
}

export interface NativeStream {
  start(): void;
  read(bytes: number): Promise<NativeRead>;
  write(chunk: Uint8Array): Promise<unknown>;
  quit(mode: "WAIT" | "ABORT"): Promise<unknown>;
}

interface NativeDevice {
  id: number;
  name: string;
  maxInputChannels: number;
  maxOutputChannels?: number;
  defaultSampleRate: number;
  hostAPIName?: string;
}

interface NativeHostApis {
  defaultHostAPI?: number;
  HostAPIs?: { id?: number; name: string; defaultInput?: number }[];
}

export interface NativeAudio {
  getDevices(): NativeDevice[];
  getHostAPIs(): NativeHostApis;
  create(options: unknown): NativeStream;
}

const missing = (): CaptureError =>
  new CaptureError(
    `live audio input needs the optional native audio module '${NATIVE_AUDIO_MODULE}' ` +
      `(npm install ${NATIVE_AUDIO_MODULE}); it is not installed. ` +
      `--simulation and the emulator modes work without it.`,
  );

const broken = (detail: string): CaptureError =>
  new CaptureError(
    `the native audio module '${NATIVE_AUDIO_MODULE}' is installed but failed to load: ${detail}. ` +
      `Reinstall it (npm install ${NATIVE_AUDIO_MODULE}) or check that its native build matches this Node version.`,
  );

export type ModuleImporter = (name: string) => Promise<unknown>;

const importModule: ModuleImporter = (name) => {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve(`${name}/package.json`));
  return Promise.resolve().then(() => require(join(root, ...NATIVE_AUDIO_BINARY)) as unknown);
};

const isNotInstalled = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { code?: unknown; message?: unknown };
  const notFound = err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND";
  return notFound && String(err.message).includes(`'${NATIVE_AUDIO_MODULE}`);
};

export async function loadNativeAudio(importer: ModuleImporter = importModule): Promise<NativeAudio | null> {
  let mod: { default?: unknown };
  try {
    mod = (await importer(NATIVE_AUDIO_MODULE)) as { default?: unknown };
  } catch (e) {
    if (isNotInstalled(e)) return null;
    throw broken(e instanceof Error ? e.message : String(e));
  }
  return (mod.default ?? mod) as NativeAudio;
}

const withTimeout = (work: Promise<unknown>, ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });

export class NativeAudioInputFactory implements AudioInputFactory {
  private readonly native: NativeAudio | null;
  private readonly loadError: CaptureError | null;
  private closing: Promise<void> = Promise.resolve();

  constructor(native: NativeAudio | null, loadError: CaptureError | null = null) {
    this.native = native;
    this.loadError = loadError;
  }

  static async create(importer: ModuleImporter = importModule): Promise<NativeAudioInputFactory> {
    try {
      return new NativeAudioInputFactory(await loadNativeAudio(importer));
    } catch (e) {
      if (e instanceof CaptureError) return new NativeAudioInputFactory(null, e);
      throw e;
    }
  }

  private need(): NativeAudio {
    if (this.native === null) throw this.loadError ?? missing();
    return this.native;
  }

  private apiNames(): string[] {
    const apis = this.need().getHostAPIs().HostAPIs ?? [];
    return apis.map((a) => a.name);
  }

  listHostApis(): AudioHostApiInfo[] {
    return this.apiNames().map((name) => ({ name }));
  }

  listDevices(): AudioDeviceInfo[] {
    const names = this.apiNames();
    return this.need()
      .getDevices()
      .map((d) => ({
        name: d.name,
        max_input_channels: d.maxInputChannels,
        default_samplerate: d.defaultSampleRate,
        hostapi: d.hostAPIName ? names.indexOf(d.hostAPIName) : -1,
      }));
  }

  defaultInputIndex(): number | null {
    const apis = this.need().getHostAPIs();
    const def = (apis.HostAPIs ?? []).find((a) => a.id === apis.defaultHostAPI);
    const idx = def?.defaultInput;
    return typeof idx === "number" && idx >= 0 ? idx : null;
  }

  queryDevice(device: AudioDeviceId | null): AudioDeviceInfo {
    const devs = this.listDevices();
    if (typeof device === "number") {
      const d = devs[device];
      if (d === undefined) throw new Error(`could not query audio device ${device}`);
      return d;
    }
    if (typeof device === "string") {
      const d = devs.find((x) => (x.max_input_channels ?? 0) > 0 && (x.name ?? "").includes(device));
      if (d === undefined) throw new Error(`No input device matching '${device}'`);
      return d;
    }
    const di = this.defaultInputIndex();
    const d = di === null ? undefined : devs[di];
    if (d === undefined) throw new Error("No default input device available");
    return d;
  }

  private release(stream: NativeStream): void {
    let quitting: Promise<unknown>;
    try {
      quitting = stream.quit("WAIT");
    } catch {
      quitting = Promise.resolve();
    }
    const released = withTimeout(quitting, RELEASE_TIMEOUT_MS);
    this.closing = Promise.all([this.closing, released]).then(() => undefined);
  }

  open(options: AudioInputOptions, callback: AudioInputCallback): AudioInputStream {
    const native = this.need();
    const wanted = options.device;
    const devs = native.getDevices();
    let id = -1;
    if (typeof wanted === "number") {
      const d = devs[wanted];
      if (d === undefined) throw new Error(`could not query audio device ${wanted}`);
      id = d.id;
    } else if (typeof wanted === "string") {
      const d = devs.find((x) => x.maxInputChannels > 0 && x.name.includes(wanted));
      if (d !== undefined) id = d.id;
    }
    const blockBytes = 4 * Math.max(1, options.channels) * Math.max(1, options.blockSize);
    const stream = native.create({
      inOptions: {
        channelCount: options.channels,
        sampleFormat: SAMPLE_FORMAT_FLOAT32,
        sampleRate: options.sampleRate,
        deviceId: id,
        framesPerBuffer: options.blockSize,
        maxQueue: QUEUE_BLOCKS,
        closeOnError: false,
      },
    });
    const pending = new Uint8Array(blockBytes);
    let held = 0;
    let closed = false;
    const deliver = (buf: Uint8Array): void => {
      let at = 0;
      while (at < buf.byteLength) {
        const take = Math.min(blockBytes - held, buf.byteLength - at);
        pending.set(buf.subarray(at, at + take), held);
        held += take;
        at += take;
        if (held === blockBytes) {
          callback(new Float32Array(pending.buffer.slice(0, blockBytes)), false);
          held = 0;
        }
      }
    };
    const pump = async (): Promise<void> => {
      let errors = 0;
      while (!closed) {
        let got: NativeRead;
        try {
          got = await stream.read(blockBytes);
        } catch {
          got = { err: "read failed" };
        }
        if (closed) return;
        if (got.err !== undefined && got.err !== null) {
          callback(new Float32Array(0), true);
          errors += 1;
          if (errors >= READ_ERRORS_BEFORE_GIVING_UP) return;
          continue;
        }
        if (got.finished || got.buf === undefined) return;
        errors = 0;
        deliver(got.buf);
      }
    };
    return {
      start: () => {
        stream.start();
        void pump();
      },
      stop: () => undefined,
      close: () => {
        if (closed) return;
        closed = true;
        this.release(stream);
      },
    };
  }

  idle(): Promise<void> {
    return this.closing;
  }

  outputSink(): AudioOutputSink | null {
    const native = this.native;
    if (native === null) return null;
    let lastError: string | null = null;
    return {
      get lastError(): string | null {
        return lastError;
      },
      play: (samples, sampleRate, device) => {
        lastError = null;
        const playing = playThrough(native, samples, sampleRate, device, (message) => {
          lastError = message;
        });
        this.closing = Promise.all([this.closing, playing]).then(() => undefined);
      },
    };
  }
}

function playThrough(
  native: NativeAudio,
  samples: Float32Array,
  sampleRate: number,
  device: AudioDeviceId | null,
  onError: (message: string) => void,
): Promise<void> {
  let id = -1;
  if (typeof device === "number") {
    const d = native.getDevices()[device];
    if (d === undefined) throw new Error(`No output device ${device}`);
    id = d.id;
  } else if (typeof device === "string") {
    const d = native.getDevices().find((x) => (x.maxOutputChannels ?? 0) > 0 && x.name.includes(device));
    if (d === undefined) throw new Error(`No output device matching '${device}'`);
    id = d.id;
  }
  const stream = native.create({
    outOptions: {
      channelCount: 2,
      sampleFormat: SAMPLE_FORMAT_FLOAT32,
      sampleRate,
      deviceId: id,
      closeOnError: false,
    },
  });
  const stereo = new Float32Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    stereo[2 * i] = samples[i]!;
    stereo[2 * i + 1] = samples[i]!;
  }
  const release = (): Promise<void> =>
    withTimeout(
      Promise.resolve().then(() => stream.quit("WAIT")),
      RELEASE_TIMEOUT_MS + (samples.length / Math.max(1, sampleRate)) * 1000,
    );
  let writing: Promise<unknown>;
  try {
    stream.start();
    writing = stream.write(Buffer.from(stereo.buffer, stereo.byteOffset, stereo.byteLength));
  } catch (e) {
    void release();
    throw e;
  }
  return writing
    .then(
      (failure) => {
        if (failure !== undefined && failure !== null) onError(String(failure));
      },
      (e: unknown) => onError(e instanceof Error ? e.message : String(e)),
    )
    .then(release);
}
