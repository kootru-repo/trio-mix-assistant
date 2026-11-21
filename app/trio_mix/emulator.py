"""Emulated hardware — a protocol-faithful M32C + audio interface for testing the
REAL stack (OscConsole over a real UDP socket, MeterReceiver, reconciliation, the
SoundDeviceCapture queue) with NO physical gear.

This is a big fidelity jump over SimConsole (an in-process stub): here the app's
actual OSC bytes cross a socket to `EmulatedDesk`, which applies them to a desk
model and streams `/meters` + echoes `/xremote` fader pushes back exactly as the
desk would. It exercises framing, encode/decode, the subscribe/renew handshake,
self-move-echo vs. reconciliation timing, scene-recall round-trips, reconnect,
and the capture timing path.

HARD LIMIT (read this): every wire format below is OUR ASSUMPTION about the X32/
M32 protocol — the same assumption the app's code makes. So this emulator proves
the app is *internally consistent and protocol-mechanically correct*; it does NOT
prove the assumptions match your firmware. The constants tagged `# VERIFY:` are
the ones to confirm against a real-desk capture / the published X32 OSC protocol
(see HARDWARE_BRINGUP.md). Pin the contract tests to that reference to close the
loop.
"""

from __future__ import annotations

import contextlib
import logging
import os
import re
import threading
import time
from collections.abc import Callable
from typing import Any, ClassVar

import numpy as np

from . import config as C
from .metersrv import encode_meter_blob
from .osc import db_to_fader, fader_to_db

_log = logging.getLogger(__name__)


def _ch_from_addr(addr: str) -> int | None:
    parts = addr.split("/")
    if len(parts) >= 5 and parts[1] == "ch" and parts[3] == "mix":
        try:
            return int(parts[2])
        except ValueError:
            return None
    return None


