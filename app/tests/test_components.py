"""Direct unit tests for the new components' logic branches — handlers, parsers,
guards, and edge cases that the integration/socket tests exercise in threads but
don't line-trace. Robustness + error-path coverage."""

import importlib.util
import os
import shutil
import sys
import tempfile
import time
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from trio_mix import config as C
from trio_mix import template as tmpl
from trio_mix import venue
from trio_mix.capture import CaptureSource
from trio_mix.emulator import EmulatedDesk, TimedAudioStream
from trio_mix.engine import Engine
from trio_mix.metersrv import MeterReceiver, decode_meter_blob
from trio_mix.osc import ConsoleBase
from trio_mix.sessionlog import SessionLog
from trio_mix.showclock import AbleSetReceiver, SimShowClock

_HAVE_OSC = importlib.util.find_spec("pythonosc") is not None


def _free_udp_port():
    import socket

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class _FakeClient:
    def __init__(self):
        self.sent = []

    def send_message(self, addr, val):
        self.sent.append((addr, val))


@unittest.skipUnless(_HAVE_OSC, "python-osc not installed")
class TestAbleSetSocket(unittest.TestCase):
    def test_osc_roundtrip_fires_on_change(self):
        from pythonosc.udp_client import SimpleUDPClient

        port = _free_udp_port()
        got = []
        rx = AbleSetReceiver(on_change=lambda st: got.append(st), port=port)
        rx.start()
        try:
            cli = SimpleUDPClient("127.0.0.1", port)
            self.addCleanup(cli._sock.close)
            cli.send_message("/setlist/nextSongName", "Bloom")
            cli.send_message("/setlist/activeSongName", "Gravity")
            deadline = time.monotonic() + 2.0
            while not got and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(got, "AbleSet OSC round-trip did not fire on_change")
            self.assertEqual(got[-1].song_name, "Gravity")
        finally:
            rx.stop()


class TestEmulatorHandlers(unittest.TestCase):
    def _desk(self):
        d = EmulatedDesk()
        d._client = _FakeClient()
        return d

    def test_fader_updates_and_echoes_when_subscribed(self):
        d = self._desk()
        d.subscribed = True
        d._h_fader("/ch/04/mix/fader", 0.6)
        self.assertAlmostEqual(d.fader[4], 0.6)
        self.assertEqual(d._client.sent[-1], ("/ch/04/mix/fader", 0.6))
        self.assertEqual(d.echo_count, 1)

    def test_fader_no_echo_when_not_subscribed(self):
        d = self._desk()
        d._h_fader("/ch/04/mix/fader", 0.6)
        self.assertEqual(d._client.sent, [])
        self.assertAlmostEqual(d.fader[4], 0.6)

    def test_fader_bad_arg_and_addr_ignored(self):
        d = self._desk()
        d._h_fader("/ch/04/mix/fader", "loud")
        d._h_fader("/ch/zz/mix/fader", 0.5)
        self.assertEqual(d.fader, {})

    def test_mute_scene_subscribe_default(self):
        d = self._desk()
        d._h_mute("/ch/02/mix/on", 0)
        self.assertTrue(d.mute[2])
        d._h_mute("/ch/02/mix/on", 1)
        self.assertFalse(d.mute[2])
        d._h_scene("/-action/goscene", 5)
        self.assertEqual(d.scene, 5)
        d._h_scene("/-action/goscene", "x")
        self.assertEqual(d.scene, 5)
        d._h_xremote("/xremote")
        self.assertTrue(d.subscribed)
        before = d.recv_count
        d._h_default("/whatever", 1)
        self.assertEqual(d.recv_count, before + 1)

    def test_ext_pick_handles_meas_only_map(self):
        from unittest import mock

        with (
            mock.patch.object(C, "CHANNELS", {1: "meas_mic"}),
            mock.patch.object(C, "MEAS_MIC_CH", 1),
        ):
            self.assertIsNone(EmulatedDesk._ext_pick(0))
        self.assertIsNotNone(EmulatedDesk._ext_pick(0))

    def test_move_fader_externally(self):
        d = self._desk()
        d.move_fader_externally(2, -6.0)
        self.assertEqual(d._client.sent[-1][0], "/ch/02/mix/fader")
        self.assertIn(2, d.fader)

    def test_subscribe_starts_meter_thread_once(self):
        d = EmulatedDesk(meter_hz=80.0)
        d._client = _FakeClient()
        d._h_subscribe("/batchsubscribe")
        t = d._meter_thread
        self.assertIsNotNone(t)
        d._h_subscribe("/batchsubscribe")
        self.assertIs(d._meter_thread, t)
        deadline = time.monotonic() + 1.0
        while d.meters_sent < 1 and time.monotonic() < deadline:
            time.sleep(0.02)
        d.stop()
        self.assertGreaterEqual(d.meters_sent, 1)
        self.assertEqual(d._client.sent[-1][0], "/meters/1")


