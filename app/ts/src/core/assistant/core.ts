import type { CalibrationResult, CalibrationStep } from "../calibration.ts";
import type { Clock } from "../clock.ts";
import { C } from "../config.ts";
import type { Config } from "../config.ts";
import type { ChannelFeatures, PhaseRelation } from "../dsp.ts";
import type { AssistantEvent, CoachRec, EventHandler, LatencyHandler } from "./base.ts";
import { PhaseJob, UnmaskJob } from "./clarity.ts";
import type { PhaseStatus } from "./clarity.ts";
import { ClipJob } from "./clip.ts";
import { Coach } from "./coach.ts";
import { MixState, roleOf } from "./context.ts";
import type { JobContext, MixerPort } from "./context.ts";
import { FeedbackJob } from "./feedback.ts";
import { RideJob } from "./ride.ts";
import { RoomModel, StageJob } from "./room.ts";

export interface AssistantOptions {
  onEvent?: EventHandler | null;
  onLatency?: LatencyHandler | null;
  config?: Config;
}

export class MixAssistant {
  readonly cfg: Config;
  readonly clock: Clock;
  readonly con: MixerPort;
  onEvent: EventHandler | null;
  onLatency: LatencyHandler | null;
  blockT0 = 0;
  calib: CalibrationResult | null = null;

  readonly state: MixState;
  readonly coach: Coach;
  readonly feedback: FeedbackJob;
  readonly clip: ClipJob;
  readonly ride: RideJob;
  readonly room: RoomModel;
  readonly stage: StageJob;
  readonly phase: PhaseJob;
  readonly unmask: UnmaskJob;

  constructor(console: MixerPort, clock: Clock, opts: AssistantOptions = {}) {
    this.cfg = opts.config ?? C;
    this.clock = clock;
    this.con = console;
    this.onEvent = opts.onEvent ?? null;
    this.onLatency = opts.onLatency ?? null;
    this.state = new MixState(this.cfg);
    this.coach = new Coach(this.cfg, clock, (kind, msg, ch) => this.emit(kind, msg, ch));
    const ctx: JobContext = {
      cfg: this.cfg,
      mixer: console,
      state: this.state,
      coaching: () => this.coach.coachMode,
      emit: (kind, msg, ch = null) => this.emit(kind, msg, ch),
      recommend: (kind, ch, text, persist = false, meta = {}, key) => this.coach.recommend(kind, ch, text, persist, meta, key),
      noteLatency: (kind) => this.noteLatency(kind),
    };
    this.feedback = new FeedbackJob(ctx);
    this.clip = new ClipJob(ctx);
    this.ride = new RideJob(ctx);
    this.room = new RoomModel(ctx);
    this.stage = new StageJob(ctx);
    this.phase = new PhaseJob(ctx, (key) => this.coach.forget(key));
    this.unmask = new UnmaskJob(ctx);
  }

  onFeatures(ch: number, feat: ChannelFeatures, now: number): void {
    const cfg = this.cfg;
    if (ch === cfg.MEAS_MIC_CH) {
      this.room.update(feat, now);
      this.feedback.handle(ch, feat);
      return;
    }
    if (cfg.STAGE_MIC_CH !== null && ch === cfg.STAGE_MIC_CH) {
      this.stage.handle(feat, now);
      return;
    }
    this.feedback.handle(ch, feat);
    this.clip.handle(ch, feat, now);
    if (ch === cfg.LEAD_VOCAL_CH) {
      this.ride.handleVocal(feat, now);
      this.unmask.handle(feat, now);
    }
    if (cfg.BALANCE_CHANNELS.includes(ch)) this.ride.handleBalance(ch, feat, now);
  }

  emit(kind: string, msg: string, ch: number | null = null): void {
    const ev: AssistantEvent = { time: this.clock.hhmmss(), kind, ch, role: roleOf(this.cfg, ch), msg };
    if (this.onEvent) this.onEvent(ev);
  }

  noteLatency(kind: string): void {
    if (this.onLatency) this.onLatency(kind, this.clock.highResolution() - this.blockT0);
  }

