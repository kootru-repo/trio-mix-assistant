"""Real multichannel capture through PortAudio/sounddevice, and device discovery."""

from __future__ import annotations

import contextlib
import logging
import queue
import threading
import time
from typing import Any

import numpy as np

from .. import config as C
from .base import CaptureError, CaptureSource

_log = logging.getLogger(__name__)


class SoundDeviceCapture(CaptureSource):
    """Live multichannel capture. The console's USB/card stream + the FOH meas
    mic arrive on one (or several) input device channels. `channel_map` maps each
    console channel to a 0-based device channel index (default: console N -> dev
    N-1). Pass `stream_factory` to inject a fake stream in tests."""

    def __init__(
        self,
        device=None,
        channel_map: dict[int, int] | None = None,
        samplerate: int = C.SAMPLE_RATE,
        block: int = C.BLOCK,
        meas_ch: int | None = None,
        output_device=None,
        stream_factory=None,
        output_factory=None,
        gain_db: float = 0.0,
    ) -> None:
        self.device = device
        self.output_device = output_device
        self.gain_db = float(gain_db)
        self._gain = 10.0 ** (self.gain_db / 20.0)
        self._auto_db: float | None = None
        self.samplerate = samplerate
        self.blocksize = block
        self.meas_ch = C.MEAS_MIC_CH if meas_ch is None else meas_ch
        chans = sorted(C.CHANNELS)
        self.channel_map = channel_map or {ch: ch - 1 for ch in chans}
        self.ndev = max(self.channel_map.values()) + 1
        self._q: queue.Queue = queue.Queue(maxsize=32)
        self._stream: Any | None = None
        self._stream_lock = threading.Lock()
        self._stream_factory = stream_factory
        self._output_factory = output_factory
        self._last: np.ndarray | None = None
        self._overruns = 0
        self._underruns = 0
        self._consec_underruns = 0
        self._silent_since: float | None = None
        self._peak = 0.0
        self._ovr_mark_t: float | None = None
        self._ovr_mark_val = 0
        self._overload = False
        self._dev_name: str | None = None

    def _on_audio(self, indata, frames=None, time_info=None, status=None) -> None:
        if status:
            self._overruns += 1
        item = np.asarray(indata, dtype="float32").copy()
        if self._gain != 1.0:
            item *= self._gain
        try:
            self._q.put_nowait(item)
        except queue.Full:
            self._overruns += 1
            with contextlib.suppress(queue.Empty, queue.Full):
                self._q.get_nowait()
                self._q.put_nowait(item)

    def start(self) -> None:
        with self._stream_lock:
            if self._stream is not None:
                return
            factory = self._stream_factory or self._make_input_stream
            stream = factory(self._on_audio)
            stream.start()
            self._stream = stream

    def _make_input_stream(self, callback):
        try:
            import sounddevice as sd
        except ImportError as e:
            raise CaptureError(
                "the 'sounddevice' package isn't installed — run setup (pip install sounddevice)"
            ) from e
        try:
            info = sd.query_devices(self.device, "input")
            self._dev_name = info.get("name")
            maxin = int(info.get("max_input_channels", 0))
            if maxin < self.ndev:
                raise CaptureError(
                    f"audio device '{info.get('name', self.device)}' has {maxin} input "
                    f"channel(s) but this setup needs {self.ndev} "
                    f"(console returns + meas mic). Pick a fuller device or aggregate."
                )
        except CaptureError:
            raise
        except Exception as e:
            raise CaptureError(
                f"audio device {self.device!r} could not be opened "
                f"({type(e).__name__}: {e}). Run --list-devices and check --audio-device."
            ) from e
        try:
            return sd.InputStream(
                device=self.device,
                channels=self.ndev,
                samplerate=self.samplerate,
                blocksize=self.blocksize,
                dtype="float32",
                callback=callback,
            )
        except Exception as e:
            raise CaptureError(
                f"could not open audio device {self.device!r} at {self.samplerate} Hz "
                f"({type(e).__name__}: {e}). It may be in use by another app, or not "
                f"support {self.samplerate} Hz."
            ) from e

    def stop(self) -> None:
        with self._stream_lock:
            if self._stream is not None:
                try:
                    self._stream.stop()
                    self._stream.close()
                except Exception:
                    _log.debug("audio stream did not close cleanly", exc_info=True)
                self._stream = None

    def _map(self, frame: np.ndarray) -> dict[int, np.ndarray]:
        n = frame.shape[0]
        ncols = frame.shape[1] if frame.ndim == 2 else 1
        out: dict[int, np.ndarray] = {}
        for ch, dev in self.channel_map.items():
            if frame.ndim == 2 and dev < ncols:
                out[ch] = np.ascontiguousarray(frame[:, dev], dtype="float32")
            else:
                out[ch] = np.zeros(n, dtype="float32")
        return out

    SILENCE_AFTER = 4
    SILENCE_FLOOR = 1e-4
    SILENCE_HOLD_S = 5.0

    def block(self) -> dict[int, np.ndarray]:
        frame = None
        while True:
            try:
                frame = self._q.get_nowait()
            except queue.Empty:
                break
        if frame is not None:
            self._consec_underruns = 0
            self._last = frame
            self._track_silence(frame)
        else:
            self._underruns += 1
            self._consec_underruns += 1
            if self._consec_underruns > self.SILENCE_AFTER or self._last is None:
                frame = np.zeros((self.blocksize, self.ndev), "float32")
            else:
                frame = self._last
        return self._map(frame)

    def _track_silence(self, frame: np.ndarray) -> None:
        self._peak = float(np.max(np.abs(frame))) if frame.size else 0.0
        if self._peak >= self.SILENCE_FLOOR:
            self._silent_since = None
        elif self._silent_since is None:
            self._silent_since = time.monotonic()

    def dead(self) -> bool:
        """True if the input stream has stopped delivering audio (stale)."""
        return self._consec_underruns > self.SILENCE_AFTER

    def silent(self) -> bool:
        """Stream is delivering frames but they're digital silence for a while —
        the signature of a denied mic permission, a muted input, or zero gain."""
        if self._stream is None or self.dead() or self._silent_since is None:
            return False
        return (time.monotonic() - self._silent_since) > self.SILENCE_HOLD_S

    OVERLOAD_RATE = 10.0

    def overload(self) -> bool:
        """True if the interface is dropping samples (xruns) at a sustained rate —
        usually an undersized device buffer. Evaluated on a ~2 s window."""
        now = time.monotonic()
        if self._ovr_mark_t is None:
            self._ovr_mark_t, self._ovr_mark_val = now, self._overruns
            return False
        dt = now - self._ovr_mark_t
        if dt >= 2.0:
            rate = (self._overruns - self._ovr_mark_val) / dt
            self._ovr_mark_t, self._ovr_mark_val = now, self._overruns
            self._overload = rate > self.OVERLOAD_RATE
        return self._overload

    def restart(self) -> bool:
        """Re-open the input stream (e.g. after a USB unplug/replug)."""
        self.stop()
        try:
            self.start()
            self._consec_underruns = 0
            self._silent_since = None
            return True
        except Exception:
            _log.debug("audio device re-open failed", exc_info=True)
            return False

    def capture_meas(self, seconds: float) -> np.ndarray | None:
        dev = self.channel_map.get(self.meas_ch)
        if dev is None:
            return None
        need = int(seconds * self.samplerate)
        chunks, got = [], 0
        deadline = time.monotonic() + seconds + 3.0
        while got < need and time.monotonic() < deadline:
            try:
                frame = self._q.get(timeout=0.5)
            except queue.Empty:
                continue
            if frame.ndim == 2 and dev < frame.shape[1]:
                col = np.ascontiguousarray(frame[:, dev], dtype="float32")
                chunks.append(col)
                got += col.size
        if not chunks:
            return None
        return np.concatenate(chunks)[:need].astype(np.float32)

    def auto_gain(
        self, target_dbfs: float = -32.0, seconds: float = 0.6, max_db: float = 48.0
    ) -> float:
        """Sample a moment of the meas mic and set the digital input gain to bring
        a quiet (e.g. dynamic) mic up to ~target. Call right after start(), before
        the engine loop drains the queue. Returns the gain applied (dB)."""
        self.gain_db, self._gain = 0.0, 1.0
        time.sleep(0.4)
        rec = self.capture_meas(seconds)
        if rec is None or not rec.size:
            self._auto_db = None
            return 0.0
        rms = float(np.sqrt(np.mean(rec.astype(np.float64) ** 2))) + 1e-9
        level_db = float(20.0 * np.log10(rms))
        self._auto_db = level_db
        boost = max(0.0, min(max_db, target_dbfs - level_db))
        self.gain_db = round(float(boost), 1)
        self._gain = 10.0 ** (self.gain_db / 20.0)
        return self.gain_db

    def emit_pink_noise(self, samples: np.ndarray) -> bool:
        try:
            if self._output_factory:
                self._output_factory(samples, self.samplerate)
                return True
            import sounddevice as sd

            sd.play(samples, self.samplerate, device=self.output_device)
            return True
        except Exception:
            _log.warning("could not play calibration noise", exc_info=True)
            return False

    def status(self) -> dict:
        return {
            "kind": "audio",
            "overruns": self._overruns,
            "underruns": self._underruns,
            "dead": self.dead(),
            "silent": self.silent(),
            "overload": self.overload(),
            "peak": round(self._peak, 5),
            "name": self._dev_name,
            "device": str(self.device),
            "channels": self.ndev,
        }


