import { MixAssistant } from "../assistant/index.ts";
import type { AssistantEvent } from "../assistant/index.ts";
import { Calibrator } from "../calibration.ts";
import type { CalibrationResult } from "../calibration.ts";
import type { CaptureSource } from "../capture.ts";
import { SimCapture } from "../capture.ts";
import type { Clock } from "../clock.ts";
import { C } from "../config.ts";
import { ConsoleBase, OscConsole, SimConsole } from "../console.ts";
import { BlockAnalyser } from "../blockanalysis.ts";
import type { DiagHost, DiagReport, LevelWindow } from "../diagnostics.ts";
import type { ChannelFeatures } from "../dsp.ts";
import { VET_EXPECTED_STEPS, VET_EXPECTED_STEPS_WITH_CONSOLE } from "../ports.ts";
import type { AdvisorPort, MeterReceiverPort, SessionLogPort, VetHostPort, VetSummary } from "../ports.ts";
import { roundHalfEven, roundTo } from "../numfmt.ts";
import { SeededRng } from "../rng.ts";
import type { Rng } from "../rng.ts";
import type { ShowClockPort, ShowState } from "../showclock.ts";
import { defaultTemplate } from "../template.ts";
import type { ShowTemplate } from "../template.ts";
import { NEG_INF, perChannel } from "../util.ts";
import type { VenueModel, VenueStore } from "../venue.ts";

export { asBool, intOf, numOf } from "../util.ts";

export interface EqBandState {
  hz: number;
  gain: number;
  q: number;
  on: boolean;
}

export interface ShowInfo {
  current: string;
  next: string;
  section: string;
  bpm: number | null;
  scene: number | null;
  playing: boolean;
  index: number | null;
}

export interface Alert {
  level: string;
  msg: string;
}

export interface LatencyEntry {
  last: number;
  ema: number;
  max: number;
  n: number;
}

export interface Advice {
  prompt: string;
  assessment: string;
  severity: string;
  time: string;
}

export interface EngineOptions {
  clock: Clock;
  console?: ConsoleBase | null;
  sim?: boolean;
  tick?: number;
  source?: CaptureSource | null;
  template?: ShowTemplate | null;
  noiseRng?: Rng | null;
}

export type Telemetry = Record<string, unknown>;

export class EngineBase {
  clock: Clock;
  sim: boolean;
  tick: number;
  con: ConsoleBase;
  source: CaptureSource | null;
  assistant: MixAssistant;
  calibrator: Calibrator;
  noiseRng: Rng;

  protected stopped = false;
  protected t0: number;
  protected lastErrT = -1e9;

  status = "live";
  calib: CalibrationResult | null = null;
  calibStatus = "none";
  protected enabledBackup: Record<string, boolean> | null = null;
  protected lastNotchT: Map<number, number>;
  protected lastClipT: Map<number, number>;
  muted: Map<number, boolean>;
  masterDb = 0;
  eq: Map<number, Map<number, EqBandState>>;
  sends: Map<number, Map<number, number>>;
  fxWet: Map<number, number>;
  meterRx: MeterReceiverPort | null = null;
  showClock: ShowClockPort | null = null;
  sessionLog: SessionLogPort | null = null;
  advisor: AdvisorPort | null = null;
  advisorAdvice: Advice | null = null;
  venue = "";
  venueStore: VenueStore | null = null;
  venueModel: VenueModel | null = null;
  template: ShowTemplate;
  protected appliedSong: string | null = null;
  protected songStartT = -1e9;
  protected deadSince = -1e9;
  show: ShowInfo = { current: "", next: "", section: "", bpm: null, scene: null, playing: false, index: null };
  diagHost: ((identify: boolean) => DiagHost) | null = null;
  vetHost: VetHostPort | null = null;
  protected vetStatus: "idle" | "running" | "done" = "idle";
  protected vetOutcome: VetSummary | null = null;
  protected vetAbort = false;
  protected vetDone = 0;
  protected vetTitle = "";
  protected vetTask: Promise<void> | null = null;
  protected telemetryFrozen = false;
  protected pendingSong: ShowState | null = null;