class TestTimedAudioStream(unittest.TestCase):
    def test_default_content_shape_dtype(self):
        ts = TimedAudioStream(callback=lambda *a: None, channels=8)
        f = ts._default_content(50)
        self.assertEqual(f.shape, (C.BLOCK, 8))
        self.assertEqual(f.dtype, np.float32)

    def test_loop_fires_callback(self):
        got = []
        ts = TimedAudioStream(callback=lambda fr, n, t, s: got.append(fr), channels=8)
        ts.start()
        time.sleep(0.12)
        ts.stop()
        self.assertTrue(got)

    def test_deliver_false_suppresses_callbacks(self):
        got = []
        ts = TimedAudioStream(callback=lambda *a: got.append(1), channels=8)
        ts.deliver = False
        ts.start()
        time.sleep(0.1)
        ts.stop()
        self.assertEqual(got, [])

    def test_xrun_flag_propagates(self):
        statuses = []
        ts = TimedAudioStream(callback=lambda fr, n, t, s: statuses.append(s), channels=8)
        ts.xrun_next = True
        ts.start()
        time.sleep(0.12)
        ts.stop()
        self.assertIn("input overflow", statuses)


class TestShowClockBranches(unittest.TestCase):
    def test_h_bpm(self):
        rx = AbleSetReceiver()
        rx._running = True
        rx.h_bpm("/song/beatsPerMinute", 128.0)
        self.assertEqual(rx._cur.bpm, 128.0)
        rx.h_bpm("/song/beatsPerMinute", "x")
        self.assertIsNone(rx._cur.bpm)

    def test_all_handlers_noop_when_not_running(self):
        got = []
        rx = AbleSetReceiver(on_change=lambda s: got.append(s))
        rx._running = False
        rx.h_song_name("/a", "X")
        rx.h_section("/a", "Y")
        rx.h_playing("/a", 1)
        rx.h_song_index("/a", 2)
        rx.h_next_song("/a", "Z")
        rx.h_bpm("/a", 120)
        self.assertEqual(got, [])

    def test_sim_clock_stop_without_start(self):
        clk = SimShowClock(tmpl.default_template())
        clk.stop()

    def test_sim_clock_empty_template_advance(self):
        clk = SimShowClock(tmpl.ShowTemplate(songs=[]))
        clk._advance()


class TestTemplateChannelsValidation(unittest.TestCase):
    def test_invalid_variants(self):
        for bad in (
            {"channels": "nope"},
            {"channels": {"map": "nope"}},
            {"channels": {"map": {}}},
            {"channels": {"map": {"1": "v"}, "stereo_links": "x"}},
            {"channels": {"map": {"1": "v"}, "stereo_links": [[1]]}},
            {"channels": {"map": {"1": "v"}, "balance": "x"}},
            {"channels": {"map": {"1": "v"}, "guest": [9]}},
            {"channels": {"map": {"1": "v"}, "stage_mic": "x"}},
            {"channels": {"map": {"1": "v"}, "lead": 1.5}},
            {"channels": {"map": {"1": "v"}, "meas_mic": 9}},
        ):
            with self.assertRaises(tmpl.TemplateError):
                tmpl.from_dict(bad)

    def test_valid_full_channels_block(self):
        t = tmpl.from_dict(
            {
                "channels": {
                    "map": {"1": "v", "2": "g"},
                    "balance": [2],
                    "guest": [1],
                    "stereo_links": [[1, 2]],
                    "stage_mic": 1,
                    "lead": 1,
                    "meas_mic": 2,
                }
            }
        )
        self.assertIsNotNone(t.channels)
        self.assertEqual(t.channels["lead"], 1)


class _FakeVenueLog:
    def __init__(self, msgs, shows=1):
        self._msgs, self._shows = msgs, shows

    def venue_feedback(self, venue):
        return self._msgs

    def venue_shows(self, venue):
        return self._shows


