// Shapes of the server's JSON, mirrored from the Python side.
// Snapshot  = Engine._rebuild_telemetry()  (trio_mix/engine.py)
// Command   = Engine.command()             (trio_mix/engine.py)
// Python dicts keyed by int arrive as JSON objects with *string* keys.
//
// Ambient (no import/export) on purpose: dashboard.ts is a classic <script>,
// and any module syntax would make tsc emit `export {}`, which a classic
// script can't parse.

type FbState = "ok" | "building" | "notched";
type AlertLevel = "info" | "notice" | "warn" | "critical";

interface ChannelT {
  ch: number;
  role: string;
  label: string;
  rms: number;
  peak: number;
  fader: number;
  gain: number;
  fb_state: FbState;
  fb_streak: number;
  notch_freqs: number[];
  clip_recent: boolean;
  gain_trimmed: boolean;
  muted: boolean;
  manual_hold: boolean;
  is_meas: boolean;
  is_lead: boolean;
  is_balance: boolean;
  in_mix: boolean;
}

interface ShowT {
  current: string;
  next: string;
  section: string;
  bpm: number | null;
  scene: number | null;
  playing: boolean;
  index: number | null;
}

interface AlertT { level: AlertLevel; msg: string; }
interface SceneT { index: number; name: string; current: boolean; }

interface AdviceT {
  prompt: string;
  assessment: string;
  severity: "info" | "notice" | "warn";
  time: string;
}

interface CaptureT {
  kind: "audio" | "simulation" | "none" | string;
  name?: string | null;
  device?: unknown;
  channels?: number;
  dead?: boolean;
  silent?: boolean;
  overload?: boolean;
  overruns?: number;
  underruns?: number;
  peak?: number;
}

interface CoachRecT {
  seq: number;
  time: string;
  kind: string;
  ch: number | null;
  role: string | null;
  text: string;
  persist?: boolean;
  [extra: string]: unknown;
}

interface EqBandT { band: number; hz: number; gain: number; q: number; on: boolean; }
interface LatencyT { last: number; ema: number; [extra: string]: number; }

interface LogEntryT {
  time: string;
  kind: string;
  msg: string;
  ch: number | null;
  level?: AlertLevel;
}

interface Snapshot {
  status: "live" | "takeover" | "calibrating" | string;
  op_mode: "auto" | "alert" | "manual" | "calibrating" | "coach";
  alerts: AlertT[];
  scenes: SceneT[];
  mode: "simulation" | "live-hardware";
  capture: CaptureT;
  console: { meters: number; connected: boolean };
  uptime: number;
  perf: { tick_ms: number; jitter_ms: number; max_ms: number };
  latency: Record<string, LatencyT>;
  block_ms: number;
  room: { level_db: number; contrast_db: number; confidence: number | null };
  enabled: Record<string, boolean>;
  coach: { on: boolean; recs: CoachRecT[] };
  main_muted: boolean;
  master: { fader: number };
  eq: Record<string, EqBandT[]>;
  sends: Record<string, Record<string, number>>;
  fx: { buses: Record<string, string>; wet: Record<string, number> };
  show: ShowT;
  advisor: AdviceT | null;
  advisor_on: boolean;
  venue: { name: string; shows: number; confidence: number; freqs: number[] } | null;
  lead: { target: number | null; input: number | null; output: number | null };
  balance_targets: Record<string, number>;
  calibration: {
    status: "idle" | "running" | "done" | string;
    baseline: { hz: number; db: number }[];
    watchlist: { hz: number; excess: number }[];
    corrections: { hz: number; cut: number }[];
  };
  channels: ChannelT[];
  log: LogEntryT[];
}

type Command =
  | { type: "fader"; ch: number; db: number }
  | { type: "mute"; ch: number; on: boolean }
  | { type: "master"; db: number }
  | { type: "toggle"; job: string; on: boolean }
  | { type: "coach"; on: boolean }
  | { type: "panic"; on: boolean }
  | { type: "calibrate" }
  | { type: "lead_target"; db: number }
  | { type: "balance_capture" }
  | { type: "reset_notches" }
  | { type: "scene"; index: number }
  | { type: "eq"; ch: number; band: number; hz?: number; gain?: number; q?: number; on?: boolean }
  | { type: "eq_reset"; ch: number }
  | { type: "send"; ch: number; fx: number; db: number }
  | { type: "fx"; fx: number; db: number };

interface Window {
  __INITIAL__?: Snapshot | null;
}
