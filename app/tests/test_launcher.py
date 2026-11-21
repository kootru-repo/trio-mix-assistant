"""show.conf -> run.py argument mapping."""

import contextlib
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import launcher


def _argv(cfg, **kw):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        argv, mode, port = launcher.build_argv(cfg, **kw)
    return argv, mode, port, out.getvalue()


class TestLauncher(unittest.TestCase):
    def test_pin_is_passed_through_verbatim(self):
        argv, _, _, _ = _argv({"MODE": "sim", "PIN": "0420"})
        self.assertEqual(argv[argv.index("--pin") + 1], "0420")

    def test_blank_pin_passes_no_pin_flag(self):
        argv, _, _, _ = _argv({"MODE": "sim", "PIN": ""})
        self.assertNotIn("--pin", argv)
        self.assertIn("--lan", argv)

    def test_pin_without_https_warns(self):
        _, _, _, out = _argv({"MODE": "sim", "PIN": "1234", "HTTPS": "no"})
        self.assertIn("unencrypted", out)

    def test_defaults_serve_lan_over_https(self):
        argv, mode, port, _ = _argv({})
        self.assertEqual(mode, "sim")
        self.assertEqual(port, "8770")
        self.assertIn("--lan", argv)
        self.assertIn("--https", argv)

    def test_hardware_mapping(self):
        argv, mode, _, _ = _argv(
            {"MODE": "hardware", "CONSOLE_IP": "10.0.0.9", "AUDIO_DEVICE": "3", "AUTO": "yes"}
        )
        self.assertEqual(mode, "hardware")
        self.assertIn("--hardware", argv)
        self.assertEqual(argv[argv.index("--console-ip") + 1], "10.0.0.9")
        self.assertEqual(argv[argv.index("--audio-device") + 1], "3")
        self.assertIn("--auto", argv)

    def test_rehearse_forces_emulator(self):
        argv, mode, _, _ = _argv({"MODE": "hardware", "CONSOLE_IP": "10.0.0.9"}, rehearse=True)
        self.assertEqual(mode, "emulate")
        self.assertIn("--emulate", argv)
        self.assertNotIn("--hardware", argv)

    def test_read_conf_ignores_comments_and_blank_lines(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "show.conf")
            with open(path, "w", encoding="utf-8") as f:
                f.write("# note\n\nmode = emulate\nPIN=0420\nnonsense\n")
            self.assertEqual(launcher.read_conf(path), {"MODE": "emulate", "PIN": "0420"})
        self.assertEqual(launcher.read_conf(os.path.join(d, "missing.conf")), {})

    def test_shipped_show_conf_has_a_blank_pin_key(self):
        cfg = launcher.read_conf(os.path.join(launcher.HERE, "show.conf"))
        self.assertEqual(cfg.get("PIN"), "")


if __name__ == "__main__":
    unittest.main()
