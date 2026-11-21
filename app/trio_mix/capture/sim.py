"""The built-in closed-loop simulator: no hardware needed."""

from __future__ import annotations

import logging

import numpy as np

from .. import config as C
from .. import dsp
from .base import CaptureSource

_log = logging.getLogger(__name__)


def sim_room_capture(rng=None) -> np.ndarray:
    """A synthetic measurement-mic recording for the pink-noise calibration:
    pink noise + a boomy 250 Hz room mode + a hot 2.5 kHz resonance."""
    noise = dsp.generate_pink_noise(C.CAL_DURATION_S, rng=rng)
    t = np.arange(noise.size) / C.SAMPLE_RATE
    noise = noise + 0.30 * np.sin(2 * np.pi * 250.0 * t)
    noise = noise + 0.22 * np.sin(2 * np.pi * 2500.0 * t)
    return noise


class SimCapture(CaptureSource):
    NOISE = 0.008
    RING_FREQ = 2500.0
    BOOM_FREQ = 250.0

    def __init__(self, console, seed: int = 7) -> None:
        self.con = console
        self.rng = np.random.default_rng(seed)
        self.n = 0
        self.block_i = 0
        self.ring_amp = 0.0
        self.next_ring = 40
        self.clip_until = -1
        self.next_clip = 90

    def _gaintrim_lin(self, ch: int) -> float:
        trim = self.con.gain_db.get(ch, 20.0) - 20.0
        return 10 ** (trim / 20.0)

    def block(self) -> dict[int, np.ndarray]:
        t = (self.n + np.arange(C.BLOCK)) / C.SAMPLE_RATE
        self.n += C.BLOCK
        self.block_i += 1
        i = self.block_i
        frame: dict[int, np.ndarray] = {}

        for ch, role in C.CHANNELS.items():
            x = self.NOISE * self.rng.standard_normal(C.BLOCK)
            lin = self._gaintrim_lin(ch)
            if role == "lead_vox":
                env = 10 ** ((3.0 * np.sin(2 * np.pi * t / 20.0)) / 20.0)
                vib = 220.0 * (1 + 0.015 * np.sin(2 * np.pi * 5.0 * t))
                x = x + 0.50 * env * np.sin(2 * np.pi * vib * t)
            elif role == "harm_vox_l":
                x = x + 0.06 * np.sin(2 * np.pi * 330.0 * t)
            elif role == "harm_vox_r":
                x = x + 0.06 * np.sin(2 * np.pi * 440.0 * t)
            elif role == "acoustic_gtr":
                x = (
                    x
                    + 0.09 * np.sin(2 * np.pi * 196.0 * t)
                    + 0.03 * self.rng.standard_normal(C.BLOCK)
                )
            elif role == "bass_di":
                x = x + 0.12 * np.sin(2 * np.pi * 82.0 * t)
            elif role == "cajon":
                x = x + 0.05 * self.rng.standard_normal(C.BLOCK)
            elif role == "keys_aux":
                x = x + 0.07 * np.sin(2 * np.pi * 262.0 * t)
            if role == "cajon" and i <= self.clip_until:
                x = x + 0.95 * np.sin(2 * np.pi * 700.0 * t)
            frame[ch] = (x * lin).astype(np.float32)

        room = self.NOISE * self.rng.standard_normal(C.BLOCK) + 0.055 * np.sin(
            2 * np.pi * self.BOOM_FREQ * t
        )
        if i >= self.next_ring and self.ring_amp == 0.0:
            self.ring_amp = 0.05
        if self.ring_amp > 0.0:
            if self.con.is_tamed(C.MEAS_MIC_CH, self.RING_FREQ):
                self.ring_amp *= 0.55
                if self.ring_amp < 0.01:
                    self.ring_amp = 0.0
                    self.next_ring = i + 120
            else:
                self.ring_amp = min(0.9, self.ring_amp * 1.25)
            room = room + self.ring_amp * np.sin(2 * np.pi * self.RING_FREQ * t)
        frame[C.MEAS_MIC_CH] = room.astype(np.float32)

        if i >= self.next_clip and i > self.clip_until:
            self.clip_until = i + 5
            self.next_clip = i + 160
        return frame

    def capture_meas(self, seconds: float) -> np.ndarray:
        return sim_room_capture(self.rng)

    def status(self) -> dict:
        return {"kind": "simulation"}
