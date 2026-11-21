"""Runtime engine: a closed-loop simulator + the live telemetry the dashboard
reads. Wires SimStage -> DSP -> MixAssistant -> Console, one block at a time.

The simulator is a genuine closed loop: feedback rings grow until the assistant
parks a notch near them; a clipping channel recovers once its preamp is trimmed;
the lead vocal's input drifts and the ride compensates. So toggling jobs in the
UI produces visibly different behaviour — which is exactly what makes it testable.
"""

from __future__ import annotations

import logging
import threading
import time

from .. import config as C
from .. import dsp
from ..capture import CaptureError
from .base import _num
from .calibration import EngineCalibration

_log = logging.getLogger(__name__)


class Engine(EngineCalibration):
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        if self.meter_rx is not None:
            try:
                self.meter_rx.start()
            except OSError as exc:
                with self._lock:
                    self.assistant._emit(
                        "system",
                        f"meter port busy ({type(exc).__name__}) — console "
                        "fader moves won't sync (another instance running?)",
                    )
                    self._rebuild_telemetry()
                self.meter_rx = None
        self.con.subscribe_meters()
        if self.source is not None:
            try:
                self.source.start()
                st = self.source.status()
                if st.get("name"):
                    with self._lock:
                        self.assistant._emit(
                            "system", f"listening on '{st['name']}' ({st.get('channels')} ch)"
                        )
                        self._rebuild_telemetry()
            except Exception as exc:
                detail = (
                    str(exc) if isinstance(exc, CaptureError) else f"{type(exc).__name__}: {exc}"
                )
                with self._lock:
                    self.assistant._emit("system", f"audio capture off — {detail} — retrying")
                    self._rebuild_telemetry()
        else:
            with self._lock:
                self.assistant._emit(
                    "system",
                    "no audio capture configured — automatic jobs "
                    "inactive (manual mixing + scene recall only)",
                )
                self._rebuild_telemetry()
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        if self.meter_rx is not None:
            self._renew_thread = threading.Thread(target=self._renew_loop, daemon=True)
            self._renew_thread.start()
        if self.show_clock is not None:
            try:
                self.show_clock.start()
            except Exception as exc:
                with self._lock:
                    self.assistant._emit(
                        "system",
                        f"show clock unavailable ({type(exc).__name__}) "
                        "— scenes won't recall automatically",
                    )
                    self._rebuild_telemetry()
                self.show_clock = None
        if self.advisor is not None and self.advisor.start():
            with self._lock:
                self.assistant._emit("system", "Claude advisor active (advisory notes only)")
                self._rebuild_telemetry()

    def _renew_loop(self) -> None:
        while not self._stop.wait(8.0):
            try:
                self.con.subscribe_meters()
            except Exception:
                _log.debug("meter subscription renewal failed", exc_info=True)

    def stop(self) -> None:
        self._stop.set()
        if self.advisor is not None:
            self.advisor.stop()
        if self.show_clock is not None:
            self.show_clock.stop()
        if self._thread:
            self._thread.join(timeout=2.0)
        if self._renew_thread:
            self._renew_thread.join(timeout=2.0)
        if self.meter_rx is not None:
            self.meter_rx.stop()
        if self.source is not None:
            self.source.stop()
        if self.session_log is not None:
            self.learn_venue()
            self.session_log.close()
        self.con.close()

    def _run(self) -> None:
        next_t = time.monotonic()
        last_now = time.monotonic()
        while not self._stop.is_set():
            now = time.monotonic()
            try:
                with self._lock:
                    if self.source is not None and self.status != "calibrating":
                        frame = self.source.block()
                        self.assistant.block_t0 = time.perf_counter()
                        for ch, samples in frame.items():
                            feat = dsp.analyse_block(samples)
                            if ch == C.MEAS_MIC_CH:
                                feat.fb_freq, feat.harmonicity = self._meas_ring.update(samples)
                            self._feat[ch] = feat
                            self.assistant.on_features(ch, feat, now)
                        if self.assistant.enabled.get("phase"):
                            for pa, pb in C.PHASE_PAIRS:
                                sa, sb = frame.get(pa), frame.get(pb)
                                if sa is not None and sb is not None:
                                    self.assistant.handle_phase(
                                        pa, pb, dsp.phase_relation(sa, sb), now
                                    )
                    self._note_perf(now, last_now)
                    self._rebuild_telemetry()
                self._recover_audio(now)
            except Exception as exc:
                self._note_error(exc)
            last_now = now
            next_t += self.tick
            time.sleep(max(0.0, next_t - time.monotonic()))

    AUDIO_RESTART_S = 3.0

    def _recover_audio(self, now: float) -> None:
        """If the audio device went dead (unplugged/wedged), try to re-open it on
        a backoff. Runs OFF the engine lock because re-opening a PortAudio stream
        can take tens of ms. The 'deaf' alert stays up until frames flow again."""
        if self._stop.is_set():
            return
        src = self.source
        if src is None or not src.dead():
            return
        if now - self._last_audio_restart < self.AUDIO_RESTART_S:
            return
        self._last_audio_restart = now
        recovered = False
        try:
            recovered = src.restart()
        except Exception:
            recovered = False
        if recovered:
            with self._lock:
                self.assistant._emit("system", "audio capture recovered — listening again")
                self._rebuild_telemetry()

    def command(self, d: object) -> None:
        """Dispatch a control message (WebSocket / POST). Tolerant of malformed
        or hostile input — a bad message is ignored, never crashes a thread."""
        if not isinstance(d, dict):
            return
        t = d.get("type")
        try:
            if t == "fader":
                self.set_fader(int(d["ch"]), _num(d["db"]))
            elif t == "mute":
                self.set_mute(int(d["ch"]), bool(d["on"]))
            elif t == "master":
                self.set_master(_num(d["db"]))
            elif t == "toggle":
                self.set_enabled(str(d["job"]), bool(d["on"]))
            elif t == "coach":
                self.set_coach_mode(bool(d["on"]))
            elif t == "panic":
                self.panic(bool(d["on"]))
            elif t == "calibrate":
                self.run_calibration()
            elif t == "lead_target":
                self.set_lead_target(_num(d["db"]))
            elif t == "balance_capture":
                self.capture_balance_now()
            elif t == "reset_notches":
                self.reset_notches()
            elif t == "scene":
                self.recall_scene_manual(d["index"])
            elif t == "eq":
                self.set_eq(
                    int(d["ch"]),
                    int(d["band"]),
                    d.get("hz"),
                    d.get("gain"),
                    d.get("q"),
                    d.get("on"),
                )
            elif t == "eq_reset":
                self.reset_channel_eq(int(d["ch"]))
            elif t == "send":
                self.set_send(int(d["ch"]), int(d["fx"]), _num(d["db"]))
            elif t == "fx":
                self.set_fx_wet(int(d["fx"]), _num(d["db"]))
        except (KeyError, TypeError, ValueError):
            _log.debug("ignored malformed %r command", t)
