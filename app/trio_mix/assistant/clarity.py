"""Clarity jobs: phase/polarity between paired mics and vocal unmasking."""

from __future__ import annotations

from .. import config as C
from .levels import LevelJobs


class ClarityJobs(LevelJobs):
    """Clarity jobs: phase/polarity between paired mics and vocal unmasking."""

    def _phase_warn(self, key: tuple, ch: int, msg: str, now: float) -> None:
        if now - self.last_phase_warn.get(key, -1e9) > C.PHASE_WARN_INTERVAL:
            self.last_phase_warn[key] = now
            self._emit("phase", msg, ch)

    def _clear_phase(self, key: tuple) -> None:
        self.coach_recs.pop(("phase", key[0]), None)
        self._coach_last_text.pop(("phase", key[0]), None)

    def handle_phase(self, a: int, b: int, rel, now: float) -> None:
        if not self.enabled.get("phase"):
            return
        key = (a, b)
        al = C.PHASE_EMA
        ce = self.phase_ema.get(key)
        self.phase_ema[key] = rel.zero_corr if ce is None else (1 - al) * ce + al * rel.zero_corr
        if abs(rel.best_corr) >= C.PHASE_CORR_MIN:
            le = self.phase_lag_ema.get(key)
            self.phase_lag_ema[key] = rel.lag_ms if le is None else (1 - al) * le + al * rel.lag_ms
        corr = self.phase_ema[key]
        lag = self.phase_lag_ema.get(key, 0.0)
        ra, rb = C.CHANNELS.get(a, f"ch{a}"), C.CHANNELS.get(b, f"ch{b}")

        inverted = corr < C.PHASE_INVERT_CORR
        related = abs(corr) >= C.PHASE_CORR_MIN
        comb = related and not inverted and abs(lag) > C.PHASE_COMB_LAG_MS
        status = (
            "inverted" if inverted else "comb" if comb else "aligned" if related else "unrelated"
        )

        if inverted:
            self.phase_streak[key] = self.phase_streak.get(key, 0) + 1
        else:
            self.phase_streak[key] = max(0, self.phase_streak.get(key, 0) - 1)
            if status in ("aligned", "unrelated"):
                self.phase_armed[key] = True

        self.phase_status[key] = {
            "a": a,
            "b": b,
            "corr": round(corr, 2),
            "lag_ms": round(lag, 2),
            "status": status,
            "inv_a": self.polarity.get(a, False),
            "inv_b": self.polarity.get(b, False),
        }

        if status == "inverted":
            armed = self.phase_armed.get(key, True)
            ready = (
                self.phase_streak[key] >= C.PHASE_SUSTAIN
                and now - self.last_phase_act.get(key, -1e9) > C.PHASE_ACT_COOLDOWN
            )
            if self.coach_mode:
                self._recommend(
                    "phase",
                    a,
                    f"{ra} & {rb} are OUT OF POLARITY (corr {corr:+.2f}) → invert phase on {rb}.",
                    persist=True,
                    pair=[a, b],
                    status="inverted",
                    corr=round(corr, 2),
                )
            elif ready and armed:
                newpol = not self.polarity.get(b, False)
                self.con.set_polarity(b, newpol)
                self.polarity[b] = newpol
                self.last_phase_act[key] = now
                self.phase_armed[key] = False
                self.phase_streak[key] = 0
                self._emit(
                    "phase",
                    f"{ra} & {rb} out of polarity → flipped phase on "
                    f"{rb} ({'inverted' if newpol else 'normal'})",
                    b,
                )
                self._note_latency("phase")
            elif ready and not armed:
                self._phase_warn(
                    key,
                    a,
                    f"{ra} & {rb} still out of polarity after a "
                    f"flip → check mic placement / the card tap point.",
                    now,
                )
        elif status == "comb":
            msg = (
                f"{ra} & {rb} arrive ~{abs(lag):.2f} ms apart (comb filtering) → "
                f"time-align them or move the mic."
            )
            if self.coach_mode:
                self._recommend(
                    "phase", a, msg, persist=True, pair=[a, b], status="comb", lag_ms=round(lag, 2)
                )
            else:
                self._phase_warn(key, a, msg, now)
        else:
            self._clear_phase(key)

    def handle_unmask(self, vox_feat, now: float) -> None:
        if not self.enabled.get("unmask"):
            return
        a = 1 / 6.0
        self.vox_level_ema = (
            vox_feat.rms_dbfs
            if self.vox_level_ema is None
            else (1 - a) * self.vox_level_ema + a * vox_feat.rms_dbfs
        )
        targets = self._unmask_targets()
        if self.coach_mode:
            roles = ", ".join(C.CHANNELS.get(c, f"ch{c}") for c in targets)
            self._recommend(
                "unmask",
                C.LEAD_VOCAL_CH,
                f"To unmask the vocal: dip ~{C.UNMASK_FREQ:.0f} Hz by "
                f"{abs(C.UNMASK_DEPTH_DB):.0f} dB (Q {C.UNMASK_Q:.1f}) on {roles} while the "
                f"vocal is up.",
                persist=True,
                freq=round(C.UNMASK_FREQ),
                depth_db=C.UNMASK_DEPTH_DB,
                channels=list(targets),
            )
            return
        present = self.vox_level_ema > C.UNMASK_VOX_GATE_DB
        target = C.UNMASK_DEPTH_DB if present else 0.0
        coef = C.UNMASK_ATTACK if target < self.duck_gain else C.UNMASK_RELEASE
        self.duck_gain = (1 - coef) * self.duck_gain + coef * target
        for ch in targets:
            if abs(self.duck_gain - self.duck_applied.get(ch, 0.0)) >= C.UNMASK_WRITE_EPS:
                g = round(self.duck_gain, 1)
                self.con.set_eq_band(ch, C.UNMASK_BAND, C.UNMASK_FREQ, g, C.UNMASK_Q, on=True)
                self.duck_applied[ch] = self.duck_gain
        if present and self.duck_gain < -1.0 and now - self.last_unmask_log > 10.0:
            self.last_unmask_log = now
            self._emit(
                "unmask",
                f"vocal up → ducking {C.UNMASK_FREQ:.0f} Hz "
                f"{self.duck_gain:+.1f} dB on {len(targets)} instrument(s)",
            )