def _rank_inputs(devs, hostapis, default_name, prefer_sr: int = C.SAMPLE_RATE):
    """Rank input-capable devices best-first. Pure + testable. Returns a list of
    {index, name, channels, samplerate, hostapi} dicts.

    The same physical mic often appears once per host API (MME/DirectSound/WASAPI
    on Windows); this prefers the entry that natively matches the app's rate and a
    low-latency API, and an external mic over a built-in laptop array."""
    cands = [(i, d) for i, d in enumerate(devs) if d.get("max_input_channels", 0) > 0]

    def api_name(d):
        h = d.get("hostapi")
        return hostapis[h]["name"] if isinstance(h, int) and 0 <= h < len(hostapis) else ""

    def score(item):
        _i, d = item
        name = d.get("name") or ""
        s = 0.0
        if default_name and name == default_name:
            s += 10.0
        if round(d.get("default_samplerate", 0) or 0) == prefer_sr:
            s += 5.0
        api = api_name(d)
        if "ASIO" in api:
            s += 4.0
        elif any(k in api for k in ("WASAPI", "Core Audio", "ALSA", "JACK")):
            s += 3.0
        if any(k in name.lower() for k in ("array", "built-in", "built in", "internal")):
            s -= 15.0
        s += min(2.0, d.get("max_input_channels", 0) * 0.01)
        return s

    ranked = sorted(cands, key=score, reverse=True)
    return [
        {
            "index": i,
            "name": d.get("name"),
            "channels": int(d.get("max_input_channels", 1)),
            "samplerate": round(d.get("default_samplerate", prefer_sr) or prefer_sr),
            "hostapi": api_name(d),
        }
        for i, d in ranked
    ]


