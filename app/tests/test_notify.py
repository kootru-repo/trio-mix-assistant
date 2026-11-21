import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from trio_mix.engine import Engine
from trio_mix.showclock import ShowState


class _DeadSrc:
    def block(self):
        return {}

    def dead(self):
        return True

    def status(self):
        return {"kind": "audio", "dead": True}

    def start(self):
        pass

    def stop(self):
        pass


class _SilentSrc:
    def block(self):
        return {}

    def status(self):
        return {"kind": "audio", "silent": True}

    def start(self):
        pass

    def stop(self):
        pass


class TestOpeningBarsGate(unittest.TestCase):
    def test_warn_suppressed_in_opening_bars_but_critical_kept(self):
        e = Engine(sim=False, source=_SilentSrc())
        e.on_song_change(ShowState(song_index=0, song_name="Gravity", bpm=120, playing=True))
        with e._lock:
            e._rebuild_telemetry()
        self.assertTrue(e._in_opening_bars(time.monotonic()))
        self.assertFalse(any(a["level"] == "warn" for a in e.telemetry["alerts"]))

    def test_critical_not_suppressed_in_opening_bars(self):
        e = Engine(sim=False, source=_DeadSrc())
        e.on_song_change(ShowState(song_index=0, song_name="Gravity", bpm=120, playing=True))
        with e._lock:
            e._dead_since = time.monotonic() - 5.0
            e._rebuild_telemetry()
        self.assertTrue(e._in_opening_bars(time.monotonic()))
        self.assertTrue(any(a["level"] == "critical" for a in e.telemetry["alerts"]))

    def test_brief_dead_is_warn_not_critical_overlay(self):
        e = Engine(sim=False, source=_DeadSrc())
        levels = [a["level"] for a in e.telemetry["alerts"]]
        self.assertIn("warn", levels)
        self.assertNotIn("critical", levels)

    def test_gate_opens_after_8_bars(self):
        e = Engine(sim=False, source=_SilentSrc())
        e.on_song_change(ShowState(song_index=0, song_name="Gravity", bpm=120, playing=True))
        e._song_start_t = time.monotonic() - 20.0
        self.assertFalse(e._in_opening_bars(time.monotonic()))
        with e._lock:
            e._rebuild_telemetry()
        self.assertTrue(any(a["level"] == "warn" for a in e.telemetry["alerts"]))

    def test_not_gated_when_not_playing(self):
        e = Engine(sim=False, source=_SilentSrc())
        e.on_song_change(ShowState(song_index=0, song_name="Gravity", bpm=120, playing=False))
        self.assertFalse(e._in_opening_bars(time.monotonic()))


if __name__ == "__main__":
    unittest.main()
