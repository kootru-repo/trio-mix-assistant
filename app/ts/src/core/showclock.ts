import type { Clock } from "./clock.ts";
import { C } from "./config.ts";
import type { Config } from "./config.ts";
import { argNumber, argText } from "./oscargs.ts";
import { decodePacket } from "./oscwire.ts";
import type { OscArg } from "./oscwire.ts";
import type { ShowTemplate } from "./template.ts";
import type { UdpEndpoint, UdpFactory } from "./transport.ts";

export interface ShowState {
  songIndex: number | null;
  songName: string;
  nextSong: string;
  section: string;
  bpm: number | null;
  playing: boolean;
}

export const newShowState = (): ShowState => ({
  songIndex: null,
  songName: "",
  nextSong: "",
  section: "",
  bpm: null,
  playing: false,
});

export type ShowChangeHandler = (state: ShowState) => void;

export interface ShowClockPort {
  start(): Promise<void>;
  stop(): void;
}

export class ShowClock implements ShowClockPort {
  onChange: ShowChangeHandler | null;
  state: ShowState = newShowState();

  constructor(onChange: ShowChangeHandler | null = null) {
    this.onChange = onChange;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): void {}

  protected fire(state: ShowState): void {
    this.state = state;
    if (this.onChange) this.onChange(state);
  }
}

export class SimShowClock extends ShowClock {
  private readonly template: ShowTemplate;
  private readonly interval: number;
  private readonly clock: Clock;
  private i = -1;
  private running = false;
  private generation = 0;

  constructor(template: ShowTemplate, clock: Clock, onChange: ShowChangeHandler | null = null, interval: number = 15.0) {
    super(onChange);
    this.template = template;
    this.clock = clock;
    this.interval = interval;
  }

  advance(): void {
    const songs = this.template.songs;
    if (!songs.length) return;
    this.i = (this.i + 1) % songs.length;
    const cur = songs[this.i]!;
    const nxt = songs[(this.i + 1) % songs.length]!;
    this.fire({ songIndex: this.i, songName: cur.name, nextSong: nxt.name, section: "Song", bpm: null, playing: true });
  }

  override start(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.running = true;
    const gen = ++this.generation;
    this.advance();
    void this.loop(gen);
    return Promise.resolve();
  }

  private async loop(gen: number): Promise<void> {
    while (this.running && gen === this.generation) {
      await this.clock.sleep(this.interval);
      if (!this.running || gen !== this.generation) return;
      this.advance();
    }
  }

  override stop(): void {
    this.running = false;
    this.generation++;
  }
}

export const MAX_SHOW_TEXT = 120;

const asStr = (args: OscArg[]): string => (args.length ? argText(args[0]!).trim().slice(0, MAX_SHOW_TEXT) : "");

const hostKey = (host: string): string => host.trim().toLowerCase().replace(/^::ffff:/, "");

const SHOW_ADDRESSES = new Set([
  "/setlist/activeSongName",
  "/setlist/activeSongIndex",
  "/setlist/nextSongName",
  "/song/sectionName",
  "/playback/isPlaying",
  "/song/beatsPerMinute",
]);

const asFloat = (args: OscArg[]): number | null => (args.length ? argNumber(args[0]) : null);

const keyOf = (s: ShowState): string => `${s.songName}\u0000${s.section}\u0000${s.playing}`;

export class AbleSetReceiver extends ShowClock {
  private readonly factory: UdpFactory;
  private readonly ip: string;
  private readonly port: number;
  private endpoint: UdpEndpoint | null = null;
  private running = false;
  private cur: ShowState = newShowState();
  private lastKey: string | null = null;
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private sender: string | null;
  lastError: unknown = null;
  rejected = 0;

  constructor(
    factory: UdpFactory,
    onChange: ShowChangeHandler | null = null,
    ip: string = "0.0.0.0",
    port?: number,
    allowFrom: string | null = null,
    cfg: Config = C,
  ) {
    super(onChange);
    this.factory = factory;
    this.ip = ip;
    this.port = port ?? cfg.ABLESET_PORT;
    this.sender = allowFrom !== null && allowFrom.trim() !== "" ? hostKey(allowFrom) : null;
  }

  get acceptedSender(): string | null {
    return this.sender;
  }

  private accepts(from: string, messages: readonly { address: string }[]): boolean {
    const host = hostKey(from);
    if (this.sender === null) {
      if (!messages.some((m) => SHOW_ADDRESSES.has(m.address))) return false;
      this.sender = host;
      return true;
    }
    if (host === this.sender) return true;
    this.rejected += 1;
    return false;
  }

  private maybeFire(): void {
    if (!this.running) return;
    const k = keyOf(this.cur);
    if (k !== this.lastKey && this.cur.songName) {
      this.lastKey = k;
      this.fire({ ...this.cur });
    }
  }

  handle(address: string, args: OscArg[]): void {
    if (!this.running) return;
    switch (address) {
      case "/setlist/activeSongName":
        this.cur.songName = asStr(args);
        this.maybeFire();
        break;
      case "/setlist/activeSongIndex": {
        const v = asFloat(args);
        this.cur.songIndex = v !== null ? Math.trunc(v) : null;
        break;
      }
      case "/setlist/nextSongName":
        this.cur.nextSong = asStr(args);
        break;
      case "/song/sectionName":
        this.cur.section = asStr(args);
        this.maybeFire();
        break;
      case "/playback/isPlaying": {
        const v = asFloat(args);
        this.cur.playing = v !== null ? v !== 0 : this.cur.playing;
        this.maybeFire();
        break;
      }
      case "/song/beatsPerMinute":
        this.cur.bpm = asFloat(args);
        break;
      default:
        break;
    }
  }

  override start(): Promise<void> {
    const gen = ++this.generation;
    const run = this.pending.then(() => this.bindFor(gen));
    this.pending = run.catch(() => undefined);
    return run;
  }

  private async bindFor(gen: number): Promise<void> {
    if (gen !== this.generation || this.endpoint !== null) return;
    const ep = await this.factory.bind(this.port, this.ip);
    if (gen !== this.generation) {
      ep.close();
      return;
    }
    this.endpoint = ep;
    this.running = true;
    ep.onMessage((data, from) => {
      try {
        const messages = decodePacket(data);
        if (!this.accepts(from.host, messages)) return;
        for (const m of messages) this.handle(m.address, m.args);
      } catch (e) {
        this.lastError = e;
      }
    });
  }

  override stop(): void {
    this.generation++;
    this.running = false;
    const ep = this.endpoint;
    this.endpoint = null;
    if (ep !== null) {
      try {
        ep.close();
      } catch (e) {
        this.lastError = e;
      }
    }
  }
}
