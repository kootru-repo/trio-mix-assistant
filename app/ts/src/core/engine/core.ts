import { CaptureError } from "../capture.ts";
import { C } from "../config.ts";
import { currentAnalysisConfig } from "../blockanalysis.ts";
import type { AnalysedBlock } from "../blockanalysis.ts";
import { LevelWindow, audioFacts, buildReport } from "../diagnostics.ts";
import type { AudioFacts, ConsoleFacts } from "../diagnostics.ts";
import { asBool, intOf, numOf } from "./base.ts";
import { EngineCalibration } from "./calibration.ts";

class BadCommand extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadCommand";
  }
}

const parsed = <T>(read: () => T): T => {
  try {
    return read();
  } catch (exc) {
    if (exc instanceof TypeError || exc instanceof RangeError) throw new BadCommand(exc.message);
    throw exc;
  }
};

const isRecord = (d: unknown): d is Record<string, unknown> => typeof d === "object" && d !== null && !Array.isArray(d);

export class Engine extends EngineCalibration {
  private running = false;
  private loopGen = 0;

  async start(): Promise<void> {
    if (this.running) return;
    if (this.meterRx !== null) {
      try {
        await this.meterRx.start();
      } catch (exc) {
        const name = exc instanceof Error ? exc.name : "Error";
        this.assistant.emit(
          "system",
          `meter port busy (${name}) — console fader moves won't sync (another instance running?)`,
        );
        this.rebuildTelemetry();
        this.meterRx = null;
      }
    }
    this.con.subscribeMeters();
    if (this.source !== null) {
      if (this.source.subscribe) {
        this.pushed = true;
        this.source.subscribe((block, ageS) => this.onPushedBlock(block, ageS));
      }
      try {
        this.source.start();
        if (this.source.ready) await this.source.ready();
        const st = this.source.status();
        if (st["name"]) {
          this.assistant.emit("system", `listening on '${String(st["name"])}' (${String(st["channels"])} ch)`);
          this.rebuildTelemetry();
        }
      } catch (exc) {
        const detail = exc instanceof CaptureError ? exc.message : `${exc instanceof Error ? exc.name : "Error"}: ${String(exc instanceof Error ? exc.message : exc)}`;
        this.assistant.emit("system", `audio capture off — ${detail} — retrying`);
        this.rebuildTelemetry();
      }
    } else {
      this.assistant.emit("system", "no audio capture configured — automatic jobs inactive (manual mixing + scene recall only)");
      this.rebuildTelemetry();
    }
    this.stopped = false;
    this.running = true;
    const gen = ++this.loopGen;
    void this.run(gen);
    if (this.meterRx !== null) void this.renew(gen);
    if (this.showClock !== null) {
      try {
        await this.showClock.start();
      } catch (exc) {
        const name = exc instanceof Error ? exc.name : "Error";
        this.assistant.emit("system", `show clock unavailable (${name}) — scenes won't recall automatically`);
        this.rebuildTelemetry();
        this.showClock = null;
      }
    }
    if (this.advisor !== null && this.advisor.start()) {
      this.assistant.emit("system", "Claude advisor active (advisory notes only)");
      this.rebuildTelemetry();
    }
  }