class TestVenueRobust(unittest.TestCase):
    def test_load_corrupt_json_returns_none(self):
        d = tempfile.mkdtemp()
        try:
            with open(os.path.join(d, venue.slug("Bad") + ".json"), "w") as f:
                f.write("{not valid json")
            self.assertIsNone(venue.load_model("Bad", d))
        finally:
            shutil.rmtree(d)

    def test_build_model_filters_absurd_and_out_of_range(self):
        log = _FakeVenueLog(
            ["99999999 Hz on x", "30000 Hz on y", "2500 Hz on z", "no freq here", "10 Hz on sub"]
        )
        m = venue.build_model(log, "X")
        hzs = [f["hz"] for f in m.feedback_freqs]
        self.assertIn(2500, hzs)
        self.assertNotIn(99999999, hzs)
        self.assertTrue(all(20 <= h <= 24000 for h in hzs))

    def test_build_model_no_feedback(self):
        m = venue.build_model(_FakeVenueLog([], shows=0), "Empty")
        self.assertEqual(m.feedback_freqs, [])
        self.assertEqual(m.confidence, 0.0)


class TestSessionLogGuards(unittest.TestCase):
    def test_venue_queries_on_empty_db(self):
        sl = SessionLog(":memory:")
        try:
            self.assertEqual(sl.venue_feedback("Nope"), [])
            self.assertEqual(sl.venue_shows("Nope"), 0)
            self.assertEqual(sl.summary(), {})
            self.assertEqual(sl.recent(), [])
        finally:
            sl.close()


class TestMeterReceiverGuards(unittest.TestCase):
    def test_decode_zero_count(self):
        import struct

        self.assertEqual(decode_meter_blob(struct.pack("<i", 0)), [])

    def test_handlers_noop_when_not_running(self):
        got = {}
        rx = MeterReceiver(
            on_fader=lambda c, d: got.setdefault("f", 1), on_meters=lambda v: got.setdefault("m", 1)
        )
        rx._running = False
        rx.handle_meters("/meters/1", b"\x00\x00\x00\x00")
        rx.handle_fader("/ch/01/mix/fader", 0.5)
        self.assertEqual(got, {})

    def test_handle_fader_bad_addr(self):
        got = []
        rx = MeterReceiver(on_fader=lambda c, d: got.append((c, d)))
        rx._running = True
        rx.handle_fader("/ch/zz/mix/fader", 0.5)
        rx.handle_fader("/ch/01/mix/fader")
        self.assertEqual(got, [])


class _RecConsole(ConsoleBase):
    def __init__(self):
        super().__init__()
        self.sent = []

    def _send(self, addr, *a):
        self.sent.append((addr, *a))


class TestRampWorker(unittest.TestCase):
    def test_ramp_sends_intermediates_off_thread(self):
        c = _RecConsole()
        end = c.ramp_fader_db(2, -10.0, -6.0, ms=20, steps=4)
        self.assertEqual(end, -6.0)
        time.sleep(0.15)
        faders = [a for a in c.sent if a[0] == "/ch/02/mix/fader"]
        self.assertGreaterEqual(len(faders), 3)
        c.close()


class _BoomSource(CaptureSource):
    def block(self):
        raise RuntimeError("boom")


class TestEngineResilience(unittest.TestCase):
    def test_bad_block_recovers_and_loop_survives(self):
        e = Engine(sim=False, source=_BoomSource(), tick=0.01)
        e.start()
        try:
            deadline = time.monotonic() + 1.5
            while time.monotonic() < deadline:
                if any("engine error" in ev["msg"] for ev in list(e.events)):
                    break
                time.sleep(0.05)
            self.assertTrue(any("engine error" in ev["msg"] for ev in list(e.events)))
            self.assertTrue(e._thread.is_alive())
        finally:
            e.stop()


class TestTemplateSongBranches(unittest.TestCase):
    def test_more_song_validation(self):
        for bad in (
            123,
            {"songs": 5},
            {"songs": [123]},
            {"songs": [{"name": "A", "balance": {"x": 1}}]},
            {"songs": [{"name": "A", "balance": "x"}]},
            {"songs": [{"name": "A", "lead_target": "loud"}]},
        ):
            with self.assertRaises(tmpl.TemplateError):
                tmpl.from_dict(bad)


if __name__ == "__main__":
    unittest.main()
