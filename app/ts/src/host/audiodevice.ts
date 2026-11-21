import { CaptureError } from "../core/capture.ts";
import type {
  AudioDeviceId,
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

interface NativeDevice {
  id: number;
  name: string;
  maxInputChannels: number;
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
  AudioIO(options: unknown): NativeInput;
  SampleFormatFloat32: number;
}

const missing = (): CaptureError =>
  new CaptureError(
    `live audio input needs the optional native audio module '${NATIVE_AUDIO_MODULE}' ` +
      `(npm install ${NATIVE_AUDIO_MODULE}); it is not installed. ` +
      `--simulation and the emulator modes work without it.`,
  );

export async function loadNativeAudio(): Promise<NativeAudio | null> {
  try {
    const name: string = NATIVE_AUDIO_MODULE;
    const mod = (await import(name)) as { default?: unknown };
    return (mod.default ?? mod) as NativeAudio;
  } catch {
    return null;
  }
}

export class NativeAudioInputFactory implements AudioInputFactory {
  private readonly native: NativeAudio | null;

  constructor(native: NativeAudio | null) {
    this.native = native;
  }

  static async create(): Promise<NativeAudioInputFactory> {
    return new NativeAudioInputFactory(await loadNativeAudio());
  }

  private need(): NativeAudio {
    if (this.native === null) throw missing();
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
        hostapi: Math.max(0, d.hostAPIName ? names.indexOf(d.hostAPIName) : -1),
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
      if (d === undefined) throw new Error(`Error querying device ${device}`);
      return d;
    }
    if (typeof device === "string") {
      const d = devs.find((x) => (x.name ?? "").includes(device));
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
    let id = -1;
    if (typeof wanted === "number") id = wanted;
    else if (typeof wanted === "string") id = this.listDevices().findIndex((d) => (d.name ?? "").includes(wanted));
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
      const bytes = buf.byteLength - (buf.byteLength % 4);
      callback(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytes)), false);
    });
    io.on("error", () => callback(new Float32Array(0), true));
    return {
      start: () => io.start(),
      stop: () => undefined,
      close: () => io.quit(),
    };
  }
}
