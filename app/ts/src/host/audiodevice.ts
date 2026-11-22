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

interface NativeInput {
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  start(): void;
  quit(cb?: () => void): void;
}

interface NativeOutput {
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  start(): void;
  write(chunk: Uint8Array): unknown;
  end(cb?: () => void): void;
  quit(cb?: () => void): void;
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
  AudioIO(options: unknown): NativeInput & NativeOutput;
  SampleFormatFloat32: number;
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

const importModule: ModuleImporter = (name) => import(name);

const isNotInstalled = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { code?: unknown; message?: unknown };
  return err.code === "ERR_MODULE_NOT_FOUND" && String(err.message).includes(`'${NATIVE_AUDIO_MODULE}'`);
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

export class NativeAudioInputFactory implements AudioInputFactory {
  private readonly native: NativeAudio | null;
  private readonly loadError: CaptureError | null;

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
    const frameBytes = 4 * Math.max(1, options.channels);
    const io = native.AudioIO({
      inOptions: {
        channelCount: options.channels,
        sampleFormat: native.SampleFormatFloat32,
        sampleRate: options.sampleRate,
        deviceId: id,
        framesPerBuffer: options.blockSize,
        closeOnError: false,
      },
    });
    io.on("data", (chunk: unknown) => {
      const buf = chunk as Uint8Array;
      const bytes = buf.byteLength - (buf.byteLength % frameBytes);
      callback(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytes)), false);
    });
    io.on("error", () => callback(new Float32Array(0), true));
    return {
      start: () => io.start(),
      stop: () => undefined,
      close: () => io.quit(),
    };
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
        playThrough(native, samples, sampleRate, device, (message) => {
          lastError = message;
        });
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
): void {
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
  const io = native.AudioIO({
    outOptions: {
      channelCount: 2,
      sampleFormat: native.SampleFormatFloat32,
      sampleRate,
      deviceId: id,
      closeOnError: false,
    },
  });
  io.on("error", (e) => onError(e instanceof Error ? e.message : String(e)));
  const stereo = new Float32Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    stereo[2 * i] = samples[i]!;
    stereo[2 * i + 1] = samples[i]!;
  }
  try {
    io.start();
    io.write(new Uint8Array(stereo.buffer, stereo.byteOffset, stereo.byteLength));
    io.end(() => io.quit());
  } catch (e) {
    try {
      io.quit();
    } catch {
      onError("could not release the output stream");
    }
    throw e;
  }
}