class EmulatedDesk:
    def __init__(
        self,
        listen_port: int = C.CONSOLE_PORT,
        app_ip: str = "127.0.0.1",
        app_port: int = C.LOCAL_PORT,
        meter_hz: float = 10.0,
        n_meters: int = 16,
        external_moves: bool = False,
    ) -> None:
        self.listen_port = listen_port
        self.app = (app_ip, app_port)
        self.meter_hz = meter_hz
        self.n_meters = n_meters
        self.external_moves = external_moves
        self.fader: dict[int, float] = {}
        self.mute: dict[int, bool] = {}
        self.scene: int | None = None
        self.subscribed = False
        self.recv_count = 0
        self.echo_count = 0
        self.meters_sent = 0
        self._params: dict[str, list] = {}
        self._remotes: set[tuple[str, int]] = set()
        self._clients: dict[tuple[str, int], object] = {}
        self.scene_names: dict[int, str] = {}
        self._meter_subs: dict[tuple, dict] = {}
        self.req_seen: set[str] = set()
        self.req_log: list[str] = []
        self.trace_requests = False
        self._local: str | None = None
        self._seed_params()
        self._server: Any | None = None
        self._client: Any | None = None
        self._stop = threading.Event()
        self._meter_thread: threading.Thread | None = None
        self._ext_thread: threading.Thread | None = None
        self._i = 0

    def _h_fader(self, addr, *args):
        ch = _ch_from_addr(addr)
        self.recv_count += 1
        if ch is not None and args:
            try:
                pos = float(args[0])
            except (TypeError, ValueError):
                return
            self.fader[ch] = pos
            if self.subscribed and self._client is not None:
                self.echo_count += 1
                self._client.send_message(f"/ch/{ch:02d}/mix/fader", pos)

    def _h_mute(self, addr, *args):
        ch = _ch_from_addr(addr)
        self.recv_count += 1
        if ch is not None and args:
            self.mute[ch] = float(args[0]) == 0

    def _h_scene(self, addr, *args):
        self.recv_count += 1
        if args:
            with contextlib.suppress(TypeError, ValueError):
                self.scene = int(args[0])

    _METER_COUNTS: ClassVar[dict[int, int]] = {
        0: 70,
        1: 96,
        2: 49,
        3: 22,
        4: 82,
        5: 27,
        6: 4,
        7: 16,
        8: 6,
        9: 32,
        10: 32,
        11: 5,
        12: 4,
        13: 48,
        14: 80,
        15: 50,
        16: 48,
    }

    def _add_meter_sub(self, client, addr, args) -> None:
        """Register an editor's meter stream. `/meters ,s /meters/N [tf]` streams
        to the sender at that address; `/batchsubscribe alias path ...` streams to
        `alias`. A real desk stops after ~10 s unless the editor sends /renew —
        an editor (Mixing Station) treats a silent desk as dead and reconnects."""
        if addr == "/meters" and args:
            alias = path = str(args[0])
        elif addr in ("/batchsubscribe", "/formatsubscribe") and len(args) >= 2:
            alias, path = str(args[0]), str(args[1])
        else:
            return
        m = re.match(r"^meters/(\d+)$", path.lstrip("/"))
        if not m:
            return
        count = self._METER_COUNTS.get(int(m.group(1)), 96)
        if not alias.startswith("/"):
            alias = "/" + alias
        self._meter_subs[(client, alias)] = {"path": path, "count": count, "last": time.monotonic()}
        self._start_meters()

    def _h_subscribe(self, addr, *args):
        self.recv_count += 1
        self.subscribed = True
        self._start_meters()

    def _h_xremote(self, addr, *args):
        self.recv_count += 1
        self.subscribed = True

    def _h_default(self, addr, *args):
        self.recv_count += 1

    def _local_ip(self) -> str:
        if self._local is None:
            import socket

            try:
                s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                s.connect(("8.8.8.8", 80))
                self._local = s.getsockname()[0]
                s.close()
            except OSError:
                self._local = "127.0.0.1"
        return self._local

    def _seed_params(self) -> None:
        """Seed the parameters an editor reads on connect, so it shows a coherent
        desk instead of blanks. Channel names/colors + faders/mutes + main fader."""
        from .osc import db_to_fader

        for ch in range(1, 33):
            role = C.CHANNELS.get(ch)
            name = (C.ROLE_LABELS.get(role, role) if role else "")[:12]
            self._params[f"/ch/{ch:02d}/config/name"] = [name]
            self._params[f"/ch/{ch:02d}/config/color"] = [(ch % 8) + 1]
            self._params[f"/ch/{ch:02d}/config/icon"] = [1]
            self._params[f"/ch/{ch:02d}/mix/fader"] = [db_to_fader(0.0)]
            self._params[f"/ch/{ch:02d}/mix/on"] = [1]
        self._params["/main/st/mix/fader"] = [db_to_fader(0.0)]
        self._params["/main/st/mix/on"] = [1]
        self._params["/main/st/config/name"] = ["Main LR"]
        self._params["/-prefs/name"] = [C.X32_NAME]

    def _client_for(self, client):
        c = self._clients.get(client)
        if c is None:
            from pythonosc.udp_client import SimpleUDPClient

            c = SimpleUDPClient(client[0], client[1])
            self._clients[client] = c
        return c

    def _reply(self, client, addr, *args) -> None:
        with contextlib.suppress(OSError):
            self._client_for(client).send_message(addr, list(args))

    def _push(self, addr, *args, exclude=None) -> None:
        """Push a parameter change to every subscribed external editor."""
        for r in list(self._remotes):
            if r == exclude:
                continue
            self._reply(r, addr, *args)

    def _log_req(self, addr: str, args: tuple = ()) -> None:
        key = f"{addr} {args[0]}" if (addr == "/node" and args) else addr
        if key not in self.req_seen:
            self.req_seen.add(key)
            if len(self.req_log) < 1000:
                self.req_log.append(key)
            if self.trace_requests:
                print(f"  [emu] editor asked: {key}")

    def _info(self):
        return (C.X32_SERVER_VER, C.X32_NAME, C.X32_MODEL, C.X32_FW)

    def _xinfo(self):
        return (self._local_ip(), C.X32_NAME, C.X32_MODEL, C.X32_FW)

    def _status(self):
        return ("active", self._local_ip(), C.X32_NAME)

    @staticmethod
    def _default_for(addr: str) -> list:
        """Best-guess default for an unmodeled parameter GET, typed by the leaf
        name (strings for names, floats for continuous params, ints otherwise).
        VERIFY: real per-address types/values come from a desk capture; this only
        keeps a syncing editor moving instead of timing out."""
        leaf = addr.rsplit("/", 1)[-1]
        if leaf in ("name", "source"):
            return [""]
        if leaf in (
            "fader",
            "level",
            "gain",
            "trim",
            "pan",
            "f",
            "g",
            "q",
            "mix",
            "threshold",
            "ratio",
            "attack",
            "release",
            "hold",
            "depth",
            "time",
            "hpf",
            "lpf",
        ):
            return [0.0]
        return [0]

    @staticmethod
    def _fmt(v) -> str:
        if isinstance(v, float):
            return f"{v:.4f}"
        if isinstance(v, str):
            return f'"{v}"' if (" " in v or v == "") else v
        return str(v)

    _NODE_TABLE: dict[str, str] | None = None

    @classmethod
    def _node_table(cls) -> dict[str, str]:
        if cls._NODE_TABLE is None:
            table = {}
            path = os.path.join(os.path.dirname(__file__), "x32_default_nodes.scn")
            try:
                with open(path, encoding="utf-8") as fh:
                    for ln in fh:
                        ln = ln.rstrip()
                        if ln.startswith("/"):
                            table[ln.split(" ", 1)[0]] = ln
            except OSError:
                _log.debug("default node table unavailable; using rule fallback", exc_info=True)
            cls._NODE_TABLE = table
        return cls._NODE_TABLE

    _NODE_RULES: ClassVar[list[tuple[re.Pattern[str], Callable[[re.Match[str]], str]]]] = [
        (
            re.compile(r"^/(?:ch|auxin|fxrtn)/\d{2}/mix/(\d{2})$"),
            lambda m: "ON -oo +0 POST 0" if int(m.group(1)) % 2 else "ON -oo",
        ),
        (
            re.compile(r"^/bus/\d{2}/mix/(\d{2})$"),
            lambda m: "ON -oo +0 POST 0" if int(m.group(1)) % 2 else "ON -oo",
        ),
        (re.compile(r"^/-libs/(?:ch|fx|r|mon)/\d{3}$"), lambda m: '0 "" 0 %0000000000000000 0'),
        (re.compile(r"^/-show/showfile/cue/\d{3}$"), lambda m: '0 "" 0 0 0 0 0 0 0'),
        (re.compile(r"^/-show/showfile/scene/\d{3}$"), lambda m: '"" "" %000000000 0'),
        (re.compile(r"^/-show/showfile/snippet/\d{3}$"), lambda m: '"" 0 0 0 0 0'),
        (re.compile(r"^/outputs/main/\d{2}/delay$"), lambda m: "OFF 0.3"),
        (re.compile(r"^/outputs/(?:main|aes)/\d{2}$"), lambda m: "0 POST OFF"),
        (re.compile(r"^/outputs/rec/\d{2}$"), lambda m: "0 POST"),
        (re.compile(r"^/outputs/p16/\d{2}$"), lambda m: "0 POST OFF 0"),
    ]

    _SCOLOR: ClassVar[list[str]] = [
        "OFF",
        "RD",
        "GN",
        "YE",
        "BL",
        "MG",
        "CY",
        "WH",
        "OFFi",
        "RDi",
        "GNi",
        "YEi",
        "BLi",
        "MGi",
        "CYi",
        "WHi",
    ]

    def _reply_node(self, client, args) -> None:
        """Answer /node — the editor's bulk state read, one desk-format text line.
        Order: live-state overrides (channel config/mix) -> the default scene table
        -> synthesized container rules -> modeled params -> bare-path echo. A real
        desk terminates every node reply with a newline; strict editors (Mixing
        Station) may not accept the reply without it."""
        path = (args[0] if args else "").strip("/")
        full = "/" + path
        self._reply(client, "node", self._node_body(full) + "\n")

    def _node_body(self, full: str) -> str:
        if full == "/-show/showfile/show":
            return f'{full} "{C.X32_NAME}" 0 0 0 0 0 0 0 0 0 0 "{C.X32_FW}"'
        m = re.match(r"^/-show/showfile/scene/(\d{3})$", full)
        if m and int(m.group(1)) in self.scene_names:
            return f'{full} "{self.scene_names[int(m.group(1))]}" "" %111111111 1'
        m = re.match(r"^/ch/(\d{2})/config$", full)
        if m:
            name = self._params.get(full + "/name", [""])[0]
            color = int(self._params.get(full + "/color", [1])[0]) & 15
            return f'{full} "{name}" 1 {self._SCOLOR[color]} {int(m.group(1))}'
        m = re.match(r"^/ch/(\d{2})/mix$", full)
        if m:
            ch = int(m.group(1))
            pos = self.fader.get(ch, self._params.get(f"{full}/fader", [0.75])[0])
            lvl = "-oo" if pos <= 0 else f"{fader_to_db(pos):+.1f}"
            on = "OFF" if self.mute.get(ch) else "ON"
            return f"{full} {on} {lvl} ON +0 OFF -oo"
        table = self._node_table()
        if full in table:
            return table[full]
        for rx, body_for in self._NODE_RULES:
            m = rx.match(full)
            if m:
                return f"{full} {body_for(m)}"
        if full in self._params:
            return f"{full} " + " ".join(self._fmt(v) for v in self._params[full])
        kids = [a for a in self._params if a.startswith(full + "/")]
        if kids:
            return f"{full} " + " ".join(
                self._fmt(self._params[k][0]) for k in sorted(kids) if self._params[k]
            )
        return full

    def _h_any(self, client, addr, *args):
        """Single socket entry-point (default handler, reply-address aware). Routes
        the app's commands through the existing handlers AND serves an editor's
        discovery/sync/param protocol, pushing live changes to subscribed editors."""
        self._log_req(addr, args)
        is_app = client == self.app

        if addr == "/info":
            return self._reply(client, "/info", *self._info())
        if addr == "/xinfo":
            return self._reply(client, "/xinfo", *self._xinfo())
        if addr == "/status":
            return self._reply(client, "/status", *self._status())
        if addr == "/node":
            return self._reply_node(client, args)
        if addr in ("/xremote", "/formatsubscribe", "/batchsubscribe", "/meters"):
            if not is_app:
                self._remotes.add(client)
                self._add_meter_sub(client, addr, args)
            if addr == "/batchsubscribe":
                self._h_subscribe(addr, *args)
            elif addr != "/meters":
                self._h_xremote(addr, *args)
            return
        if addr in ("/unsubscribe", "/renew"):
            self.recv_count += 1
            now = time.monotonic()
            for key, sub in list(self._meter_subs.items()):
                if key[0] == client:
                    if addr == "/renew":
                        sub["last"] = now
                    else:
                        del self._meter_subs[key]
            return
        if addr == "/showdump":
            self._reply(
                client,
                "node",
                f'/-show/showfile/show "{C.X32_NAME}" 0 0 0 0 0 0 0 0 0 0 "{C.X32_FW}"\n',
            )
            return

        ch = _ch_from_addr(addr)
        if ch is not None and addr.endswith("/mix/fader"):
            if args:
                self._h_fader(addr, *args)
                self._params[addr] = [float(args[0])]
                self._push(addr, float(args[0]), exclude=client)
                if not is_app:
                    self._client.send_message(addr, float(args[0]))
            else:
                self._reply(client, addr, self.fader.get(ch, self._params.get(addr, [0.0])[0]))
            return
        if ch is not None and addr.endswith("/mix/on"):
            if args:
                self._h_mute(addr, *args)
                self._params[addr] = [int(float(args[0]))]
                self._push(addr, int(float(args[0])), exclude=client)
            else:
                self._reply(client, addr, 0 if self.mute.get(ch) else 1)
            return
        if addr == "/-action/goscene":
            if args:
                self._h_scene(addr, *args)
            return

        if not args:
            val = self._params.get(addr)
            if val is None:
                val = self._default_for(addr)
                self._params[addr] = val
            self._reply(client, addr, *val)
            self.recv_count += 1
            return
        self._params[addr] = list(args)
        self._push(addr, *args, exclude=client)
        self._h_default(addr, *args)

    def move_fader_externally(self, ch: int, db: float) -> None:
        """Simulate a HUMAN moving a fader on the desk surface: update the model
        and push the change to the app (this is what reconciliation adopts)."""
        pos = db_to_fader(db)
        self.fader[ch] = pos
        addr = f"/ch/{ch:02d}/mix/fader"
        self._params[addr] = [pos]
        if self._client is not None:
            self._client.send_message(addr, pos)
        self._push(addr, pos)

    def _start_meters(self):
        if self._meter_thread is None:
            self._meter_thread = threading.Thread(
                target=self._meter_loop, name="emudesk-meters", daemon=True
            )
            self._meter_thread.start()

    def _meter_loop(self):
        period = 1.0 / self.meter_hz
        while not self._stop.wait(period):
            if not (self.subscribed or self._meter_subs) or self._client is None:
                continue
            self._i += 1
            vals = (0.3 + 0.2 * np.sin(self._i * 0.2 + np.arange(self.n_meters))).tolist()
            if self.subscribed:
                with contextlib.suppress(OSError):
                    self._client.send_message("/meters/1", encode_meter_blob(vals))
                    self.meters_sent += 1
            now = time.monotonic()
            for (client, alias), sub in list(self._meter_subs.items()):
                if now - sub["last"] > 10.0:
                    del self._meter_subs[(client, alias)]
                    continue
                n = sub["count"]
                bank = (0.3 + 0.2 * np.sin(self._i * 0.2 + np.arange(n))).tolist()
                self._reply(client, alias, encode_meter_blob(bank))

    @staticmethod
    def _ext_pick(k: int):
        """Round-robin a non-meas channel to 'humanly' nudge; None if the map has
        no movable channels (e.g. a meas-mic-only bench map)."""
        chans = [c for c in C.CHANNELS if c != C.MEAS_MIC_CH]
        return chans[k % len(chans)] if chans else None

    def _ext_loop(self):
        k = 0
        while not self._stop.wait(12.0):
            if not self.subscribed:
                continue
            ch = self._ext_pick(k)
            if ch is None:
                continue
            k += 1
            self.move_fader_externally(ch, -8.0 + 4.0 * ((k % 3) - 1))

    def start(self):
        from pythonosc.dispatcher import Dispatcher
        from pythonosc.osc_server import ThreadingOSCUDPServer
        from pythonosc.udp_client import SimpleUDPClient

        disp = Dispatcher()
        disp.set_default_handler(self._h_any, needs_reply_address=True)
        self._server = ThreadingOSCUDPServer(("0.0.0.0", self.listen_port), disp)
        self._client = SimpleUDPClient(*self.app)
        threading.Thread(target=self._server.serve_forever, name="emudesk", daemon=True).start()
        if self.external_moves:
            self._ext_thread = threading.Thread(
                target=self._ext_loop, name="emudesk-ext", daemon=True
            )
            self._ext_thread.start()
        return self

    def stop(self):
        self._stop.set()
        if self._server is not None:
            with contextlib.suppress(OSError):
                self._server.shutdown()
                self._server.server_close()
            self._server = None
        for c in list(self._clients.values()) + ([self._client] if self._client else []):
            sock = getattr(c, "_sock", None)
            if sock is not None:
                with contextlib.suppress(OSError):
                    sock.close()
        self._clients.clear()