  protected vetBusy(what: string): boolean {
    if (this.vetStatus !== "running") return false;
    this.assistant.emit("system", `${what} ignored while the full test runs`);
    return true;
  }
  protected diagStatus: "idle" | "running" | "done" = "idle";
  protected diagReport: DiagReport | null = null;
  protected diagWindow: LevelWindow | null = null;
  protected meterPackets = 0;
  protected meterCount = 0;
  protected lastRxT = -1e9;
  protected lastReconcileLog = new Map<number, number>();
  protected feat = new Map<number, ChannelFeatures>();
  protected analyser = new BlockAnalyser();
  protected pushed = false;
  protected perf = { tick_ms: 0, jitter_ms: 0, max_ms: 0 };
  protected latency = new Map<string, LatencyEntry>();
  protected lastAudioRestart = -1e9;
  protected takeoverEpoch = 0;
  protected lastAudioFailure: string | null = null;
  protected readonly rampErrorsSeen = new Set<string>();
  events: AssistantEvent[] = [];
  telemetry: Telemetry = {};

  constructor(opts: EngineOptions) {
    this.clock = opts.clock;
    this.sim = opts.sim ?? true;
    this.tick = opts.tick ?? 0.05;
    this.con = opts.console ?? new SimConsole({ clock: opts.clock });
    this.noiseRng = opts.noiseRng ?? new SeededRng(1);
    if (opts.source) this.source = opts.source;
    else if (this.con instanceof SimConsole) this.source = new SimCapture(this.con);
    else this.source = null;
    this.assistant = new MixAssistant(this.con, this.clock, {
      onEvent: (ev) => this.onEventHandler(ev),
      onLatency: (kind, seconds) => this.noteLatencyEv(kind, seconds),
    });
    this.calibrator = new Calibrator(this.con);
    this.con.onError = (exc) => this.noteRampError(exc);
    this.t0 = this.clock.monotonic();
    this.lastNotchT = perChannel(NEG_INF);
    this.lastClipT = perChannel(NEG_INF);
    this.muted = perChannel(false);
    const mixChans = [...C.CHANNELS.keys()].filter((c) => c !== C.MEAS_MIC_CH);
    const freqs = [...C.EQ_DEFAULT_FREQS];
    this.eq = new Map(
      mixChans.map((c) => [
        c,
        new Map(
          Array.from({ length: C.CHANNEL_EQ_BANDS }, (_v, k) => {
            const b = k + 1;
            const band: EqBandState = { hz: b - 1 < freqs.length ? freqs[b - 1]! : 1000.0, gain: 0, q: 2.0, on: false };
            return [b, band] as [number, EqBandState];
          }),
        ),
      ]),
    );
    this.sends = new Map(mixChans.map((c) => [c, new Map([...C.FX_BUSES.keys()].map((fx) => [fx, -90]))]));
    this.fxWet = new Map([...C.FX_BUSES.keys()].map((fx) => [fx, -90]));
    this.template = opts.template ?? defaultTemplate();
    this.rebuildTelemetry();
  }

  protected noteLatencyEv(kind: string, seconds: number): void {
    if (!(seconds >= 0 && seconds < 5)) return;
    const ms = seconds * 1000;
    const e = this.latency.get(kind);
    if (e === undefined) {
      this.latency.set(kind, { last: roundTo(ms, 2), ema: roundTo(ms, 2), max: roundTo(ms, 2), n: 1 });
    } else {
      const a = 0.2;
      e.last = roundTo(ms, 2);
      e.ema = roundTo((1 - a) * e.ema + a * ms, 2);
      e.max = roundTo(Math.max(e.max, ms), 2);
      e.n += 1;
    }
  }

