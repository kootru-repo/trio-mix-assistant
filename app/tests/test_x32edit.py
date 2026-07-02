"""X32-Edit compatibility: the EmulatedDesk must answer an editor's discovery +
sync protocol over a real socket so X32-Edit/M32-Edit can connect to --emulate and
mirror the app live. A simulated editor (one bound UDP socket the desk replies to)
drives /info/xinfo/status/node/GET, /xremote subscription + live push, and the
editor->app reconciliation feed. Pure protocol mechanics — identity strings are
VERIFY-tagged assumptions (see config.X32_*)."""
import os
import socket
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pythonosc.osc_message import OscMessage
from pythonosc.osc_message_builder import OscMessageBuilder

from trio_mix import config as C
from trio_mix.emulator import EmulatedDesk


def _free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class _FakeEditor:
    """One bound UDP socket: sends requests to the desk and receives the desk's
    reply-to-sender responses (the desk sees this socket's port as the client)."""
    def __init__(self, desk_port: int):
        self.desk = ("127.0.0.1", desk_port)
        self.sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sk.bind(("127.0.0.1", 0))
        self.sk.settimeout(1.0)
        self.port = self.sk.getsockname()[1]

    def send(self, addr, *args):
        b = OscMessageBuilder(address=addr)
        for a in args:
            b.add_arg(a)
        self.sk.sendto(b.build().dgram, self.desk)

    def recv(self):
        try:
            data, _ = self.sk.recvfrom(65535)
            m = OscMessage(data)
            return m.address, list(m.params)
        except socket.timeout:
            return None

    def ask(self, addr, *args):
        self.send(addr, *args)
        return self.recv()

    def close(self):
        self.sk.close()


class X32EditProtocol(unittest.TestCase):
    def setUp(self):
        self.app_port = _free_port()
        self.app = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.app.bind(("127.0.0.1", self.app_port))
        self.app.settimeout(0.6)
        self.desk = EmulatedDesk(listen_port=_free_port(), app_ip="127.0.0.1",
                                 app_port=self.app_port)
        self.desk.start()
        time.sleep(0.15)
        self.ed = _FakeEditor(self.desk.listen_port)

    def tearDown(self):
        self.ed.close()
        self.desk.stop()
        self.app.close()

    def _app_recv(self):
        try:
            m = OscMessage(self.app.recvfrom(65535)[0])
            return m.address, list(m.params)
        except socket.timeout:
            return None

    def test_discovery_handshake(self):
        info = self.ed.ask("/info")
        self.assertEqual(info[0], "/info")
        self.assertEqual(len(info[1]), 4)
        self.assertEqual(info[1][2], C.X32_MODEL)            # model the editor checks
        xinfo = self.ed.ask("/xinfo")
        self.assertEqual(len(xinfo[1]), 4)
        status = self.ed.ask("/status")
        self.assertEqual(status[0], "/status")
        self.assertEqual(status[1][0], "active")

    def test_param_get_reads_model(self):
        name = self.ed.ask("/ch/01/config/name")
        self.assertEqual(name[0], "/ch/01/config/name")
        self.assertIsInstance(name[1][0], str)
        fader = self.ed.ask("/ch/01/mix/fader")
        self.assertIsInstance(fader[1][0], float)

    def test_node_returns_a_node_reply(self):
        r = self.ed.ask("/node", "ch/01/config/name")
        self.assertEqual(r[0], "node")
        self.assertIn("/ch/01/config/name", r[1][0])

    def test_xremote_subscribes_and_pushes_desk_moves(self):
        self.ed.send("/xremote")
        time.sleep(0.1)
        self.assertTrue(any(p == self.ed.port for _ip, p in self.desk._remotes))
        self.desk.move_fader_externally(2, -6.0)             # 'human' on the desk
        pushed = self.ed.recv()
        self.assertIsNotNone(pushed)
        self.assertEqual(pushed[0], "/ch/02/mix/fader")

    def test_editor_move_forwards_to_app_and_updates_model(self):
        self.ed.send("/xremote")
        time.sleep(0.1)
        self.ed.send("/ch/03/mix/fader", 0.5)                # user drags a fader in the editor
        fwd = self._app_recv()                               # app hears it -> reconciles
        self.assertEqual(fwd, ("/ch/03/mix/fader", [0.5]))
        self.assertEqual(self.ed.ask("/ch/03/mix/fader")[1][0], 0.5)

    def test_unknown_request_is_logged_for_fidelity_work(self):
        self.ed.send("/showdata/blah")
        time.sleep(0.1)
        self.assertIn("/showdata/blah", self.desk.req_log)

    def test_unknown_get_is_answered_not_dropped(self):
        """Mixing Station full-syncs the whole tree; an unanswered GET stalls it
        until it aborts ("sync failed"). Every zero-arg GET must get a typed
        default reply, and re-reads must stay consistent."""
        r = self.ed.ask("/headamp/053/phantom")              # unmodeled int leaf
        self.assertEqual(r, ("/headamp/053/phantom", [0]))
        r = self.ed.ask("/-usb/dir/046/name")                # unmodeled string leaf
        self.assertEqual(r, ("/-usb/dir/046/name", [""]))
        r = self.ed.ask("/headamp/053/gain")                 # unmodeled float leaf
        self.assertEqual(r[0], "/headamp/053/gain")
        self.assertIsInstance(r[1][0], float)
        self.assertEqual(self.ed.ask("/headamp/053/gain"), r)  # consistent re-read

    def test_node_containers_answer_in_desk_format(self):
        """Mixing Station /node-reads every container and parses the positional
        desk text format; a bare-path echo reads as no data -> sync failed. Most
        answers come from the bundled default-scene table; outputs/rec+aes are
        synthesized rules; minimum token counts pin each family's field count."""
        for path, min_toks in [
            ("fxrtn/01/mix/13", 3), ("fxrtn/01/mix/14", 3),    # sends (table)
            ("outputs/rec/01", 3), ("outputs/aes/02", 4),      # rules
            ("outputs/main/03/delay", 3),                      # table: ON/OFF + ms
            ("ch/27/eq/3", 5), ("auxin/04/eq/1", 5),           # type f g q
            ("ch/10/dyn", 10), ("ch/10/gate", 5),              # dynamics families
            ("ch/27/dyn/filter", 4), ("ch/01/insert", 4),
            ("bus/05/mix/01", 3), ("headamp/000", 3),
        ]:
            r = self.ed.ask("/node", path)
            self.assertIsNotNone(r, f"no reply for /node {path}")
            self.assertEqual(r[0], "node")
            body = r[1][0]
            self.assertTrue(body.endswith("\n"), f"{path}: missing newline")
            toks = body.split()
            self.assertEqual(toks[0], "/" + path)
            self.assertGreaterEqual(len(toks), min_toks, f"{path}: {body!r}")

    def test_node_mix_and_config_reflect_live_state(self):
        """The channel mix/config node lines must mirror the emulator's live desk
        state (fader/mute/name), not the static scene table."""
        self.ed.send("/ch/03/mix/fader", 0.5)                  # -10 dB on the wire
        time.sleep(0.1)
        r = self.ed.ask("/node", "ch/03/mix")
        self.assertIn("-10.0", r[1][0])
        r = self.ed.ask("/node", "ch/01/config")
        self.assertRegex(r[1][0], r'^/ch/01/config "[^"]*" 1 \w+ 1\n$')


if __name__ == "__main__":
    unittest.main()
