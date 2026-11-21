"""The capture interface the engine pulls analysis frames from."""

from __future__ import annotations

import logging

import numpy as np

_log = logging.getLogger(__name__)


class CaptureError(RuntimeError):
    """A capture device could not be opened — message is operator-facing."""


class CaptureSource:
    """Interface the engine pulls analysis frames from."""

    def start(self) -> None:
        pass

    def stop(self) -> None:
        pass

    def block(self) -> dict[int, np.ndarray]:
        """One analysis frame. MUST NOT block (called under the engine lock)."""
        raise NotImplementedError

    def capture_meas(self, seconds: float) -> np.ndarray | None:
        """Record `seconds` of the measurement-mic channel for calibration. May
        block (called off-lock). Returns None if no meas-mic input is available."""
        return None

    def emit_pink_noise(self, samples: np.ndarray) -> bool:
        """Optionally play the calibration pink noise out (the audio output).
        Returns True if playback was issued (or N/A for sim), False on failure."""
        return True

    def dead(self) -> bool:
        """True if the stream has stopped delivering audio (device gone/wedged)."""
        return False

    def silent(self) -> bool:
        """True if the stream IS delivering frames but they're digital-silence —
        the tell-tale of a denied mic permission (macOS), a muted/disconnected
        input, or zero input gain. The device looks fine but we hear nothing."""
        return False

    def restart(self) -> bool:
        """Try to re-open a dead device. Returns True on success."""
        return False

    def status(self) -> dict:
        """Health for telemetry (kind, overruns, underruns, ...)."""
        return {"kind": "none"}