  setCoachMode(on: boolean): void {
    if (on === this.coach.coachMode) return;
    this.coach.coachMode = on;
    if (on) {
      this.unmask.release();
    } else {
      this.coach.clear();
    }
    this.emit(
      "system",
      on
        ? "coach mode ON — the assistant advises every automatic move (mix " +
            "corrections, scene recall, guest mutes) instead of applying it; " +
            "only your own manual moves act"
        : "coach mode off",
    );
  }

  setCalibration(calib: CalibrationResult | null): void {
    this.calib = calib;
    this.feedback.setCalibration(calib);
  }

  recommend(kind: string, ch: number | null, text: string, persist: boolean = false, meta: Record<string, unknown> = {}): void {
    this.coach.recommend(kind, ch, text, persist, meta);
  }

  coachSnapshot(now: number | null = null): CoachRec[] {
    return this.coach.snapshot(now);
  }

  coachCalibration(steps: CalibrationStep[]): void {
    this.coach.calibration(steps);
  }

  noteManual(ch: number, now: number, hold: number = this.cfg.manual.holdS): void {
    if (!this.cfg.CHANNELS.has(ch)) return;
    this.state.manualHoldUntil.set(ch, now + hold);
  }

  handlePhase(a: number, b: number, rel: PhaseRelation, now: number): void {
    this.phase.handle(a, b, rel, now);
  }

  captureBalance(levels: Map<number, number>): void {
    this.ride.captureBalance(levels);
  }

  resetNotches(): void {
    this.feedback.resetNotches();
  }

  releaseUnmask(): void {
    this.unmask.release();
  }

  allocBusBand(): number {
    return this.feedback.allocBusBand();
  }

  get coachMode(): boolean {
    return this.coach.coachMode;
  }
  get coachRecs(): Map<string, CoachRec> {
    return this.coach.coachRecs;
  }
  get enabled(): Record<string, boolean> {
    return this.state.enabled;
  }
  get faderDb(): Map<number, number> {
    return this.state.faderDb;
  }
  get gainDb(): Map<number, number> {
    return this.state.gainDb;
  }
  get nominalGain(): Map<number, number> {
    return this.state.nominalGain;
  }
  get lastMoveT(): Map<number, number> {
    return this.state.lastMoveT;
  }
  get manualHoldUntil(): Map<number, number> {
    return this.state.manualHoldUntil;
  }
  get roomConfidence(): number {
    return this.state.roomConfidence;
  }
  get roomLevelDb(): number {
    return this.room.roomLevelDb;
  }
  get roomContrastDb(): number {
    return this.room.roomContrastDb;
  }
  get stageBaseline(): number | null {
    return this.stage.stageBaseline;
  }
  get leadTarget(): number {
    return this.ride.leadTarget;
  }
  set leadTarget(v: number) {
    this.ride.leadTarget = v;
  }
  get inEma(): Map<number, number | null> {
    return this.ride.inEma;
  }
  get balanceTargets(): Map<number, number> {
    return this.ride.balanceTargets;
  }
  get fbStreak(): Map<number, number> {
    return this.feedback.fbStreak;
  }
  get fbLastLevel(): Map<number, number> {
    return this.feedback.fbLastLevel;
  }
  get usedNotchBand(): Map<number, number> {
    return this.feedback.usedNotchBand;
  }
  get usedBusNotchBand(): number {
    return this.feedback.usedBusNotchBand;
  }
  set usedBusNotchBand(v: number) {
    this.feedback.usedBusNotchBand = v;
  }
  get fbBusBands(): number[] {
    return this.feedback.fbBusBands;
  }
  set fbBusBands(v: number[]) {
    this.feedback.fbBusBands = v;
  }
  get calBusBands(): Set<number> {
    return this.feedback.calBusBands;
  }
  set calBusBands(v: Set<number>) {
    this.feedback.calBusBands = v;
  }
  get venueWatchFreqs(): number[] {
    return this.feedback.venueWatchFreqs;
  }
  set venueWatchFreqs(v: number[]) {
    this.feedback.venueWatchFreqs = v;
  }
  get polarity(): Map<number, boolean> {
    return this.phase.polarity;
  }
  get phaseStatus(): Map<string, PhaseStatus> {
    return this.phase.phaseStatus;
  }
  get duckGain(): number {
    return this.unmask.duckGain;
  }
  get duckApplied(): Map<number, number> {
    return this.unmask.duckApplied;
  }
  get voxLevelEma(): number | null {
    return this.unmask.voxLevelEma;
  }
}
