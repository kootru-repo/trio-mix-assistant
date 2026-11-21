"""Operator controls: jobs, faders, mutes, EQ, FX sends, takeover."""

from __future__ import annotations

import logging
import time

from .. import config as C
from .base import EngineBase, _clampf, _num

_log = logging.getLogger(__name__)


class EngineControls(EngineBase):
    """Operator controls: jobs, faders, mutes, EQ, FX sends, takeover."""

    def set_enabled(self, job: str, on: bool) -> None:
        with self._lock:
            if job not in self.assistant.enabled:
                return
            self.assistant.enabled[job] = bool(on)
            if job == "balance" and on:
                self.assistant.capture_balance(self._output_levels())
            if job == "unmask" and not on:
                self.assistant.release_unmask()
            self.assistant._emit("system", f"{job} {'ENABLED' if on else 'disabled'}")
            self._rebuild_telemetry()

    def set_coach_mode(self, on: bool) -> None:
        """Toggle the deterministic coach: jobs advise manual moves instead of
        actuating the console. The moves are the same math as auto mode."""
        with self._lock:
            self.assistant.set_coach_mode(bool(on))
            self._rebuild_telemetry()

    def set_lead_target(self, db: float) -> None:
        try:
            db = _num(db)
        except (TypeError, ValueError):
            return
        with self._lock:
            self.assistant.lead_target = db
            self.assistant._emit("system", f"lead target set to {db:+.1f} dB")
            self._rebuild_telemetry()

    def set_fader(self, ch: int, db: float) -> None:
        if ch not in C.CHANNELS:
            return
        try:
            db = _num(db)
        except (TypeError, ValueError):
            return
        with self._lock:
            now = time.monotonic()
            db = self.con.set_fader_raw(ch, db)
            self.assistant.fader_db[ch] = db
            self.assistant.note_manual(ch, now)
            self.assistant.last_move_t[ch] = now
            self.assistant._emit("manual", f"{C.CHANNELS[ch]} fader → {db:+.1f} dB", ch)
            partner = self._linked_partner(ch)
            if partner is not None:
                pdb = self.con.set_fader_raw(partner, db)
                self.assistant.fader_db[partner] = pdb
                self.assistant.note_manual(partner, now)
                self.assistant.last_move_t[partner] = now
                self.assistant._emit(
                    "manual", f"{C.CHANNELS[partner]} linked → {pdb:+.1f} dB", partner
                )
            self._rebuild_telemetry()

    @staticmethod
    def _linked_partner(ch: int) -> int | None:
        for pair in C.STEREO_LINKS:
            if ch in pair:
                for other in pair:
                    if other != ch and other in C.CHANNELS:
                        return other
        return None

    def set_eq(self, ch: int, band: int, hz=None, gain=None, q=None, on=None) -> None:
        if ch not in self.eq:
            return
        with self._lock:
            b = self.eq[ch].get(int(band))
            if b is None:
                return
            try:
                if hz is not None:
                    b["hz"] = _clampf(_num(hz), 20.0, 20000.0)
                if gain is not None:
                    b["gain"] = _clampf(_num(gain), -15.0, 15.0)
                if q is not None:
                    b["q"] = _clampf(_num(q), 0.3, 10.0)
                if on is not None:
                    b["on"] = bool(on)
            except (TypeError, ValueError):
                return
            self.con.set_eq_band(ch, int(band), b["hz"], b["gain"], b["q"], bool(b["on"]))
            self.assistant._emit(
                "manual",
                f"{C.CHANNELS[ch]} EQ b{band}: {b['hz']:.0f} Hz "
                f"{b['gain']:+.1f} dB Q{b['q']:.1f} "
                f"{'on' if b['on'] else 'off'}",
                ch,
            )
            self._rebuild_telemetry()

    def reset_channel_eq(self, ch: int) -> None:
        if ch not in self.eq:
            return
        with self._lock:
            for bnum, band in self.eq[ch].items():
                band["gain"], band["on"] = 0.0, False
                self.con.set_eq_band(ch, bnum, band["hz"], 0.0, band["q"], False)
            self.con.clear_channel_eq(ch)
            if ch in self.assistant.used_notch_band:
                self.assistant.used_notch_band[ch] = 0
                self.assistant.fb_streak[ch] = 0
            self.assistant._emit("manual", f"{C.CHANNELS[ch]} EQ reset to flat", ch)
            self._rebuild_telemetry()

    def set_send(self, ch: int, fx: int, db: float) -> None:
        if ch not in self.sends or int(fx) not in C.FX_BUSES:
            return
        with self._lock:
            try:
                db = _clampf(_num(db), -90.0, 10.0)
            except (TypeError, ValueError):
                return
            self.sends[ch][int(fx)] = db
            self.con.set_send(ch, int(fx), db)
            self.assistant._emit(
                "manual", f"{C.CHANNELS[ch]} → {C.FX_BUSES[int(fx)]} {db:+.0f} dB", ch
            )
            self._rebuild_telemetry()

    def set_fx_wet(self, fx: int, db: float) -> None:
        if int(fx) not in C.FX_BUSES:
            return
        with self._lock:
            try:
                db = _clampf(_num(db), -90.0, 10.0)
            except (TypeError, ValueError):
                return
            self.fx_wet[int(fx)] = db
            self.con.set_fx_return(int(fx), db)
            self.assistant._emit("manual", f"{C.FX_BUSES[int(fx)]} return {db:+.0f} dB")
            self._rebuild_telemetry()

    def set_mute(self, ch: int, on: bool) -> None:
        if ch not in C.CHANNELS:
            return
        with self._lock:
            self.con.set_channel_mute(ch, bool(on))
            self.muted[ch] = bool(on)
            self.assistant.note_manual(ch, time.monotonic())
            self.assistant._emit("manual", f"{C.CHANNELS[ch]} {'MUTED' if on else 'unmuted'}", ch)
            self._rebuild_telemetry()

    def set_master(self, db: float) -> None:
        try:
            db = _num(db)
        except (TypeError, ValueError):
            return
        with self._lock:
            self.master_db = self.con.set_main_fader(db)
            self.assistant._emit("manual", f"master fader → {self.master_db:+.1f} dB")
            self._rebuild_telemetry()

    def capture_balance_now(self) -> None:
        with self._lock:
            self.assistant.capture_balance(self._output_levels())
            self._rebuild_telemetry()

    def reconcile_fader(self, ch: int, db: float) -> None:
        """The console reported channel `ch` at `db` (e.g. a human moved a fader
        on the desk/iPad). If it disagrees with what we believe — and it wasn't
        just our own move (or its ramp) echoing back — adopt it and let auto-ride
        yield. A continuous human fader sweep is coalesced to one log line/0.5 s."""
        if ch not in C.CHANNELS:
            return
        with self._lock:
            now = time.monotonic()
            self._last_rx_t = now
            if now - self.assistant.last_move_t.get(ch, -1e9) < 0.8:
                return
            if abs(db - self.assistant.fader_db.get(ch, 0.0)) < 0.5:
                return
            self.assistant.fader_db[ch] = db
            self.assistant.note_manual(ch, now)
            if now - self._last_reconcile_log.get(ch, -1e9) > 0.5:
                self._last_reconcile_log[ch] = now
                self.assistant._emit(
                    "manual", f"{C.CHANNELS[ch]} moved on console → {db:+.1f} dB", ch
                )
            self._rebuild_telemetry()

    def reset_notches(self) -> None:
        with self._lock:
            self.assistant.reset_notches()
            self._rebuild_telemetry()

    def panic(self, on: bool) -> None:
        with self._lock:
            if on and self.status != "takeover":
                self._enabled_backup = dict(self.assistant.enabled)
                for k in self.assistant.enabled:
                    self.assistant.enabled[k] = False
                self.assistant.release_unmask()
                self.con.set_main_mute(True)
                self.status = "takeover"
                self.assistant._emit("panic", "TAKEOVER — main muted, all jobs held")
            elif not on and self.status == "takeover":
                self.con.set_main_mute(False)
                if self._enabled_backup is not None:
                    self.assistant.enabled.update(self._enabled_backup)
                self.status = "live"
                self.assistant._emit("panic", "takeover released — back to live")
            self._rebuild_telemetry()
