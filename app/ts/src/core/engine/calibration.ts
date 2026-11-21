import { C } from "../config.ts";
import { generatePinkNoise } from "../dsp.ts";
import type { Samples } from "../dsp.ts";
import type { CalibrationResult } from "../calibration.ts";
import { watchFreqs } from "../calibration.ts";
import { fixed } from "../pyfmt.ts";
import { EngineShow } from "./show.ts";

export class EngineCalibration extends EngineShow {
  calibrationTask: Promise<void> | null = null;

  runCalibration(): void {
    if (this.calibStatus === "running" || this.status === "takeover") return;
    this.calibStatus = "running";
    this.status = "calibrating";
    this.assistant.emit("calibration", "pink-noise sweep — emitting & capturing…");
    this.rebuildTelemetry();
    this.calibrationTask = this.calibrateWorker().catch((exc: unknown) => this.noteError(exc));
  }

  protected async calibrateWorker(): Promise<void> {
    await this.clock.sleep(1.2);
    let capture: Samples | null = null;
    let played = true;
    if (this.source !== null) {
      played = await this.source.emitPinkNoise(generatePinkNoise(C.CAL_DURATION_S, this.noiseRng));
      capture = await this.source.captureMeas(C.CAL_DURATION_S);
    }
    let res: CalibrationResult | null = null;
    let silent = false;
    let levelDb: number | null = null;
    if (capture !== null && capture.length) {
      let sumSq = 0;
      for (let i = 0; i < capture.length; i++) sumSq += capture[i]! * capture[i]!;
      const rms = Math.sqrt(sumSq / capture.length);
      levelDb = 20.0 * Math.log10(rms + 1e-9);
      if (rms < 10 ** (-50.0 / 20.0)) silent = true;
      else res = this.calibrator.analyze(capture);
    }
    if (this.status === "takeover") {
      this.calibStatus = "none";
      this.assistant.emit("calibration", "calibration aborted — takeover engaged");
      this.rebuildTelemetry();
      return;
    }
    if (silent) {
      this.calibStatus = "none";
      if (this.status === "calibrating") this.status = "live";
      const hint = !played
        ? "the test tone could not be played — check the output device"
        : "raise the mic gain / speaker level or move the mic closer";
      const lvl = levelDb !== null ? `${fixed(levelDb, 0)} dBFS` : "silence";
      this.assistant.emit("calibration", `calibration heard only ${lvl} at the mic (needs > -50 dBFS) — ${hint}`);
      this.rebuildTelemetry();
      return;
    }
    if (res === null) {
      this.calibStatus = "none";
      if (this.status === "calibrating") this.status = "live";
      const msg =
        this.source !== null
          ? "couldn't read the measurement mic (no audio captured) — check --audio-device and Windows microphone access"
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
