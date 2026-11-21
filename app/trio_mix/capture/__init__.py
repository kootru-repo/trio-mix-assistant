"""Audio capture sources — the *listening half* of the system.

The engine pulls one analysis frame ({console_ch: float array of length BLOCK})
per tick from a CaptureSource. Implementations:

  * SimCapture          — the built-in closed-loop simulator (no hardware).
  * SoundDeviceCapture  — real multichannel capture via PortAudio/sounddevice
                          (ASIO/WASAPI): the console's USB/card stream plus a FOH
                          measurement mic. The audio callback only copies into a
                          bounded queue (it never blocks or allocates much);
                          block() pops the most recent frame and drops any backlog
                          so the engine stays real-time.

`block()` must be cheap and non-blocking (the engine calls it under its lock).
`capture_meas()` may block for seconds (it's called off-lock, during calibration)."""

from __future__ import annotations

from .base import CaptureError, CaptureSource
from .device import (
    SoundDeviceCapture,
    _format_device_list,
    _pick_input,
    _rank_inputs,
    autodetect_inputs,
    list_audio_devices,
    parse_channel_map,
)
from .sim import SimCapture, sim_room_capture

__all__ = [
    "CaptureError",
    "CaptureSource",
    "SimCapture",
    "SoundDeviceCapture",
    "_format_device_list",
    "_pick_input",
    "_rank_inputs",
    "autodetect_inputs",
    "list_audio_devices",
    "parse_channel_map",
    "sim_room_capture",
]
