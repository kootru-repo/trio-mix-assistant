import type { Clock } from "./clock.ts";
import { C } from "./config.ts";
import { argNumber, decodePacket } from "./oscwire.ts";
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
    this.advance();
    void this.loop();
    return Promise.resolve();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      await this.clock.sleep(this.interval);
      if (!this.running) return;
      this.advance();
    }
  }

  override stop(): void {
    this.running = false;
  }
}

const pyStr = (a: OscArg | undefined): string => {
  if (!a) return "";
  if (a.t === "f") return Number.isInteger(a.v) ? `${a.v}.0` : String(a.v);
  if (a.t === "b") return `b'${[...a.v].map((x) => String.fromCharCode(x)).join("")}'`;
  return String(a.v);
};

const asStr = (args: OscArg[]): string => (args.length ? pyStr(args[0]).trim() : "");

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

  constructor(factory: UdpFactory, onChange: ShowChangeHandler | null = null, ip: string = "0.0.0.0", port: number = C.ABLESET_PORT) {
    super(onChange);
    this.factory = factory;
    this.ip = ip;
    this.port = port;
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

  override async start(): Promise<void> {
    const ep = await this.factory.bind(this.port, this.ip);
    this.endpoint = ep;
    this.running = true;
    ep.onMessage((data) => {
      for (const m of decodePacket(data)) this.handle(m.address, m.args);
    });
  }

  override stop(): void {
    this.running = false;
    if (this.endpoint) {
      this.endpoint.close();
      this.endpoint = null;
    }
  }
}
