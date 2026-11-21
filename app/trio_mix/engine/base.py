"""Engine state, the event log, and the telemetry snapshot the dashboard reads."""

from __future__ import annotations

import logging
import math
import threading
from collections import deque
from typing import TYPE_CHECKING, Any

from .. import config as C
from .. import dsp
from .. import template as tmpl
from ..assistant import MixAssistant
from ..calibration import CalibrationResult, Calibrator
from ..capture import CaptureSource, SimCapture
from ..clock import Clock, SystemClock
from ..osc import ConsoleBase, SimConsole

if TYPE_CHECKING:
    from ..advisor import Advisor
    from ..metersrv import MeterReceiver
    from ..sessionlog import SessionLog
    from ..showclock import ShowClock
    from ..venue import VenueModel

_log = logging.getLogger(__name__)


def _num(x) -> float:
    """Coerce to a finite float or raise — rejects NaN/Infinity from untrusted input."""
    v = float(x)
    if not math.isfinite(v):
        raise ValueError("non-finite number")
    return v


def _clampf(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


class EngineBase:
    """Engine state, the event log, and the telemetry snapshot the dashboard reads."""

    def __init__(
        self,
        console: ConsoleBase | None = None,
        sim: bool = True,
        tick: float = 0.05,
        source: CaptureSource | None = None,
        template: tmpl.ShowTemplate | None = None,
        clock: Clock | None = None,
    ) -> None:
        self.clock: Clock = clock or SystemClock()
        self.sim = sim
        self.tick = tick
        self.con = console or SimConsole()
        if source is not None:
            self.source: CaptureSource | None = source
        elif isinstance(self.con, SimConsole):
            self.source = SimCapture(self.con)
        else:
            self.source = None
        self.assistant = MixAssistant(
            self.con, on_event=self._on_event, on_latency=self._note_latency_ev, clock=self.clock
        )
        self.calibrator = Calibrator(self.con)

        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._t0 = self.clock.monotonic()
        self._last_err_t = -1e9

        self.status = "live"
        self.calib: CalibrationResult | None = None
        self.calib_status = "none"
        self._enabled_backup: dict | None = None
        self._last_notch_t = dict.fromkeys(C.CHANNELS, -1000000000.0)
        self._last_clip_t = dict.fromkeys(C.CHANNELS, -1000000000.0)
        self.muted = dict.fromkeys(C.CHANNELS, False)
        self.master_db = 0.0
        mix_chans = [c for c in C.CHANNELS if c != C.MEAS_MIC_CH]
        freqs = list(C.EQ_DEFAULT_FREQS)
        self.eq = {
            c: {
                b: {
                    "hz": freqs[b - 1] if b - 1 < len(freqs) else 1000.0,
                    "gain": 0.0,
                    "q": 2.0,
                    "on": False,
                }
                for b in range(1, C.CHANNEL_EQ_BANDS + 1)
            }
            for c in mix_chans
        }
        self.sends = {c: dict.fromkeys(C.FX_BUSES, -90.0) for c in mix_chans}
        self.fx_wet = dict.fromkeys(C.FX_BUSES, -90.0)
        self.meter_rx: MeterReceiver | None = None
        self.show_clock: ShowClock | None = None
        self.session_log: SessionLog | None = None
        self.advisor: Advisor | None = None
        self.advisor_advice: dict[str, Any] | None = None
        self.venue = ""
        self.venue_dir: str | None = None
        self.venue_model: VenueModel | None = None
        self.template = template if template is not None else tmpl.default_template()
        self._applied_song: str | None = None
        self._song_start_t = -1e9
        self._dead_since = -1e9
        self.show: dict[str, Any] = {
            "current": "",
            "next": "",
            "section": "",
            "bpm": None,
            "scene": None,
            "playing": False,
            "index": None,
        }
        self._renew_thread: threading.Thread | None = None
        self._meter_count = 0
        self._last_rx_t = -1e9
        self._last_reconcile_log: dict[int, float] = {}
        self._feat: dict[int, dsp.ChannelFeatures] = {}
        self._meas_ring = dsp.RollingRingDetector()
        self._perf = {"tick_ms": 0.0, "jitter_ms": 0.0, "max_ms": 0.0}
        self._latency: dict[str, dict] = {}
        self._last_audio_restart = -1e9
        self.events: deque = deque(maxlen=120)
        self.telemetry: dict = {}
        with self._lock:
            self._rebuild_telemetry()

    def _note_latency_ev(self, kind: str, seconds: float) -> None:
        """Aggregate detect→actuate latency per actuation kind (called from the
        assistant on the loop thread; the per-channel work is already under the
        engine lock). This is the spec's 'event detected → OSC sent' delta —
        the in-process part; the audio block buffer (~BLOCK/SR) and the feedback
        sustain window add to true end-to-end."""
        if not (0.0 <= seconds < 5.0):
            return
        ms = seconds * 1000.0
        e = self._latency.get(kind)
        if e is None:
            self._latency[kind] = {
                "last": round(ms, 2),
                "ema": round(ms, 2),
                "max": round(ms, 2),
                "n": 1,
            }
        else:
            a = 0.2
            e["last"] = round(ms, 2)
            e["ema"] = round((1 - a) * e["ema"] + a * ms, 2)
            e["max"] = round(max(e["max"], ms), 2)
            e["n"] += 1

    def _note_perf(self, now: float, last_now: float) -> None:
        """Track loop responsiveness for the spec's latency success criteria:
        compute time per tick + how far the actual period drifts from `tick`
        (jitter). Cheap EMAs; caller holds the lock."""
        compute_ms = (self.clock.monotonic() - now) * 1000.0
        period_ms = (now - last_now) * 1000.0
        jitter_ms = abs(period_ms - self.tick * 1000.0)
        a = 0.1
        self._perf["tick_ms"] = round((1 - a) * self._perf["tick_ms"] + a * compute_ms, 2)
        self._perf["jitter_ms"] = round((1 - a) * self._perf["jitter_ms"] + a * jitter_ms, 2)
        self._perf["max_ms"] = round(max(self._perf["max_ms"] * 0.999, compute_ms), 2)

    def _note_error(self, exc: Exception) -> None:
        now = self.clock.monotonic()
        if now - self._last_err_t < 5.0:
            return
        self._last_err_t = now
        try:
            with self._lock:
                self.assistant._emit(
                    "system", f"engine error (recovered): {type(exc).__name__}: {exc}"
                )
                self._rebuild_telemetry()
        except Exception:
            _log.exception("could not report an engine error")

    @staticmethod
    def _level_for(ev: dict) -> str:
        """Map an event to one of 4 notification levels (the performer UI shows
        warn/critical as banners; info/notice live only in the log)."""
        kind, msg = ev["kind"], ev["msg"].lower()
        if any(
            w in msg
            for w in ("failed", "unavailable", "stopped", "deaf", "near-silence", "lost", "aborted")
        ):
            return "critical" if ("deaf" in msg or "stopped" in msg) else "warn"
        if kind in ("vocal", "balance"):
            return "info"
        if kind in ("feedback", "manual", "show", "calibration", "advisor"):
            return "notice"
        if kind == "clip":
            return "warn" if "near clip" in msg else "info"
        return "info"

    def _on_event(self, ev: dict) -> None:
        now = self.clock.monotonic()
        ev["level"] = self._level_for(ev)
        if ev["kind"] == "feedback" and ev["ch"] is not None:
            self._last_notch_t[ev["ch"]] = now
        if ev["kind"] == "clip" and ev["ch"] is not None and "near clip" in ev["msg"]:
            self._last_clip_t[ev["ch"]] = now
        self.events.append(ev)
        if self.session_log is not None:
            self.session_log.log_event(ev)

    def set_console_meters(self, vals: list[float]) -> None:
        self._meter_count = len(vals)
        self._last_rx_t = self.clock.monotonic()

    def _output_levels(self) -> dict[int, float]:
        return {ch: f.rms_dbfs for ch, f in self._feat.items()}

    def _channel_telemetry(self, now: float) -> list[dict]:
        out = []
        for ch, role in C.CHANNELS.items():
            feat = self._feat.get(ch)
            rms = feat.rms_dbfs if feat else -90.0
            peak = feat.peak_dbfs if feat else -90.0
            streak = self.assistant.fb_streak.get(ch, 0)
            notched_recent = now - self._last_notch_t[ch] < 2.0
            clip_recent = now - self._last_clip_t[ch] < 1.5
            if notched_recent:
                fb_state = "notched"
            elif streak >= 2:
                fb_state = "building"
            else:
                fb_state = "ok"
            notch_freqs = self.con.notch_freqs(ch) if isinstance(self.con, SimConsole) else []
            out.append(
                {
                    "ch": ch,
                    "role": role,
                    "label": C.ROLE_LABELS[role],
                    "rms": round(rms, 1),
                    "peak": round(peak, 1),
                    "fader": round(self.assistant.fader_db[ch], 1),
                    "gain": round(self.assistant.gain_db[ch], 1),
                    "fb_state": fb_state,
                    "fb_streak": streak,
                    "notch_freqs": [round(f) for f in notch_freqs],
                    "clip_recent": clip_recent,
                    "gain_trimmed": self.assistant.gain_db[ch]
                    < self.assistant.nominal_gain[ch] - 0.1,
                    "muted": self.muted.get(ch, False),
                    "manual_hold": now < self.assistant.manual_hold_until.get(ch, -1e9),
                    "is_meas": ch == C.MEAS_MIC_CH,
                    "is_lead": ch == C.LEAD_VOCAL_CH,
                    "is_balance": ch in C.BALANCE_CHANNELS,
                    "in_mix": ch != C.MEAS_MIC_CH,
                }
            )
        return out

    OPENING_BARS = 8

    DEAD_CRITICAL_S = 1.5

    def _in_opening_bars(self, now: float) -> bool:
        if not self.show.get("playing") or self._song_start_t < 0:
            return False
        bpm = self.show.get("bpm")
        if isinstance(bpm, (int, float)) and bpm > 0:
            sec_per_bar = 4.0 * 60.0 / bpm
            return (now - self._song_start_t) < self.OPENING_BARS * sec_per_bar
        return (now - self._song_start_t) < 16.0

    def _alerts_and_mode(self, now: float, connected: bool) -> tuple[list, str]:
        """Compute the operator-facing alerts and the AUTO/ALERT/MANUAL headline."""
        alerts = []
        cap = self.source.status() if self.source is not None else {"kind": "none"}
        dead = cap.get("dead")
        if dead and self._dead_since < 0:
            self._dead_since = now
        elif not dead:
            self._dead_since = -1e9
        if dead and (now - self._dead_since) > self.DEAD_CRITICAL_S:
            alerts.append(
                {
                    "level": "critical",
                    "msg": "audio capture stopped — the assistant is deaf "
                    "(check the interface is connected)",
                }
            )
        elif dead:
            alerts.append({"level": "warn", "msg": "audio dropout — recovering…"})
        elif cap.get("silent"):
            alerts.append(
                {
                    "level": "warn",
                    "msg": "inputs are silent — check Microphone permission "
                    "(macOS), input gain, and the audio patch",
                }
            )
        elif cap.get("overload"):
            alerts.append(
                {
                    "level": "warn",
                    "msg": "audio interface is dropping samples (xruns) — "
                    "raise the device buffer size",
                }
            )
        if (not self.sim) and self.meter_rx is not None and not connected:
            ip = getattr(self.con, "ip", None)
            where = f" from {ip}" if ip else ""
            alerts.append(
                {
                    "level": "warn",
                    "msg": f"no console feed{where} — check the console IP, network, and firewall",
                }
            )
        if (not self.sim) and self.source is None:
            alerts.append(
                {"level": "notice", "msg": "manual control only (no audio device selected)"}
            )
        if self._in_opening_bars(now):
            alerts = [a for a in alerts if a["level"] == "critical"]
        if self.status == "takeover":
            op_mode = "manual"
        elif self.status == "calibrating":
            op_mode = "calibrating"
        elif any(a["level"] in ("warn", "critical") for a in alerts):
            op_mode = "alert"
        elif self.assistant.coach_mode:
            op_mode = "coach"
        else:
            op_mode = "auto"
        return alerts, op_mode

    def _scene_list(self) -> list:
        cur = getattr(self.con, "last_scene", None)
        out, seen = [], set()
        for sg in self.template.songs:
            if sg.scene is not None and sg.scene not in seen:
                seen.add(sg.scene)
                out.append({"index": sg.scene, "name": sg.name, "current": sg.scene == cur})
        return out

    def _rebuild_telemetry(self) -> None:
        now = self.clock.monotonic()
        lead = C.LEAD_VOCAL_CH
        in_ema = self.assistant.in_ema.get(lead)
        lead_out = (in_ema + self.assistant.fader_db[lead]) if in_ema is not None else None
        connected = (now - self._last_rx_t) < 5.0
        alerts, op_mode = self._alerts_and_mode(now, connected)
        tele = {
            "status": self.status,
            "op_mode": op_mode,
            "alerts": alerts,
            "scenes": self._scene_list(),
            "mode": "simulation" if self.sim else "live-hardware",
            "capture": self.source.status() if self.source is not None else {"kind": "none"},
            "console": {"meters": self._meter_count, "connected": connected},
            "uptime": round(now - self._t0, 1),
            "perf": dict(self._perf),
            "latency": {k: dict(v) for k, v in self._latency.items()},
            "block_ms": round(C.BLOCK / C.SAMPLE_RATE * 1000.0, 1),
            "room": {
                "level_db": round(self.assistant.room_level_db, 1),
                "contrast_db": round(self.assistant.room_contrast_db, 1),
                "confidence": self.assistant.room_confidence,
            },
            "enabled": dict(self.assistant.enabled),
            "coach": {"on": self.assistant.coach_mode, "recs": self.assistant.coach_snapshot(now)},
            "phase": {
                "enabled": self.assistant.enabled.get("phase", False),
                "pairs": list(self.assistant.phase_status.values()),
                "polarity": {c: self.assistant.polarity.get(c, False) for c in C.CHANNELS},
            },
            "unmask": {
                "enabled": self.assistant.enabled.get("unmask", False),
                "duck_db": round(self.assistant.duck_gain, 1),
                "freq": round(C.UNMASK_FREQ),
                "channels": list(self.assistant._unmask_targets()),
            },
            "main_muted": getattr(self.con, "main_muted", False),
            "master": {"fader": round(self.master_db, 1)},
            "eq": {
                c: [
                    {
                        "band": b,
                        "hz": round(bd["hz"]),
                        "gain": round(bd["gain"], 1),
                        "q": round(bd["q"], 1),
                        "on": bd["on"],
                    }
                    for b, bd in sorted(self.eq[c].items())
                ]
                for c in self.eq
            },
            "sends": {c: {fx: round(v, 1) for fx, v in self.sends[c].items()} for c in self.sends},
            "fx": {
                "buses": {str(k): v for k, v in C.FX_BUSES.items()},
                "wet": {str(k): round(v, 1) for k, v in self.fx_wet.items()},
            },
            "show": dict(self.show),
            "advisor": dict(self.advisor_advice) if self.advisor_advice else None,
            "advisor_on": self.advisor is not None and getattr(self.advisor, "available", False),
            "venue": (
                {
                    "name": self.venue,
                    "shows": self.venue_model.shows,
                    "confidence": self.venue_model.confidence,
                    "freqs": [f["hz"] for f in self.venue_model.feedback_freqs],
                }
                if self.venue_model
                else None
            ),
            "lead": {
                "target": round(self.assistant.lead_target, 1),
                "input": round(in_ema, 1) if in_ema is not None else None,
                "output": round(lead_out, 1) if lead_out is not None else None,
            },
            "balance_targets": {c: round(v, 1) for c, v in self.assistant.balance_targets.items()},
            "calibration": {
                "status": self.calib_status,
                "baseline": (
                    [{"hz": k, "db": round(v, 1)} for k, v in self.calib.baseline.items()]
                    if self.calib
                    else []
                ),
                "watchlist": (
                    [{"hz": round(f), "excess": e} for f, e in self.calib.watchlist]
                    if self.calib
                    else []
                ),
                "corrections": (
                    [{"hz": round(f), "cut": c} for f, c in self.calib.corrections]
                    if self.calib
                    else []
                ),
            },
            "channels": self._channel_telemetry(now),
            "log": list(self.events)[-40:][::-1],
        }
        self.telemetry = tele

    def snapshot(self) -> dict:
        with self._lock:
            return self.telemetry