  protected notePerf(now: number, lastNow: number): void {
    const computeMs = (this.clock.monotonic() - now) * 1000;
    const periodMs = (now - lastNow) * 1000;
    const jitterMs = Math.abs(periodMs - this.tick * 1000);
    const a = 0.1;
    this.perf.tick_ms = roundTo((1 - a) * this.perf.tick_ms + a * computeMs, 2);
    this.perf.jitter_ms = roundTo((1 - a) * this.perf.jitter_ms + a * jitterMs, 2);
    this.perf.max_ms = roundTo(Math.max(this.perf.max_ms * 0.999, computeMs), 2);
  }

  protected noteRampError(exc: unknown): void {
    const msg = `console ramp failed: ${exc instanceof Error ? exc.message : String(exc)}`;
    if (this.rampErrorsSeen.has(msg)) return;
    if (this.rampErrorsSeen.size >= 32) this.rampErrorsSeen.clear();
    this.rampErrorsSeen.add(msg);
    this.assistant.emit("system", msg);
    this.rebuildTelemetry();
  }

  protected consoleTelemetry(connected: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = { meters: this.meterCount, connected };
    if (this.con instanceof OscConsole) {
      const failures = this.con.sendFailures;
      if (failures !== null) out["send_failures"] = failures;
    }
    const rxErr = this.meterRx?.lastError;
    if (rxErr !== undefined && rxErr !== null) out["meter_error"] = rxErr instanceof Error ? rxErr.message : String(rxErr);
    return out;
  }

  protected noteError(exc: unknown): void {
    const now = this.clock.monotonic();
    if (now - this.lastErrT < 5.0) return;
    this.lastErrT = now;
    try {
      const e = exc instanceof Error ? exc : new Error(String(exc));
      this.assistant.emit("system", `engine error (recovered): ${e.name}: ${e.message}`);
      this.rebuildTelemetry();
    } catch {
      return;
    }
  }

  static levelFor(ev: AssistantEvent): string {
    const kind = ev.kind;
    const msg = ev.msg.toLowerCase();
    const words = ["failed", "unavailable", "stopped", "deaf", "near-silence", "lost", "aborted", "could not restart"];
    if (words.some((w) => msg.includes(w))) {
      return msg.includes("deaf") || msg.includes("stopped") ? "critical" : "warn";
    }
    if (kind === "vocal" || kind === "balance") return "info";
    if (["feedback", "manual", "show", "calibration", "advisor"].includes(kind)) return "notice";
    if (kind === "clip") return msg.includes("near clip") ? "warn" : "info";
    return "info";
  }

  protected onEventHandler(ev: AssistantEvent): void {
    const now = this.clock.monotonic();
    ev.level = EngineBase.levelFor(ev);
    if (ev.kind === "feedback" && ev.ch !== null) this.lastNotchT.set(ev.ch, now);
    if (ev.kind === "clip" && ev.ch !== null && ev.msg.includes("near clip")) this.lastClipT.set(ev.ch, now);
    this.events.push(ev);
    if (this.events.length > 120) this.events.shift();
    if (this.sessionLog !== null) this.sessionLog.logEvent(ev);
  }

  setConsoleMeters(vals: readonly number[]): void {
    this.meterCount = vals.length;
    this.meterPackets += 1;
    this.lastRxT = this.clock.monotonic();
  }

  protected outputLevels(): Map<number, number> {
    return new Map([...this.feat].map(([ch, f]) => [ch, f.rmsDbfs]));
  }

