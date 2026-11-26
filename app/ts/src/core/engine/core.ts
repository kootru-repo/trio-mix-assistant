import { CaptureError } from "../capture.ts";
import { C } from "../config.ts";
import { currentAnalysisConfig } from "../blockanalysis.ts";
import type { AnalysedBlock } from "../blockanalysis.ts";
import { LevelWindow, audioFacts, buildReport } from "../diagnostics.ts";
import type { AudioFacts, ConsoleFacts } from "../diagnostics.ts";
import type { VetRequest } from "../ports.ts";
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
        this.enterHold("no-feedback");
      }
    }
    this.con.subscribeMeters();
    if (this.meterRx !== null) this.startLink(this.clock.monotonic());
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
    this.vetAbort = true;
    const vetTask = this.vetTask;
    if (vetTask !== null) await Promise.race([vetTask.catch(() => undefined), this.clock.sleep(10)]);
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
      this.tickHold(now);
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
        if (!this.held) this.assistant.onFeatures(ch, feat, now);
      } catch (exc) {
        this.noteError(exc);
      }
    }
    if (!this.assistant.enabled["phase"] || this.held) return;
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

  async runDiagnostics(windowS: number = Engine.DIAG_WINDOW_S, identify: boolean = false): Promise<void> {
    if (this.diagStatus === "running" || this.stopped) return;
    if (this.vetBusy("checks")) return;
    const host = this.diagHost !== null ? this.diagHost(identify) : null;
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
        ...(host.scrub !== undefined ? { scrub: host.scrub } : {}),
      });
      settle(`checks finished: ${this.diagReport.summary}`);
    } catch (exc) {
      this.noteError(exc);
      settle(null);
    }
  }

  private currentStatus(): string {
    return this.status;
  }

  private stateLines(jobs: Record<string, boolean>, identify: boolean): string[] {
    const compact = (v: unknown): string => {
      try {
        return JSON.stringify(v) ?? "none";
      } catch {
        return "unreadable";
      }
    };
    const t = this.telemetry;
    const out = [
      "",
      "  App state when the test finished",
      `    Mode: ${this.sim ? "simulation" : "live-hardware"}, ${this.currentStatus()}`,
      `    Automatic jobs before the test: ${Object.entries(jobs).map(([k, v]) => `${k} ${v ? "on" : "off"}`).join(", ")}`,
      `    Audio input: ${compact(this.source ? this.source.status() : { kind: "none" })}`,
      `    Console feed: ${compact(t["console"])}`,
      `    Loop timing: ${compact(t["perf"])}`,
      `    Detect to actuate: ${compact(t["latency"])}`,
      `    Room: ${compact(t["room"])}`,
      "    Recent decision log (newest first):",
    ];
    for (const e of this.events.slice(-40).reverse()) out.push(`      ${e.time} ${e.kind}${e.ch !== null ? ` ch${e.ch}` : ""}: ${e.kind === "show" && !identify ? "(song and scene details hidden)" : e.msg}`);
    out.push("", "  Latest Run checks report (audio input, console feed, network)");
    if (this.diagReport === null) out.push("    Run checks has not been run since the app started. Press Run checks in Settings and send its report as well.");
    else for (const l of this.diagReport.text.split("\n")) out.push(`    ${l}`);
    return out;
  }

  async runVet(req: VetRequest): Promise<void> {
    const host = this.vetHost;
    if (host === null || this.vetStatus === "running" || this.stopped) return;
    const refuse = (why: string): void => {
      this.assistant.emit("system", `the full test did not start: ${why}`);
      this.rebuildTelemetry();
    };
    const blocked = this.vetBlockedReason();
    if (blocked !== "") return refuse(blocked);
    if ((req.channel !== null || req.main) && !host.console) return refuse("there is no real console connected to test");
    const held = { ...this.assistant.enabled };
    for (const k of Object.keys(this.assistant.enabled)) this.assistant.enabled[k] = false;
    this.vetOutcome = null;
    this.vetError = "";
    this.vetAbort = false;
    this.vetDone = 0;
    this.vetTitle = "Starting";
    this.vetStatus = "running";
    this.assistant.emit("system", "full test running: the automatic jobs are paused and other controls are ignored until it finishes (TAKEOVER still works)");
    this.rebuildTelemetry();
    this.telemetryFrozen = true;
    const control = {
      stopped: () => this.vetAbort || this.stopped,
      takeover: () => this.currentStatus() === "takeover",
      appState: (): string[] => this.stateLines(held, req.identify),
      progress: (done: number, title: string): void => {
        this.vetDone = done;
        this.vetTitle = title;
        this.rebuildTelemetry();
      },
    };
    const task = (async (): Promise<void> => {
      try {
        const outcome = await host.run(req, control);
        this.vetOutcome = outcome;
        this.assistant.emit("system", `full test finished: ${outcome.summary}`);
      } catch (exc) {
        this.noteError(exc);
        const e = exc instanceof Error ? exc : new Error(String(exc));
        this.vetError = `${e.name}: ${e.message}${e.stack !== undefined ? "\n" + e.stack.split("\n").slice(1, 4).join("\n") : ""}`;
        this.assistant.emit("system", `the full test stopped on an unexpected error: ${e.name}: ${e.message}`);
      } finally {
        if (this.currentStatus() === "takeover") this.enabledBackup = { ...held };
        else Object.assign(this.assistant.enabled, held);
        this.vetStatus = this.vetOutcome !== null ? "done" : "idle";
        if (this.link !== null && !this.stopped) this.beginSync(this.clock.monotonic());
        this.vetTitle = "";
        this.telemetryFrozen = false;
        const song = this.pendingSong;
        this.pendingSong = null;
        if (song !== null && !this.stopped) this.onSongChange(song);
        this.rebuildTelemetry();
      }
    })();
    this.vetTask = task;
    await task;
    this.vetTask = null;
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
      else if (t === "diagnose") void this.runDiagnostics(Engine.DIAG_WINDOW_S, Object.hasOwn(d, "identify") && d["identify"] !== null ? bool("identify") : false);
      else if (t === "vet") {
        const channel = Object.hasOwn(d, "channel") && d["channel"] !== null ? int("channel") : null;
        if (channel !== null && (channel < 1 || channel > 32)) throw new BadCommand("channel must be 1 to 32");
        const flag = (k: string): boolean => (Object.hasOwn(d, k) && d[k] !== null ? bool(k) : false);
        void this.runVet({ channel, gain: flag("gain"), main: flag("main"), identify: flag("identify") });
      }
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
