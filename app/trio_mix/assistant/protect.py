"""Reflex jobs: feedback notching and clip protection."""

from __future__ import annotations

from .. import config as C
from .base import AssistantBase


class ProtectJobs(AssistantBase):
    """Reflex jobs: feedback notching and clip protection."""

    def _is_near_watch(self, freq: float, tol: float = 0.06) -> bool:
        return any(
            abs(freq - w) / w < tol for w in (self.watch_freqs + self.venue_watch_freqs) if w
        )

    def _alloc_bus_band(self) -> int:
        """Pick a main-bus EQ band for a room-feedback notch that does NOT clobber
        a band calibration claimed. Prefer a free band; else rotate among bands we
        already own; only if all 6 are calibration-owned, take the last band."""
        for b in range(1, 7):
            if b not in self.cal_bus_bands and b not in self.fb_bus_bands:
                return b
        if self.fb_bus_bands:
            return self.fb_bus_bands[self.used_bus_notch_band % len(self.fb_bus_bands)]
        return 6

    def handle_feedback(self, ch: int, feat) -> None:
        if not self.enabled["feedback"]:
            return
        if feat.fb_freq:
            prev = self.fb_last_freq[ch]
            stable = prev is not None and abs(feat.fb_freq - prev) / feat.fb_freq < C.FB_STABLE_TOL
            rising = feat.rms_dbfs > self.fb_last_level[ch] + C.FB_RISE_DB
            near = self._is_near_watch(feat.fb_freq)
            need = max(1, C.FB_SUSTAIN_BLOCKS - (1 if near else 0))
            harm = getattr(feat, "harmonicity", 0.0)
            if harm > 0.0:
                need += round(harm * C.FB_HARMONIC_SUSTAIN)
            if ch == C.MEAS_MIC_CH and self.room_confidence < 0.7:
                need = max(need, round(need / max(0.3, self.room_confidence)))

            if stable and rising:
                self.fb_streak[ch] += 1
            else:
                self.fb_streak[ch] = max(0, self.fb_streak[ch] - 1)

            if self.fb_streak[ch] >= need:
                flag = " [watch-list]" if near else ""
                if ch == C.MEAS_MIC_CH:
                    band = self._alloc_bus_band()
                    if self.coach_mode:
                        self._recommend(
                            "feedback",
                            ch,
                            f"Feedback {feat.fb_freq:.0f} Hz in the room → cut the MAIN "
                            f"BUS at {feat.fb_freq:.0f} Hz by {C.FB_NOTCH_GAIN_DB:.0f} dB "
                            f"(Q {C.FB_NOTCH_Q:.0f}); e.g. main PEQ band {band}.{flag}",
                            freq=round(feat.fb_freq, 1),
                            gain_db=C.FB_NOTCH_GAIN_DB,
                            q=C.FB_NOTCH_Q,
                            target="main-bus",
                            band=band,
                        )
                    else:
                        self.con.set_bus_eq(band, feat.fb_freq, C.FB_NOTCH_GAIN_DB, C.FB_NOTCH_Q)
                        if band not in self.fb_bus_bands:
                            self.fb_bus_bands.append(band)
                        self.used_bus_notch_band += 1
                        self._emit(
                            "feedback",
                            f"{feat.fb_freq:.0f} Hz on {C.CHANNELS[ch]} → "
                            f"main-bus band {band}{flag}",
                            ch,
                        )
                        self._note_latency("feedback")
                else:
                    band = (self.used_notch_band[ch] % 4) + 1
                    if self.enabled.get("unmask") and band == C.UNMASK_BAND:
                        band = (band % 4) + 1
                    if self.coach_mode:
                        self._recommend(
                            "feedback",
                            ch,
                            f"Feedback {feat.fb_freq:.0f} Hz on {C.CHANNELS[ch]} → notch "
                            f"input EQ band {band} at {feat.fb_freq:.0f} Hz, "
                            f"{C.FB_NOTCH_GAIN_DB:.0f} dB (Q {C.FB_NOTCH_Q:.0f}).{flag}",
                            freq=round(feat.fb_freq, 1),
                            gain_db=C.FB_NOTCH_GAIN_DB,
                            q=C.FB_NOTCH_Q,
                            target=f"ch{ch}",
                            band=band,
                        )
                    else:
                        self.con.set_eq_notch(ch, band, feat.fb_freq)
                        self.used_notch_band[ch] = band
                        self._emit(
                            "feedback",
                            f"{feat.fb_freq:.0f} Hz on {C.CHANNELS[ch]} → notch band {band}{flag}",
                            ch,
                        )
                        self._note_latency("feedback")
                self.fb_streak[ch] = 0
            self.fb_last_freq[ch] = feat.fb_freq
            self.fb_last_level[ch] = feat.rms_dbfs
        else:
            self.fb_streak[ch] = max(0, self.fb_streak[ch] - 1)
            self.fb_last_freq[ch] = None
            self.fb_last_level[ch] = feat.rms_dbfs

    def handle_clip(self, ch: int, feat, now: float) -> None:
        if not self.enabled["clip"]:
            return
        if feat.peak_dbfs > C.CLIP_PEAK_DBFS:
            if self.coach_mode:
                self._recommend(
                    "clip",
                    ch,
                    f"{C.CHANNELS[ch]} near clip ({feat.peak_dbfs:+.1f} dBFS) → trim its "
                    f"preamp/gain {C.CLIP_TRIM_DB:+.0f} dB.",
                    peak=round(feat.peak_dbfs, 1),
                    trim_db=C.CLIP_TRIM_DB,
                )
                return
            self.gain_db[ch] = self.con.nudge_gain_db(ch, self.gain_db[ch], C.CLIP_TRIM_DB)
            self.last_clip_t[ch] = now
            self._emit(
                "clip",
                f"{C.CHANNELS[ch]} near clip → preamp "
                f"{C.CLIP_TRIM_DB:+.0f} dB → {self.gain_db[ch]:.0f} dB",
                ch,
            )
            self._note_latency("clip")
        elif (
            feat.peak_dbfs < C.CLIP_PEAK_DBFS - 6.0
            and self.gain_db[ch] < self.nominal_gain[ch]
            and now - self.last_clip_t[ch] > C.CLIP_RECOVER_S
            and now - self.last_recover_t[ch] > C.CLIP_RECOVER_S
        ):
            if self.coach_mode:
                self._recommend(
                    "clip",
                    ch,
                    f"{C.CHANNELS[ch]} is clean but its preamp is still trimmed "
                    f"({self.gain_db[ch]:.0f} dB) → you can restore it toward "
                    f"{self.nominal_gain[ch]:.0f} dB.",
                    gain_db=round(self.gain_db[ch], 1),
                    nominal_db=self.nominal_gain[ch],
                )
                return
            target = min(self.nominal_gain[ch], self.gain_db[ch] + C.CLIP_RECOVER_DB)
            self.gain_db[ch] = self.con.nudge_gain_db(
                ch, self.gain_db[ch], target - self.gain_db[ch]
            )
            self.last_recover_t[ch] = now
            self._emit(
                "clip", f"{C.CHANNELS[ch]} clean → restoring preamp → {self.gain_db[ch]:.0f} dB", ch
            )

    def reset_notches(self) -> None:
        cleared = 0
        for ch in C.CHANNELS:
            if self.used_notch_band[ch]:
                self.con.clear_channel_eq(ch)
                self.used_notch_band[ch] = 0
                self.fb_streak[ch] = 0
                cleared += 1
        for band in self.fb_bus_bands:
            self.con.set_bus_eq(band, 1000.0, 0.0, q=2.0)
            cleared += 1
        self.fb_bus_bands = []
        self.used_bus_notch_band = 0
        self._emit("system", f"cleared {cleared} parked notch(es)")
