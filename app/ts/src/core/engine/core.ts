import { CaptureError } from "../capture.ts";
import { C } from "../config.ts";
import { analyseBlock, phaseRelation } from "../dsp.ts";
import { intOf, numOf, truthy } from "./base.ts";
import { EngineCalibration } from "./calibration.ts";

const isRecord = (d: unknown): d is Record<string, unknown> => typeof d === "object" && d !== null && !Array.isArray(d);

export class Engine extends EngineCalibration {
  private loop: Promise<void> | null = null;
  private renewLoop: Promise<void> | null = null;
  private running = false;

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
      try {
        this.source.start();
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
    this.loop = this.run();
    if (this.meterRx !== null) this.renewLoop = this.renew();
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

  private async renew(): Promise<void> {
    while (!this.stopped) {
      await this.clock.sleep(8.0);
      if (this.stopped) return;
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
    if (this.advisor !== null) this.advisor.stop();
    if (this.showClock !== null) this.showClock.stop();
    if (this.meterRx !== null) this.meterRx.stop();
    if (this.source !== null) this.source.stop();
    if (this.sessionLog !== null) {
      await this.learnVenue();
      this.sessionLog.close();
    }
    this.con.close();
  }

  loopsDone(): Promise<void> {
    return Promise.all([this.loop, this.renewLoop]).then(() => undefined);
  }

  private async run(): Promise<void> {
    let nextT = this.clock.monotonic();
    let lastNow = this.clock.monotonic();
    while (!this.stopped) {
      const now = this.clock.monotonic();
      this.step(now, lastNow);
      lastNow = now;
      nextT += this.tick;
      await this.clock.sleep(Math.max(0, nextT - this.clock.monotonic()));
    }
  }

  step(now: number, lastNow: number): void {
    try {
      if (this.source !== null && this.status !== "calibrating") {
        const frame = this.source.block();
        this.assistant.blockT0 = this.clock.perfCounter();
        for (const [ch, samples] of frame) {
          const feat = analyseBlock(samples);
          if (ch === C.MEAS_MIC_CH) {
            const [fbFreq, harmonicity] = this.measRing.update(samples);
            feat.fbFreq = fbFreq;
            feat.harmonicity = harmonicity;
          }
          this.feat.set(ch, feat);
          this.assistant.onFeatures(ch, feat, now);
        }
        if (this.assistant.enabled["phase"]) {
          for (const [pa, pb] of C.PHASE_PAIRS) {
            const sa = frame.get(pa!);
            const sb = frame.get(pb!);
            if (sa !== undefined && sb !== undefined) this.assistant.handlePhase(pa!, pb!, phaseRelation(sa, sb), now);
          }
        }
      }
      this.notePerf(now, lastNow);
      this.rebuildTelemetry();
      void this.recoverAudio(now);
    } catch (exc) {
      this.noteError(exc);
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
    try {
      recovered = await src.restart();
    } catch {
      recovered = false;
    }
    if (recovered) {
      this.assistant.emit("system", "audio capture recovered — listening again");
      this.rebuildTelemetry();
    }
  }

  command(d: unknown): void {
    if (!isRecord(d)) return;
    const t = d["type"];
    try {
      const need = (k: string): unknown => {
        if (!(k in d)) throw new RangeError(`missing ${k}`);
        return d[k];
      };
      if (t === "fader") this.setFader(intOf(need("ch")), numOf(need("db")));
      else if (t === "mute") this.setMute(intOf(need("ch")), truthy(need("on")));
      else if (t === "master") this.setMaster(numOf(need("db")));
      else if (t === "toggle") this.setEnabled(String(need("job")), truthy(need("on")));
      else if (t === "coach") this.setCoachMode(truthy(need("on")));
      else if (t === "panic") this.panic(truthy(need("on")));
      else if (t === "calibrate") this.runCalibration();
      else if (t === "lead_target") this.setLeadTarget(numOf(need("db")));
      else if (t === "balance_capture") this.captureBalanceNow();
      else if (t === "reset_notches") this.resetNotches();
      else if (t === "scene") this.recallSceneManual(need("index"));
      else if (t === "eq") {
        this.setEq(intOf(need("ch")), intOf(need("band")), d["hz"] ?? null, d["gain"] ?? null, d["q"] ?? null, d["on"] ?? null);
      } else if (t === "eq_reset") this.resetChannelEq(intOf(need("ch")));
      else if (t === "send") this.setSend(intOf(need("ch")), intOf(need("fx")), numOf(need("db")));
      else if (t === "fx") this.setFxWet(intOf(need("fx")), numOf(need("db")));
    } catch (exc) {
      if (exc instanceof TypeError || exc instanceof RangeError) return;
      throw exc;
    }
  }
}
