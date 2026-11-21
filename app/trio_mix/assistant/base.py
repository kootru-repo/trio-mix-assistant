"""Assistant state, the decision log, coach-mode recommendations and room confidence."""

from __future__ import annotations

from collections import deque

from .. import config as C
from ..calibration import CalibrationResult
from ..clock import Clock, SystemClock
from ..osc import ConsoleBase


def _role(ch: int | None) -> str | None:
    return None if ch is None else C.CHANNELS.get(ch)


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


class AssistantBase:
    """Assistant state, the decision log, coach-mode recommendations and room confidence."""

    def __init__(
        self,
        console: ConsoleBase,
        calib: CalibrationResult | None = None,
        on_event=None,
        on_latency=None,
        clock: Clock | None = None,
    ) -> None:
        self.clock: Clock = clock or SystemClock()
        self.con = console
        self.on_event = on_event
        self.on_latency = on_latency
        self.block_t0 = 0.0
        self.enabled = dict(C.DEFAULT_ENABLED)
        self.lead_target = C.LEAD_TARGET_DB

        self.coach_mode = False
        self.coach_recs: dict[tuple, dict] = {}
        self._coach_last_text: dict[tuple, str] = {}
        self._coach_seq = 0

        chans = list(C.CHANNELS)
        self.fader_db = dict.fromkeys(chans, 0.0)
        self.gain_db = dict.fromkeys(chans, 20.0)
        self.nominal_gain = dict.fromkeys(chans, 20.0)

        self.fb_streak = dict.fromkeys(chans, 0)
        self.used_notch_band = dict.fromkeys(chans, 0)
        self.used_bus_notch_band = 0
        self.fb_bus_bands: list[int] = []
        self.cal_bus_bands: set[int] = set()
        self.fb_last_freq = dict.fromkeys(chans)
        self.fb_last_level = dict.fromkeys(chans, -90.0)

        self.last_clip_t = dict.fromkeys(chans, -1000000000.0)
        self.last_recover_t = dict.fromkeys(chans, -1000000000.0)

        self.in_ema: dict[int, float | None] = dict.fromkeys(chans)
        self.last_ride_t = dict.fromkeys(chans, -1000000000.0)
        self.last_move_t = dict.fromkeys(chans, -1000000000.0)
        self.stage_baseline: float | None = None
        self.last_stage_warn = -1e9
        self.room_level_db = -90.0
        self.room_contrast_db = 0.0
        self.room_confidence = 1.0
        self.last_lowconf_warn = -1e9
        self.manual_hold_until = dict.fromkeys(chans, -1000000000.0)
        self.balance_targets: dict[int, float] = {}

        self.polarity = dict.fromkeys(chans, False)
        self.phase_ema: dict[tuple, float] = {}
        self.phase_lag_ema: dict[tuple, float] = {}
        self.phase_streak: dict[tuple, int] = {}
        self.phase_armed: dict[tuple, bool] = {}
        self.phase_status: dict[tuple, dict] = {}
        self.last_phase_act: dict[tuple, float] = {}
        self.last_phase_warn: dict[tuple, float] = {}

        self.duck_gain = 0.0
        self.duck_applied: dict[int, float] = {}
        self.vox_level_ema: float | None = None
        self.last_unmask_log = -1e9

        self.set_calibration(calib)
        self.venue_watch_freqs: list = []

        self.log: deque = deque(maxlen=200)

    def set_calibration(self, calib: CalibrationResult | None) -> None:
        self.calib = calib
        self.watch_freqs = list(calib.watch_freqs) if calib else []

    def _emit(self, kind: str, msg: str, ch: int | None = None) -> None:
        ev = {
            "time": self.clock.hhmmss(),
            "kind": kind,
            "ch": ch,
            "role": _role(ch),
            "msg": msg,
        }
        self.log.append(ev)
        if self.on_event:
            self.on_event(ev)

    def set_coach_mode(self, on: bool) -> None:
        """Toggle advisory mode. When ON, jobs recommend manual moves instead of
        actuating; the console is never written. Turning it off clears any
        standing recommendations."""
        on = bool(on)
        if on == self.coach_mode:
            return
        self.coach_mode = on
        if on:
            self.release_unmask()
        else:
            self.coach_recs.clear()
            self._coach_last_text.clear()
        self._emit(
            "system",
            "coach mode ON — the assistant advises every automatic move (mix "
            "corrections, scene recall, guest mutes) instead of applying it; "
            "only your own manual moves act"
            if on
            else "coach mode off",
        )

    def _recommend(
        self, kind: str, ch: int | None, text: str, persist: bool = False, **meta
    ) -> None:
        """Record/refresh a standing manual-move recommendation (keyed by kind+ch)
        and log it once per distinct instruction, so a persistent problem doesn't
        spam the decision log. `persist` recs are one-shot advice (e.g. a room
        calibration) that must NOT time out — they stay until coach is toggled off
        or the recommendation is re-issued."""
        self._coach_seq += 1
        key = (kind, ch)
        self.coach_recs[key] = {
            "seq": self._coach_seq,
            "mono": self.clock.monotonic(),
            "persist": persist,
            "time": self.clock.hhmmss(),
            "kind": kind,
            "ch": ch,
            "role": _role(ch),
            "text": text,
            **meta,
        }
        if self._coach_last_text.get(key) != text:
            self._coach_last_text[key] = text
            self._emit("coach", text, ch)

    def coach_snapshot(self, now: float | None = None) -> list[dict]:
        """Current recommendations, freshest first, dropping any non-persistent rec
        that hasn't been re-issued within COACH_TTL_S (the problem cleared, or the
        engineer fixed it) — also purges them so they don't linger in state."""
        now = self.clock.monotonic() if now is None else now
        live = []
        for key in list(self.coach_recs):
            rec = self.coach_recs[key]
            if not rec.get("persist") and now - rec["mono"] > C.COACH_TTL_S:
                del self.coach_recs[key]
                self._coach_last_text.pop(key, None)
            else:
                live.append(rec)
        live.sort(key=lambda r: r["seq"], reverse=True)
        return live

    def coach_calibration(self, steps: list[dict]) -> None:
        """Turn a calibration plan (from Calibrator.plan) into one standing manual
        recommendation: the main-bus PEQ to dial in by hand. Persistent, so it
        stays up while the engineer applies it. In coach mode the console is never
        written — this replaces the automatic apply()."""
        if not steps:
            self._recommend(
                "calibration",
                None,
                "Room measured — no problem peaks; leave the main bus flat.",
                persist=True,
                steps=[],
            )
            return
        parts = [
            f"band {s['band']} {s['hz']:.0f} Hz {s['gain']:+.1f} dB (Q {s['q']:.0f})"
            + ("" if s["kind"] == "room" else " pre-dip")
            for s in steps
        ]
        text = "Room calibration → set MAIN-BUS PEQ: " + "; ".join(parts) + "."
        self._recommend(
            "calibration",
            None,
            text,
            persist=True,
            steps=[
                {
                    "band": s["band"],
                    "hz": round(s["hz"], 1),
                    "gain": s["gain"],
                    "q": s["q"],
                    "kind": s["kind"],
                }
                for s in steps
            ],
        )

    def _note_latency(self, kind: str) -> None:
        """Record detect→actuate latency: from when this block's analysis began
        (engine sets block_t0) to the OSC command we just issued."""
        if self.on_latency:
            self.on_latency(kind, self.clock.perf_counter() - self.block_t0)

    def note_manual(self, ch: int, now: float, hold: float = 5.0) -> None:
        """Mark a channel as just-touched-by-a-human; auto yields for `hold` s."""
        self.manual_hold_until[ch] = now + hold

    def _unmask_targets(self) -> tuple:
        if C.UNMASK_CHANNELS:
            return tuple(c for c in C.UNMASK_CHANNELS if c in C.CHANNELS)
        exclude = {C.LEAD_VOCAL_CH, C.MEAS_MIC_CH, C.STAGE_MIC_CH}
        return tuple(c for c in C.CHANNELS if c not in exclude)

    def release_unmask(self) -> None:
        """Flatten the duck band on every ducked channel (job off / coach / takeover).
        Keeps the channel EQ engaged; just returns the reserved band to 0 dB."""
        for ch in list(self.duck_applied):
            self.con.set_eq_band(ch, C.UNMASK_BAND, C.UNMASK_FREQ, 0.0, C.UNMASK_Q, on=True)
        self.duck_applied.clear()
        self.duck_gain = 0.0

    @staticmethod
    def _room_conf(level_db: float, contrast_db: float) -> float:
        """0..1 confidence in the room mic: a loud, broadband (low-contrast) room
        masks feedback, so trust drops. Quiet/tonal -> ~1.0; loud+flat -> ~0.3."""
        loud = (
            1.0
            if level_db <= -45.0
            else (0.3 if level_db >= -15.0 else 1.0 - 0.7 * (level_db + 45.0) / 30.0)
        )
        flat = 1.0 if contrast_db >= C.FB_RING_DB else max(0.5, contrast_db / C.FB_RING_DB)
        return round(loud * flat, 3)

    def _update_room(self, feat, now: float) -> None:
        a = 1 / 12.0
        self.room_level_db = (1 - a) * self.room_level_db + a * feat.rms_dbfs
        self.room_contrast_db = (1 - a) * self.room_contrast_db + a * feat.contrast_db
        self.room_confidence = self._room_conf(self.room_level_db, self.room_contrast_db)
        if self.room_confidence < 0.5 and now - self.last_lowconf_warn > 30.0:
            self.last_lowconf_warn = now
            self._emit(
                "system",
                f"room-mic SNR low (conf {self.room_confidence:.0%}) — "
                "feedback detection is being more conservative",
                C.MEAS_MIC_CH,
            )

    def snapshot(self) -> dict:
        return {
            "enabled": dict(self.enabled),
            "coach_mode": self.coach_mode,
            "fader_db": {c: round(v, 1) for c, v in self.fader_db.items()},
            "gain_db": {c: round(v, 1) for c, v in self.gain_db.items()},
            "notch_bands": {c: self.used_notch_band[c] for c in C.CHANNELS},
            "lead_target": self.lead_target,
            "balance_targets": {c: round(v, 1) for c, v in self.balance_targets.items()},
        }