class TimedAudioStream:
    """A stand-in for sounddevice.InputStream: a timer thread that fires the
    capture callback at the true block rate with generated multichannel content,
    so SoundDeviceCapture's queue/drop/underrun/dead paths run under real timing.
    Inject via `SoundDeviceCapture(stream_factory=...)`.

    Toggles for fault injection: `.deliver = False` simulates a device unplug
    (callbacks stop -> dead-stream detection); `.xrun_next = True` flags one xrun.
    """

    def __init__(
        self,
        callback,
        channels: int,
        samplerate: int = C.SAMPLE_RATE,
        blocksize: int = C.BLOCK,
        content=None,
        seed: int = 5,
    ) -> None:
        self.callback = callback
        self.channels = channels
        self.samplerate = samplerate
        self.blocksize = blocksize
        self.content = content or self._default_content
        self.rng = np.random.default_rng(seed)
        self.deliver = True
        self.xrun_next = False
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._i = 0

    def _default_content(self, i: int) -> np.ndarray:
        """Noise on every channel + a rising 2.5 kHz ring on the meas-mic column,
        so the real capture path drives the assistant to catch feedback."""
        n, ch = self.blocksize, self.channels
        frame = (0.004 * self.rng.standard_normal((n, ch))).astype("float32")
        t = (i * n + np.arange(n)) / self.samplerate
        meas_col = C.MEAS_MIC_CH - 1
        if 0 <= meas_col < ch:
            amp = min(0.6, 0.03 * (1.25 ** (i % 60)))
            frame[:, meas_col] += (amp * np.sin(2 * np.pi * 2500.0 * t)).astype("float32")
        return frame

    def _loop(self):
        period = self.blocksize / self.samplerate
        next_t = time.perf_counter()
        while not self._stop.is_set():
            now = time.perf_counter()
            burst = 0
            while next_t <= now and burst < 8:
                if self.deliver:
                    frame = self.content(self._i)
                    self._i += 1
                    status = "input overflow" if self.xrun_next else None
                    self.xrun_next = False
                    try:
                        self.callback(frame, self.blocksize, None, status)
                    except Exception:
                        _log.debug("timed audio callback raised", exc_info=True)
                next_t += period
                burst += 1
            if next_t <= now:
                next_t = now + period
            if self._stop.wait(max(0.001, min(period, next_t - time.perf_counter()))):
                break

    def start(self):
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="timed-audio", daemon=True)
            self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
            self._thread = None

    def close(self):
        self.stop()
