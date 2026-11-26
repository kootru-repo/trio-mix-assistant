import { C } from "../config.ts";
import { generatePinkNoise } from "../dsp.ts";
import type { Samples } from "../dsp.ts";
import type { CalibrationResult } from "../calibration.ts";
import { watchFreqs } from "../calibration.ts";
import { fixed } from "../numfmt.ts";
import { EngineShow } from "./show.ts";

export class EngineCalibration extends EngineShow {
  calibrationTask: Promise<void> | null = null;

  runCalibration(): void {
    if (this.vetBusy("calibration")) return;
    if (this.calibStatus === "running" || this.status === "takeover") return;
    this.calibStatus = "running";
    this.status = "calibrating";
    this.assistant.emit("calibration", "pink-noise sweep — emitting & capturing…");
    this.rebuildTelemetry();
    this.calibrationTask = this.calibrateWorker().catch((exc: unknown) => {
      this.calibStatus = "none";
      if (this.status === "calibrating") this.status = "live";
      const msg = exc instanceof Error ? exc.message : String(exc);
      this.assistant.emit("calibration", `calibration failed: ${msg}`);
      this.rebuildTelemetry();
    });
  }

  private calibrationAborted(epoch: number): boolean {
    if (this.takeoverEpoch === epoch && this.status !== "takeover") return false;
    this.calibStatus = "none";
    this.assistant.emit("calibration", "calibration aborted — takeover engaged");
    this.rebuildTelemetry();
    return true;
  }

  protected async calibrateWorker(): Promise<void> {
    const epoch = this.takeoverEpoch;
    await this.clock.sleep(C.calibration.settleS);
    if (this.calibrationAborted(epoch)) return;
    let capture: Samples | null = null;
    let played = true;
    if (this.source !== null) {
      played = await this.source.emitPinkNoise(generatePinkNoise(C.calibration.durationS, this.noiseRng));
      if (this.calibrationAborted(epoch)) return;
      capture = await this.source.captureMeas(C.calibration.durationS);
    }
    if (this.calibrationAborted(epoch)) return;
    let res: CalibrationResult | null = null;
    let silent = false;
    let levelDb: number | null = null;
    if (capture !== null && capture.length) {
      let sumSq = 0;
      for (let i = 0; i < capture.length; i++) sumSq += capture[i]! * capture[i]!;
      const rms = Math.sqrt(sumSq / capture.length);
      levelDb = 20.0 * Math.log10(rms + 1e-9);
      if (rms < 10 ** (C.calibration.minLevelDbfs / 20.0)) silent = true;
      else res = this.calibrator.analyze(capture);
    }
    if (silent) {
      this.calibStatus = "none";
      if (this.status === "calibrating") this.status = "live";
      const hint = !played
        ? "the test tone could not be played — check the output device"
        : "raise the mic gain / speaker level or move the mic closer";
      const lvl = levelDb !== null ? `${fixed(levelDb, 0)} dBFS` : "silence";
      this.assistant.emit("calibration", `calibration heard only ${lvl} at the mic (needs > ${fixed(C.calibration.minLevelDbfs, 0)} dBFS) — ${hint}`);
      this.rebuildTelemetry();
      return;
    }
    if (res === null) {
      this.calibStatus = "none";
      if (this.status === "calibrating") this.status = "live";
      const msg =
        this.source !== null
          ? "couldn't read the measurement mic (no audio captured) — check --audio-device and the system's microphone permission"
          : "no audio-capture source available";
      this.assistant.emit("calibration", "calibration needs a measurement-mic input — " + msg);
      this.rebuildTelemetry();
      return;
    }
    this.calib = res;
    this.assistant.setCalibration(res);
    if (this.assistant.coachMode) {
      this.assistant.coachCalibration(this.calibrator.plan(res));
      this.assistant.emit(
        "calibration",
        `coach: measured room — ${res.corrections.length} cut(s), ${watchFreqs(res).length} watch freq(s); ` +
          "advising manual main-bus EQ (console untouched)",
      );
    } else {
      const used = this.calibrator.apply(res, (m) => this.assistant.emit("calibration", m));
      this.assistant.calBusBands = used;
      this.assistant.fbBusBands = [];
      this.assistant.usedBusNotchBand = 0;
      this.assistant.emit(
        "calibration",
        `done — ${res.corrections.length} room cut(s), ${watchFreqs(res).length} feedback-prone freq(s) on watch-list`,
      );
    }
    this.calibStatus = "done";
    if (this.status === "calibrating") this.status = "live";
    this.rebuildTelemetry();
  }
}