def _pick_input(devs, hostapis, default_name, prefer_sr: int = C.SAMPLE_RATE):
    r = _rank_inputs(devs, hostapis, default_name, prefer_sr)
    return r[0] if r else None


def autodetect_inputs(prefer_sr: int = C.SAMPLE_RATE):
    """Ranked list (best-first) of input devices on this machine (Windows/macOS).
    No device is opened here — the caller opens each in order for real and keeps
    the first that actually delivers audio, so a contended/dead entry is skipped
    without the double-open that WASAPI doesn't tolerate. Returns a list of dicts."""
    try:
        import sounddevice as sd

        devs = list(sd.query_devices())
        apis = list(sd.query_hostapis())
        din = sd.default.device
        di = din[0] if isinstance(din, (list, tuple)) else din
        name = devs[di].get("name") if isinstance(di, int) and 0 <= di < len(devs) else None
        return _rank_inputs(devs, apis, name, prefer_sr)
    except Exception:
        _log.debug("input device scan failed", exc_info=True)
        return []


def parse_channel_map(spec: str) -> dict[int, int]:
    """Parse a '--channel-map' string into a {console_ch: device_column} map.

    Format: comma-separated `console:device` pairs, e.g. '1:0,2:1,8:9' means
    console channel 8 (the meas mic) is on device input column 9. Console
    channels are 1-based; device columns are 0-based. Raises ValueError on
    malformed input so the CLI can fail fast with a clear message."""
    out: dict[int, int] = {}
    for pair in spec.split(","):
        pair = pair.strip()
        if not pair:
            continue
        if ":" not in pair:
            raise ValueError(f"entry '{pair}' must be console:device (e.g. 8:9)")
        c, d = pair.split(":", 1)
        try:
            ch, dev = int(c), int(d)
        except ValueError:
            raise ValueError(f"entry '{pair}' has non-integer channel/column") from None
        if ch < 1 or dev < 0:
            raise ValueError(f"entry '{pair}': console channel >= 1, device column >= 0")
        out[ch] = dev
    if not out:
        raise ValueError("channel-map is empty")
    return out


def _format_device_list(devs, apis) -> str:
    """Pure formatter for --list-devices (host API included so an operator can
    pick the right WASAPI/ASIO instance of a device). Split out to be testable
    without hardware; list_audio_devices() feeds it live sounddevice data."""
    lines = []
    for i, d in enumerate(devs):
        if d.get("max_input_channels", 0) > 0:
            h = d.get("hostapi")
            api = apis[h]["name"] if isinstance(h, int) and 0 <= h < len(apis) else "?"
            lines.append(
                f"  [{i}] {d['name']}  ({d['max_input_channels']} in, "
                f"{int(d.get('default_samplerate', 0))} Hz, {api})"
            )
    return "Input devices:\n" + ("\n".join(lines) or "  (none found)")


def list_audio_devices() -> str:
    """Human-readable list of input audio devices (for --list-devices)."""
    try:
        import sounddevice as sd

        return _format_device_list(list(sd.query_devices()), list(sd.query_hostapis()))
    except Exception as e:
        return f"could not list audio devices: {e}"