  private async renew(gen: number): Promise<void> {
    while (!this.stopped && gen === this.loopGen) {
      await this.clock.sleep(8.0);
      if (this.stopped || gen !== this.loopGen) return;
      try {
        this.con.subscribeMeters();
      } catch {
        continue;
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    this.loopGen++;
    if (this.advisor !== null) this.advisor.stop();
    if (this.showClock !== null) this.showClock.stop();
    if (this.meterRx !== null) this.meterRx.stop();
    if (this.source !== null) {
      this.source.stop();
      if (this.source.settled) await this.source.settled();
    }
    if (this.sessionLog !== null) {
      await this.learnVenue();
      this.sessionLog.close();
    }
    this.con.close();
  }

  private async run(gen: number): Promise<void> {
    let nextT = this.clock.monotonic();
    let lastNow = this.clock.monotonic();
    while (!this.stopped && gen === this.loopGen) {
      const now = this.clock.monotonic();
      this.step(now, lastNow);
      lastNow = now;
      nextT += this.tick;
      await this.clock.sleep(Math.max(0, nextT - this.clock.monotonic()));
    }
  }

  step(now: number, lastNow: number): void {
    try {
      if (this.source !== null && !this.pushed && this.status !== "calibrating") {
        const frame = this.source.block();
        this.assistant.blockT0 = this.clock.highResolution();
        const wantPhases = Boolean(this.assistant.enabled["phase"]);
        this.consume(this.analyser.analyse(frame, currentAnalysisConfig(), (exc) => this.noteError(exc), wantPhases), now);
      }
      this.notePerf(now, lastNow);
      this.rebuildTelemetry();
      void this.recoverAudio(now);
    } catch (exc) {
      this.noteError(exc);
    }
  }

  private consume(block: AnalysedBlock, now: number): void {
    if (this.diagWindow !== null) this.diagWindow.add(block);
    for (const [ch, feat] of block.feats) {
      if (!C.CHANNELS.has(ch)) continue;
      try {
        this.feat.set(ch, feat);
        this.assistant.onFeatures(ch, feat, now);
      } catch (exc) {
        this.noteError(exc);
      }
    }
    if (!this.assistant.enabled["phase"]) return;
    for (const p of block.phases) this.assistant.handlePhase(p.a, p.b, p.relation, now);
  }

  onPushedBlock(block: AnalysedBlock, ageS: number): void {
    if (this.stopped || this.status === "calibrating") return;
    try {
      const age = Math.max(0, ageS);
      this.assistant.blockT0 = this.clock.highResolution() - age;
      this.consume(block, this.clock.monotonic() - age);
    } catch (exc) {
      this.noteError(exc);
    }
  }

  static readonly DIAG_WINDOW_S = 8.0;

  async runDiagnostics(windowS: number = Engine.DIAG_WINDOW_S): Promise<void> {
    if (this.diagStatus === "running" || this.stopped) return;
    const host = this.diagHost !== null ? this.diagHost() : null;
    if (host === null) return;
    if (this.status === "calibrating") {
      this.assistant.emit("system", "checks cannot run during calibration — run them again when it finishes");
      this.rebuildTelemetry();
      return;
    }
    const settle = (message: string | null): void => {
      this.diagWindow = null;
      this.diagStatus = this.diagReport !== null ? "done" : "idle";
      if (message !== null) this.assistant.emit("system", message);
      this.rebuildTelemetry();
    };
    this.diagStatus = "running";
    this.rebuildTelemetry();
    try {
      const window = new LevelWindow();
      const source = this.sim ? null : this.source;
      const before = source !== null ? source.status() : {};
      const packets = this.meterPackets;
      const t0 = this.clock.monotonic();
      this.diagWindow = window;
      await this.clock.sleep(windowS);
      this.diagWindow = null;
      if (this.stopped) return settle(null);
      if (this.status === "calibrating") return settle("checks were interrupted by calibration — run them again when it finishes");
      const elapsed = Math.max(this.clock.monotonic() - t0, 1e-3);
      const labels = new Map([...C.CHANNELS].map(([ch, role]) => [ch, C.ROLE_LABELS.get(role) ?? role]));
      let audio: AudioFacts | null = null;
      let skipped = host.audioSkipped ?? "";
      if (this.sim) skipped = "simulation mode uses a built-in stage, so no real input is opened";
      else if (source === null) skipped = "no audio input is selected (manual control only)";
      else if (host.audioSkipped === null) {
        audio = audioFacts(before, source.status(), window, elapsed, C.SAMPLE_RATE / C.BLOCK, labels, host.mappedChannels);
      }
      const con: ConsoleFacts | null = this.sim
        ? null
        : {
            emulated: host.consoleEmulated,
            address: this.con.ip ?? "the console",
            listening: this.meterRx !== null,
            listenError: null,
            windowS: elapsed,
            packets: this.meterPackets - packets,
            meters: this.meterCount,
          };
      this.diagReport = buildReport({
        app: host.app,
        system: host.system,
        platform: host.platform,
        home: host.home,
        mode: host.mode,
        audioModule: host.audioModule,
        audio,
        audioSkipped: skipped,
        console: con,
        network: host.network,
      });
      settle(`checks finished: ${this.diagReport.summary}`);
    } catch (exc) {
      this.noteError(exc);
      settle(null);
    }
  }

  static readonly AUDIO_RESTART_S = 3.0;

  private async recoverAudio(now: number): Promise<void> {
    if (this.stopped) return;
    const src = this.source;
    if (src === null || !src.dead()) return;
    if (now - this.lastAudioRestart < Engine.AUDIO_RESTART_S) return;
    this.lastAudioRestart = now;
    let recovered = false;
    let reason: string | null = null;
    try {
      recovered = await src.restart();
    } catch (exc) {
      recovered = false;
      reason = exc instanceof Error ? exc.message : String(exc);
    }
    if (recovered) {
      this.lastAudioFailure = null;
      this.assistant.emit("system", "audio capture recovered — listening again");
      this.rebuildTelemetry();
      return;
    }
    if (reason === null) {
      const last = src.status()["lastError"];
      reason = typeof last === "string" && last ? last : "the audio device could not be re-opened";
    }
    const msg = `audio capture could not restart: ${reason}`;
    if (msg === this.lastAudioFailure) return;
    this.lastAudioFailure = msg;
    this.assistant.emit("system", msg);
    this.rebuildTelemetry();
  }

  command(d: unknown): void {
    if (!isRecord(d)) return;
    const t = d["type"];
    const need = (k: string): unknown => {
      if (!Object.hasOwn(d, k)) throw new BadCommand(`missing ${k}`);
      return d[k];
    };
    const int = (k: string): number => parsed(() => intOf(need(k)));
    const num = (k: string): number => parsed(() => numOf(need(k)));
    const bool = (k: string): boolean => parsed(() => asBool(need(k)));
    try {
      if (t === "fader") this.setFader(int("ch"), num("db"));
      else if (t === "mute") this.setMute(int("ch"), bool("on"));
      else if (t === "master") this.setMaster(num("db"));
      else if (t === "toggle") this.setEnabled(String(need("job")), bool("on"));
      else if (t === "coach") this.setCoachMode(bool("on"));
      else if (t === "panic") this.panic(bool("on"));
      else if (t === "calibrate") this.runCalibration();
      else if (t === "diagnose") void this.runDiagnostics();
      else if (t === "lead_target") this.setLeadTarget(num("db"));
      else if (t === "balance_capture") this.captureBalanceNow();
      else if (t === "reset_notches") this.resetNotches();
      else if (t === "scene") this.recallSceneManual(need("index"));
      else if (t === "eq") this.setEq(int("ch"), int("band"), d["hz"] ?? null, d["gain"] ?? null, d["q"] ?? null, d["on"] ?? null);
      else if (t === "eq_reset") this.resetChannelEq(int("ch"));
      else if (t === "send") this.setSend(int("ch"), int("fx"), num("db"));
      else if (t === "fx") this.setFxWet(int("fx"), num("db"));
    } catch (exc) {
      if (exc instanceof BadCommand) return;
      this.noteError(exc);
    }
  }
}
