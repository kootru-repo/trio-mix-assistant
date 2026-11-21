"""Pink-noise room calibration, run on a worker thread."""

from __future__ import annotations

import math
import threading

import numpy as np

from .. import config as C
from .. import dsp
from .show import EngineShow


class EngineCalibration(EngineShow):
    """Pink-noise room calibration, run on a worker thread."""

    def run_calibration(self) -> None:
        with self._lock:
            if self.calib_status == "running" or self.status == "takeover":
                return
            self.calib_status = "running"
            self.status = "calibrating"
            self.assistant._emit("calibration", "pink-noise sweep — emitting & capturing…")
            self._rebuild_telemetry()
        threading.Thread(target=self._calibrate_worker, daemon=True).start()

    def _calibrate_worker(self) -> None:
        self.clock.sleep(1.2)
        capture = None
        played = True
        if self.source is not None:
            played = self.source.emit_pink_noise(dsp.generate_pink_noise(C.CAL_DURATION_S))
            capture = self.source.capture_meas(C.CAL_DURATION_S)
        res, silent, level_db = None, False, None
        if capture is not None and capture.size:
            rms = float(np.sqrt(np.mean(np.square(capture, dtype=np.float64))))
            level_db = 20.0 * math.log10(rms + 1e-9)
            if rms < 10 ** (-50.0 / 20.0):
                silent = True
            else:
                res = self.calibrator.analyze(capture)
        with self._lock:
            if self.status == "takeover":
                self.calib_status = "none"
                self.assistant._emit("calibration", "calibration aborted — takeover engaged")
                self._rebuild_telemetry()
                return
            if silent:
                self.calib_status = "none"
                if self.status == "calibrating":
                    self.status = "live"
                hint = (
                    "the test tone could not be played — check the output device"
                    if not played
                    else "raise the mic gain / speaker level or move the mic closer"
                )
                lvl = f"{level_db:.0f} dBFS" if level_db is not None else "silence"
                self.assistant._emit(
                    "calibration",
                    f"calibration heard only {lvl} at the mic (needs > -50 dBFS) — {hint}",
                )
                self._rebuild_telemetry()
                return
            if res is None:
                self.calib_status = "none"
                if self.status == "calibrating":
                    self.status = "live"
                msg = (
                    "couldn't read the measurement mic (no audio captured) — check "
                    "--audio-device and Windows microphone access"
                    if self.source is not None
                    else "no audio-capture source available"
                )
                self.assistant._emit(
                    "calibration", "calibration needs a measurement-mic input — " + msg
                )
                self._rebuild_telemetry()
                return
            self.calib = res
            self.assistant.set_calibration(res)
            if self.assistant.coach_mode:
                self.assistant.coach_calibration(self.calibrator.plan(res))
                self.assistant._emit(
                    "calibration",
                    f"coach: measured room — {len(res.corrections)} cut(s), "
                    f"{len(res.watch_freqs)} watch freq(s); advising manual "
                    "main-bus EQ (console untouched)",
                )
            else:
                used = self.calibrator.apply(
                    res, log=lambda m: self.assistant._emit("calibration", m)
                )
                self.assistant.cal_bus_bands = used
                self.assistant.fb_bus_bands = []
                self.assistant.used_bus_notch_band = 0
                self.assistant._emit(
                    "calibration",
                    f"done — {len(res.corrections)} room cut(s), "
                    f"{len(res.watch_freqs)} feedback-prone freq(s) on watch-list",
                )
            self.calib_status = "done"
            if self.status == "calibrating":
                self.status = "live"
            self._rebuild_telemetry()
