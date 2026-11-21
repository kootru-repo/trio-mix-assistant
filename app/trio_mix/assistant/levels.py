"""Level jobs: vocal ride, balance hold and the stage-volume watch."""

from __future__ import annotations

from .. import config as C
from .base import _clamp
from .protect import ProtectJobs


class LevelJobs(ProtectJobs):
    """Level jobs: vocal ride, balance hold and the stage-volume watch."""

    def _ride_toward(
        self, ch: int, feat, target_out: float, now: float, min_interval: float, kind: str
    ) -> None:
        a = 1 / 24.0
        e = self.in_ema[ch]
        ema = feat.rms_dbfs if e is None else (1 - a) * e + a * feat.rms_dbfs
        self.in_ema[ch] = ema
        if now < self.manual_hold_until.get(ch, -1e9):
            return
        if now - self.last_ride_t[ch] < min_interval:
            return
        output_est = ema + self.fader_db[ch]
        err = target_out - output_est
        if abs(err) <= C.LEAD_TOLERANCE:
            return
        step = _clamp(err, -C.MAX_STEP_DB, C.MAX_STEP_DB)
        start = self.fader_db[ch]
        newf = _clamp(start + step, C.FADER_MIN_DB, C.FADER_MAX_DB)
        self.last_ride_t[ch] = now
        if abs(newf - start) < 0.05:
            return
        if self.coach_mode:
            direction = "up" if newf > start else "down"
            self._recommend(
                kind,
                ch,
                f"{C.CHANNELS[ch]}: output {output_est:+.1f} dB vs target "
                f"{target_out:+.1f} → move the fader {direction} {abs(newf - start):.1f} dB "
                f"(to {newf:+.1f}).",
                output_db=round(output_est, 1),
                target_db=round(target_out, 1),
                delta_db=round(newf - start, 2),
                to_db=round(newf, 1),
            )
            return
        self.fader_db[ch] = self.con.ramp_fader_db(ch, start, newf)
        self.last_move_t[ch] = now
        self._note_latency(kind)
        self._emit(
            kind,
            f"{C.CHANNELS[ch]}: out {output_est:+.1f} dB vs target "
            f"{target_out:+.1f} → fader {start:+.1f}→{self.fader_db[ch]:+.1f} dB",
            ch,
        )

    def handle_vocal_ride(self, feat, now: float) -> None:
        if not self.enabled["vocal_ride"]:
            return
        self._ride_toward(
            C.LEAD_VOCAL_CH, feat, self.lead_target, now, min_interval=0.25, kind="vocal"
        )

    def handle_balance(self, ch: int, feat, now: float) -> None:
        if not self.enabled["balance"] or ch not in self.balance_targets:
            return
        self._ride_toward(ch, feat, self.balance_targets[ch], now, min_interval=1.0, kind="balance")

    def capture_balance(self, levels: dict[int, float]) -> None:
        """Snapshot the balance channels' current output as hold targets, using
        the same smoothed (EMA) level basis the ride uses — so capturing doesn't
        cause an immediate spurious correction from EMA-vs-instantaneous lag."""
        self.balance_targets = {}
        for ch in C.BALANCE_CHANNELS:
            lvl = self.in_ema.get(ch)
            if lvl is None:
                lvl = levels.get(ch)
            if lvl is not None:
                self.balance_targets[ch] = lvl + self.fader_db[ch]
        pretty = ", ".join(f"{C.CHANNELS[c]} {v:+.1f}" for c, v in self.balance_targets.items())
        self._emit("balance", f"captured balance targets: {pretty}")

    def handle_stage_volume(self, feat, now: float) -> None:
        lvl = feat.rms_dbfs
        prior = lvl if self.stage_baseline is None else self.stage_baseline
        baseline = 0.999 * prior + 0.001 * lvl
        self.stage_baseline = baseline
        if lvl > baseline + C.STAGE_RISE_DB and now - self.last_stage_warn > 30.0:
            self.last_stage_warn = now
            self._emit(
                "system",
                f"stage volume up ~{lvl - baseline:.0f} dB over baseline — consider easing back",
                C.STAGE_MIC_CH,
            )
