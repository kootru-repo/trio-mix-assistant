import { arch, homedir, platform, release } from "node:os";
import { LevelWindow, audioFacts } from "../core/diagnostics.ts";
import type { AudioFacts, AudioModuleFacts, ConsoleFacts, NetworkFacts } from "../core/diagnostics.ts";
import type { RemoteCapture } from "../core/capturelink.ts";
import type { Clock } from "../core/clock.ts";
import type { Config } from "../core/config.ts";
import type { ConsoleBase } from "../core/console.ts";
import type { AudioInputFactory } from "../core/devicecapture.ts";
import type { MeterReceiver } from "../core/metersrv.ts";
import type { Args } from "./args.ts";
import { appVersion } from "./version.ts";

export const BUILD_ENV = "TRIO_MIX_BUILD";
export const CLI_WINDOW_S = 8.0;
export const OPEN_WAIT_S = 15.0;

const SYSTEM_NAMES: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function systemFacts(): { app: string; system: string; platform: string; home: string | null } {
  const build = process.env[BUILD_ENV];
  const p = platform();
  return {
    app: `${appVersion().label}, ${build ? `single-file app, build ${build}` : "running from source"}, Node.js ${process.versions.node}`,
    system: `${SYSTEM_NAMES[p] ?? p} ${release()} ${arch()}`,
    platform: p,
    home: homedir() || null,
  };
}

export function moduleFacts(factory: AudioInputFactory | null): AudioModuleFacts {
  if (factory === null) return { ok: false, inputs: 0, error: "the audio module was not loaded" };
  try {
    return { ok: true, inputs: factory.listDevices().filter((d) => (d.max_input_channels ?? 0) > 0).length, error: null };
  } catch (e) {
    return { ok: false, inputs: 0, error: errText(e) };
  }
}

export function networkFacts(args: Pick<Args, "host" | "pin" | "https" | "port">, ip: string | null): NetworkFacts {
  const lan = args.host !== "127.0.0.1" && args.host !== "localhost" && args.host !== "::1";
  return {
    lan,
    url: lan && ip ? `${args.https ? "https" : "http"}://${ip}:${args.port}/` : null,
    pin: args.pin !== null && args.pin !== "",
    https: args.https,
  };
}

export const channelLabels = (cfg: Config): Map<number, string> =>
  new Map([...cfg.CHANNELS].map(([ch, role]) => [ch, cfg.ROLE_LABELS.get(role) ?? role]));

const POLL_S = 0.05;

export async function within<T>(work: Promise<T>, clock: Clock, seconds: number, what: string): Promise<T> {
  let settled = false;
  const watched = work.finally(() => {
    settled = true;
  });
  watched.catch(() => undefined);
  const t0 = clock.monotonic();
  while (!settled && clock.monotonic() - t0 < seconds) await clock.sleep(POLL_S);
  if (!settled) throw new Error(`${what} did not finish in ${seconds} s`);
  return watched;
}

export class AudioProbe {
  private readonly source: RemoteCapture;
  private readonly clock: Clock;
  private readonly cfg: Config;
  private readonly window = new LevelWindow();
  private before: Record<string, unknown> = {};
  private openError: string | null = null;
  private t0 = 0;

  constructor(source: RemoteCapture, clock: Clock, cfg: Config) {
    this.source = source;
    this.clock = clock;
    this.cfg = cfg;
  }

  async start(alreadyOpen: boolean): Promise<void> {
    this.source.subscribe((block) => this.window.add(block));
    if (!alreadyOpen) {
      try {
        this.source.start();
        await within(this.source.ready(), this.clock, OPEN_WAIT_S, "opening the input");
      } catch (e) {
        this.openError = errText(e);
      }
    }
    this.before = this.source.status();
    this.window.blocks = 0;
    this.t0 = this.clock.monotonic();
  }

  facts(mapped: readonly number[] | null): AudioFacts {
    const elapsed = Math.max(this.clock.monotonic() - this.t0, 1e-3);
    const facts = audioFacts(
      this.before,
      this.source.status(),
      this.window,
      elapsed,
      this.cfg.SAMPLE_RATE / this.cfg.BLOCK,
      channelLabels(this.cfg),
      mapped,
    );
    if (this.openError !== null)
      return { ...facts, link: facts.link === "open" ? "down" : facts.link, lastError: facts.lastError ?? this.openError };
    return facts;
  }

  async stop(): Promise<void> {
    try {
      this.source.stop();
      await within(this.source.settled(), this.clock, OPEN_WAIT_S, "closing the input");
    } catch {
      return;
    }
  }
}

export class ConsoleProbe {
  private readonly con: ConsoleBase;
  private readonly clock: Clock;
  private readonly rx: MeterReceiver;
  private packets = 0;
  private meters = 0;
  private listening = false;
  private listenError: string | null = null;
  private t0 = 0;

  constructor(con: ConsoleBase, rx: MeterReceiver, clock: Clock) {
    this.con = con;
    this.clock = clock;
    this.rx = rx;
    rx.onMeters = (vals) => {
      this.packets += 1;
      this.meters = vals.length;
    };
  }

  async start(): Promise<void> {
    try {
      await this.rx.start();
      this.listening = true;
    } catch (e) {
      this.listenError = errText(e);
    }
    this.t0 = this.clock.monotonic();
    if (this.listening) this.con.subscribeMeters();
  }

  facts(emulated: boolean, address: string): ConsoleFacts {
    return {
      emulated,
      address,
      listening: this.listening,
      listenError: this.listenError,
      windowS: Math.max(this.clock.monotonic() - this.t0, 1e-3),
      packets: this.packets,
      meters: this.meters,
    };
  }

  stop(): void {
    this.rx.stop();
    this.con.close();
  }
}