  protected channelTelemetry(now: number): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const [ch, roleName] of C.CHANNELS) {
      const feat = this.feat.get(ch);
      const rms = feat ? feat.rmsDbfs : -90;
      const peak = feat ? feat.peakDbfs : -90;
      const streak = this.assistant.fbStreak.get(ch) ?? 0;
      const notchedRecent = now - (this.lastNotchT.get(ch) ?? NEG_INF) < 2.0;
      const clipRecent = now - (this.lastClipT.get(ch) ?? NEG_INF) < 1.5;
      const fbState = notchedRecent ? "notched" : streak >= 2 ? "building" : "ok";
      const notchFreqs = this.con instanceof SimConsole ? this.con.notchFreqs(ch) : [];
      const label = C.ROLE_LABELS.get(roleName);
      if (label === undefined) throw new Error(`unknown role ${roleName}`);
      const fader = this.assistant.faderDb.get(ch);
      const gain = this.assistant.gainDb.get(ch);
      const nominal = this.assistant.nominalGain.get(ch);
      if (fader === undefined || gain === undefined || nominal === undefined) throw new Error(`unknown channel ${ch}`);
      out.push({
        ch,
        role: roleName,
        label,
        rms: roundTo(rms, 1),
        peak: roundTo(peak, 1),
        fader: roundTo(fader, 1),
        gain: roundTo(gain, 1),
        fb_state: fbState,
        fb_streak: streak,
        notch_freqs: notchFreqs.map((f) => roundHalfEven(f)),
        clip_recent: clipRecent,
        gain_trimmed: gain < nominal - 0.1,
        muted: this.muted.get(ch) ?? false,
        manual_hold: now < (this.assistant.manualHoldUntil.get(ch) ?? -1e9),
        is_meas: ch === C.MEAS_MIC_CH,
        is_lead: ch === C.LEAD_VOCAL_CH,
        is_balance: C.BALANCE_CHANNELS.includes(ch),
        in_mix: ch !== C.MEAS_MIC_CH,
      });
    }
    return out;
  }

  static readonly OPENING_BARS = 8;
  static readonly DEAD_CRITICAL_S = 1.5;

  protected inOpeningBars(now: number): boolean {
    if (!this.show.playing || this.songStartT < 0) return false;
    const bpm = this.show.bpm;
    if (typeof bpm === "number" && bpm > 0) {
      const secPerBar = (4.0 * 60.0) / bpm;
      return now - this.songStartT < EngineBase.OPENING_BARS * secPerBar;
    }
    return now - this.songStartT < 16.0;
  }

  protected alertsAndMode(now: number, connected: boolean): [Alert[], string] {
    let alerts: Alert[] = [];
    const cap = this.source ? this.source.status() : { kind: "none" };
    const dead = Boolean(cap["dead"]);
    if (dead && this.deadSince < 0) this.deadSince = now;
    else if (!dead) this.deadSince = -1e9;
    if (dead && now - this.deadSince > EngineBase.DEAD_CRITICAL_S) {
      alerts.push({ level: "critical", msg: "audio capture stopped — the assistant is deaf (check the interface is connected)" });
    } else if (dead) {
      alerts.push({ level: "warn", msg: "audio dropout — recovering…" });
    } else if (cap["silent"]) {
      alerts.push({
        level: "warn",
        msg: "inputs are silent — check Microphone permission (macOS), input gain, and the audio patch",
      });
    } else if (cap["overload"]) {
      alerts.push({ level: "warn", msg: "audio interface is dropping samples (xruns) — raise the device buffer size" });
    } else if (cap["skipping"]) {
      alerts.push({ level: "warn", msg: "audio frames are arriving faster than the engine reads them" });
    }
    if (!this.sim && this.meterRx !== null && !connected) {
      const ip = this.con.ip;
      const where = ip ? ` from ${ip}` : "";
      alerts.push({ level: "warn", msg: `no console feed${where} — check the console IP, network, and firewall` });
    }
    if (!this.sim && this.source === null) {
      alerts.push({ level: "notice", msg: "manual control only (no audio device selected)" });
    }
    if (this.inOpeningBars(now)) alerts = alerts.filter((a) => a.level === "critical");
    let opMode: string;
    if (this.status === "takeover") opMode = "manual";
    else if (this.status === "calibrating") opMode = "calibrating";
    else if (alerts.some((a) => a.level === "warn" || a.level === "critical")) opMode = "alert";
    else if (this.assistant.coachMode) opMode = "coach";
    else opMode = "auto";
    return [alerts, opMode];
  }

  protected sceneList(): Record<string, unknown>[] {
    const cur = this.con instanceof SimConsole ? this.con.lastScene : null;
    const out: Record<string, unknown>[] = [];
    const seen = new Set<number>();
    for (const sg of this.template.songs) {
      if (sg.scene !== null && !seen.has(sg.scene)) {
        seen.add(sg.scene);
        out.push({ index: sg.scene, name: sg.name, current: sg.scene === cur });
      }
    }
    return out;
  }

  protected vetBlockedReason(): string {
    if (this.vetHost === null) return "The full test is not available in this copy of the app.";
    if (this.stopped) return "The app is shutting down.";
    if (this.status === "takeover") return "Press RELEASE (top right) first. The test does not run in takeover.";
    if (this.status === "calibrating") return "Wait for calibration to finish.";
    if (this.diagStatus === "running") return "Wait for Run checks to finish.";
    return "";
  }

  protected checksBlockedReason(): string {
    if (this.stopped) return "The app is shutting down.";
    if (this.vetStatus === "running") return "Wait for the full test to finish.";
    if (this.status === "calibrating") return "Wait for calibration to finish.";
    return "";
  }

  protected vetTelemetry(): Record<string, unknown> {
    return {
      blocked: this.vetStatus === "running" ? "" : this.vetBlockedReason(),
      checksBlocked: this.checksBlockedReason(),
      status: this.vetStatus,
      done: this.vetDone,
      expected: Math.max(this.vetHost !== null && this.vetHost.console ? VET_EXPECTED_STEPS_WITH_CONSOLE : VET_EXPECTED_STEPS, this.vetDone + 1),
      title: this.vetTitle,
      available: this.vetHost !== null,
      console: this.vetHost !== null && this.vetHost.console,
      summary: this.vetOutcome !== null ? this.vetOutcome.summary : "",
      failed: this.vetOutcome !== null ? this.vetOutcome.failed : 0,
      text: this.vetOutcome !== null ? this.vetOutcome.text : "",
    };
  }

  protected refreshLiveTelemetry(): void {
    const now = this.clock.monotonic();
    const live: Telemetry = {
      status: this.status,
      enabled: { ...this.assistant.enabled },
      coach: { on: this.assistant.coachMode, recs: this.assistant.coachSnapshot(now) },
      main_muted: this.con instanceof SimConsole ? this.con.mainMuted : false,
      diagnostics: { status: this.diagStatus, report: this.diagReport },
      vet: this.vetTelemetry(),
      log: this.events.slice(-40).reverse(),
    };
    try {
      const [alerts, opMode] = this.alertsAndMode(now, now - this.lastRxT < 5.0);
      live["alerts"] = alerts;
      live["op_mode"] = opMode;
    } catch {
      live["op_mode"] = this.status === "takeover" ? "manual" : this.telemetry["op_mode"];
    }
    this.telemetry = { ...this.telemetry, ...live };
  }

  protected rebuildTelemetry(): void {
    if (this.telemetryFrozen) {
      this.refreshLiveTelemetry();
      return;
    }
    const now = this.clock.monotonic();
    const lead = C.LEAD_VOCAL_CH;
    const inEma = this.assistant.inEma.get(lead) ?? null;
    const leadFader = this.assistant.faderDb.get(lead);
    if (leadFader === undefined) throw new Error(`unknown channel ${lead}`);
    const leadOut = inEma !== null ? inEma + leadFader : null;
    const connected = now - this.lastRxT < 5.0;
    const [alerts, opMode] = this.alertsAndMode(now, connected);
    const a = this.assistant;
    const r1 = (v: number): number => roundTo(v, 1);
    const eqOut: Record<string, unknown> = {};
    for (const [c, bands] of this.eq) {
      eqOut[String(c)] = [...bands.entries()]
        .sort((x, y) => x[0] - y[0])
        .map(([b, bd]) => ({ band: b, hz: roundHalfEven(bd.hz), gain: r1(bd.gain), q: r1(bd.q), on: bd.on }));
    }
    const sendsOut: Record<string, Record<string, number>> = {};
    for (const [c, m] of this.sends) sendsOut[String(c)] = Object.fromEntries([...m].map(([fx, v]) => [String(fx), r1(v)]));
    const polarity: Record<string, boolean> = {};
    for (const c of C.CHANNELS.keys()) polarity[String(c)] = a.polarity.get(c) ?? false;
    const venueModel = this.venueModel;
    this.telemetry = {
      status: this.status,
      op_mode: opMode,
      alerts,
      scenes: this.sceneList(),
      mode: this.sim ? "simulation" : "live-hardware",
      capture: this.source ? this.source.status() : { kind: "none" },
      console: this.consoleTelemetry(connected),
      uptime: r1(now - this.t0),
      perf: { ...this.perf },
      latency: Object.fromEntries([...this.latency].map(([k, v]) => [k, { ...v }])),
      block_ms: r1((C.BLOCK / C.SAMPLE_RATE) * 1000),
      room: { level_db: r1(a.roomLevelDb), contrast_db: r1(a.roomContrastDb), confidence: a.roomConfidence },
      enabled: { ...a.enabled },
      coach: { on: a.coachMode, recs: a.coachSnapshot(now) },
      phase: {
        enabled: a.enabled["phase"] ?? false,
        pairs: [...a.phaseStatus.values()],
        polarity,
      },
      unmask: {
        enabled: a.enabled["unmask"] ?? false,
        duck_db: r1(a.duckGain),
        freq: roundHalfEven(C.UNMASK_FREQ),
        channels: [...a.unmaskTargets()],
      },
      main_muted: this.con instanceof SimConsole ? this.con.mainMuted : false,
      master: { fader: r1(this.masterDb) },
      eq: eqOut,
      sends: sendsOut,
      fx: {
        buses: Object.fromEntries([...C.FX_BUSES].map(([k, v]) => [String(k), v])),
        wet: Object.fromEntries([...this.fxWet].map(([k, v]) => [String(k), r1(v)])),
      },
      show: { ...this.show },
      advisor: this.advisorAdvice ? { ...this.advisorAdvice } : null,
      advisor_on: this.advisor !== null && this.advisor.available,
      venue: venueModel
        ? {
            name: this.venue,
            shows: venueModel.shows,
            confidence: venueModel.confidence,
            freqs: venueModel.feedback_freqs.map((f) => f.hz),
          }
        : null,
      lead: {
        target: r1(a.leadTarget),
        input: inEma !== null ? r1(inEma) : null,
        output: leadOut !== null ? r1(leadOut) : null,
      },
      balance_targets: Object.fromEntries([...a.balanceTargets].map(([c, v]) => [String(c), r1(v)])),
      calibration: {
        status: this.calibStatus,
        baseline: this.calib ? [...this.calib.baseline].map(([k, v]) => ({ hz: k, db: r1(v) })) : [],
        watchlist: this.calib ? this.calib.watchlist.map(([f, e]) => ({ hz: roundHalfEven(f), excess: e })) : [],
        corrections: this.calib ? this.calib.corrections.map(([f, c]) => ({ hz: roundHalfEven(f), cut: c })) : [],
      },
      diagnostics: { status: this.diagStatus, report: this.diagReport },
      vet: this.vetTelemetry(),
      channels: this.channelTelemetry(now),
      log: this.events.slice(-40).reverse(),
    };
  }

  snapshot(): Telemetry {
    return this.telemetry;
  }
}
