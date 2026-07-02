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

import os
import re
import threading
import time

import numpy as np

from . import config as C
from .metersrv import encode_meter_blob
from .osc import db_to_fader, fader_to_db


def _ch_from_addr(addr: str) -> int | None:
    parts = addr.split("/")
    if len(parts) >= 5 and parts[1] == "ch" and parts[3] == "mix":
        try:
            return int(parts[2])
        except ValueError:
            return None
    return None


# ---------------------------------------------------------------------------
# The desk
# ---------------------------------------------------------------------------
class EmulatedDesk:
    def __init__(self, listen_port: int = C.CONSOLE_PORT, app_ip: str = "127.0.0.1",
                 app_port: int = C.LOCAL_PORT, meter_hz: float = 10.0,
                 n_meters: int = 16, external_moves: bool = False) -> None:
        self.listen_port = listen_port
        self.app = (app_ip, app_port)
        self.meter_hz = meter_hz
        self.n_meters = n_meters
        self.external_moves = external_moves
        # desk model
        self.fader: dict[int, float] = {}      # ch -> wire position 0..1
        self.mute: dict[int, bool] = {}
        self.scene: int | None = None
        self.subscribed = False
        self.recv_count = 0                    # commands received (introspection)
        self.echo_count = 0
        self.meters_sent = 0
        # X32-Edit compatibility: a parameter model the editor can read/sync, a
        # registry of external editors subscribed for live updates, and a log of
        # every address an editor asks for (so we can extend fidelity to match it).
        self._params: dict[str, list] = {}
        self._remotes: set[tuple[str, int]] = set()     # external editors (NOT the app)
        self._clients: dict[tuple[str, int], object] = {}
        self.req_seen: set[str] = set()
        self.req_log: list[str] = []
        self.trace_requests = False            # print each new address an editor asks for
        self._local = None
        self._seed_params()
        # transport
        self._server = None
        self._client = None
        self._stop = threading.Event()
        self._meter_thread: threading.Thread | None = None
        self._ext_thread: threading.Thread | None = None
        self._i = 0

    # -- OSC handlers (the app -> the desk) --------------------------------
    def _h_fader(self, addr, *args):
        ch = _ch_from_addr(addr)
        self.recv_count += 1
        if ch is not None and args:
            try:
                pos = float(args[0])
            except (TypeError, ValueError):
                return
            self.fader[ch] = pos
            # With /xremote active a real desk pushes the change back. We echo our
            # OWN-applied position so the app's self-move suppression is tested.
            if self.subscribed and self._client is not None:
                self.echo_count += 1
                self._client.send_message(f"/ch/{ch:02d}/mix/fader", pos)

    def _h_mute(self, addr, *args):
        ch = _ch_from_addr(addr)
        self.recv_count += 1
        if ch is not None and args:
            self.mute[ch] = (float(args[0]) == 0)   # /mix/on 0 == muted

    def _h_scene(self, addr, *args):
        self.recv_count += 1
        if args:
            try:
                self.scene = int(args[0])
            except (TypeError, ValueError):
                pass

    def _h_subscribe(self, addr, *args):
        self.recv_count += 1
        self.subscribed = True
        self._start_meters()

    def _h_xremote(self, addr, *args):
        self.recv_count += 1
        self.subscribed = True

    def _h_default(self, addr, *args):
        self.recv_count += 1

    # -- X32-Edit compatibility: console-server protocol -------------------
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
        try:
            self._client_for(client).send_message(addr, list(args))
        except OSError:
            pass

    def _push(self, addr, *args, exclude=None) -> None:
        """Push a parameter change to every subscribed external editor."""
        for r in list(self._remotes):
            if r == exclude:
                continue
            self._reply(r, addr, *args)

    def _log_req(self, addr: str, args: tuple = ()) -> None:
        # /node carries the real path as an argument — log it, or every node
        # request collapses into one opaque "/node" line.
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
        if leaf in ("fader", "level", "gain", "trim", "pan", "f", "g", "q",
                    "mix", "threshold", "ratio", "attack", "release", "hold",
                    "depth", "time", "hpf", "lpf"):
            return [0.0]
        return [0]

    @staticmethod
    def _fmt(v) -> str:
        if isinstance(v, float):
            return f"{v:.4f}"
        if isinstance(v, str):
            return f'"{v}"' if (" " in v or v == "") else v
        return str(v)

    # Full default /node answer book: a real M32 scene dump (names scrubbed), one
    # line per node in exact desk text format. This is what a full-sync editor
    # (Mixing Station) parses; any node missing here falls through to _NODE_RULES.
    _NODE_TABLE: dict[str, str] | None = None    # lazy class-level cache

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
                pass                              # missing file -> rule/echo fallback
            cls._NODE_TABLE = table
        return cls._NODE_TABLE

    # X32 /node container formats (per pmaillot/X32-Behringer X32.c): a send
    # container renders as "ON <level>" (even sends) or "ON <level> <pan> <type>
    # <panFollow>" (odd sends, the pan-carrying half of a stereo pair); an output
    # renders as "<src> <pos> [<inv>]". Fallbacks for nodes absent from the table.
    _NODE_RULES = [
        (re.compile(r"^/(?:ch|auxin|fxrtn)/\d{2}/mix/(\d{2})$"),
         lambda m: "ON -oo +0 POST 0" if int(m.group(1)) % 2 else "ON -oo"),
        (re.compile(r"^/bus/\d{2}/mix/(\d{2})$"),
         lambda m: "ON -oo +0 POST 0" if int(m.group(1)) % 2 else "ON -oo"),
        # preset-library slot (ch/fx/routing), SLIBS: pos "name" type flags hasdata
        (re.compile(r"^/-libs/(?:ch|fx|r|mon)/\d{3}$"),
         lambda m: '0 "" 0 %0000000000000000 0'),
        (re.compile(r"^/outputs/main/\d{2}/delay$"), lambda m: "OFF 0.3"),
        (re.compile(r"^/outputs/(?:main|aes)/\d{2}$"), lambda m: "0 POST OFF"),
        (re.compile(r"^/outputs/rec/\d{2}$"), lambda m: "0 POST"),
        (re.compile(r"^/outputs/p16/\d{2}$"), lambda m: "0 POST OFF 0"),
    ]

    _SCOLOR = ["OFF", "RD", "GN", "YE", "BL", "MG", "CY", "WH",
               "OFFi", "RDi", "GNi", "YEi", "BLi", "MGi", "CYi", "WHi"]

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
        m = re.match(r"^/ch/(\d{2})/config$", full)
        if m:                                     # our channel map, not the table's
            name = self._params.get(full + "/name", [""])[0]
            color = int(self._params.get(full + "/color", [1])[0]) & 15
            return f'{full} "{name}" 1 {self._SCOLOR[color]} {int(m.group(1))}'
        m = re.match(r"^/ch/(\d{2})/mix$", full)
        if m:                                     # live fader/mute, quiet remainder
            ch = int(m.group(1))
            pos = self.fader.get(ch, self._params.get(f"{full}/fader", [0.75])[0])
            lvl = "-oo" if pos <= 0 else f"{fader_to_db(pos):+.1f}"
            on = "OFF" if self.mute.get(ch) else "ON"
            return f"{full} {on} {lvl} ON +0 OFF -oo"
        table = self._node_table()
        if full in table:
            return table[full]
        for rx, body_for in self._NODE_RULES:      # not in table: synthesized reply
            m = rx.match(full)
            if m:
                return f"{full} {body_for(m)}"
        if full in self._params:
            return f"{full} " + " ".join(self._fmt(v) for v in self._params[full])
        kids = [a for a in self._params if a.startswith(full + "/")]
        if kids:
            return f"{full} " + " ".join(
                self._fmt(self._params[k][0]) for k in sorted(kids) if self._params[k])
        return full                  # unknown node: echo the path so the editor moves on

    def _h_any(self, client, addr, *args):
        """Single socket entry-point (default handler, reply-address aware). Routes
        the app's commands through the existing handlers AND serves an editor's
        discovery/sync/param protocol, pushing live changes to subscribed editors."""
        self._log_req(addr, args)
        is_app = (client == self.app)

        if addr == "/info":
            return self._reply(client, "/info", *self._info())
        if addr == "/xinfo":
            return self._reply(client, "/xinfo", *self._xinfo())
        if addr == "/status":
            return self._reply(client, "/status", *self._status())
        if addr == "/node":
            return self._reply_node(client, args)
        if addr in ("/xremote", "/formatsubscribe", "/batchsubscribe"):
            if not is_app:
                self._remotes.add(client)          # external editor wants live updates
            if addr == "/batchsubscribe":
                self._h_subscribe(addr, *args)
            else:
                self._h_xremote(addr, *args)
            return
        if addr in ("/unsubscribe", "/renew"):
            self.recv_count += 1
            return
        if addr == "/showdump":
            # show-file header, per pmaillot/X32-Behringer function_showdump()
            self._reply(client, "node",
                        f'/-show/showfile/show "{C.X32_NAME}" 0 0 0 0 0 0 0 0 0 0 '
                        f'"{C.X32_FW}"\n')
            return

        ch = _ch_from_addr(addr)
        if ch is not None and addr.endswith("/mix/fader"):
            if args:
                self._h_fader(addr, *args)
                self._params[addr] = [float(args[0])]
                self._push(addr, float(args[0]), exclude=client)
                if not is_app:                     # human moved it in the editor -> app reconciles
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

        if not args:                               # generic GET
            val = self._params.get(addr)
            if val is None:
                # A real desk answers EVERY valid address; silence makes a
                # full-sync editor (Mixing Station) time out and abort. Synthesize
                # a typed default and remember it so re-reads stay consistent.
                val = self._default_for(addr)
                self._params[addr] = val
            self._reply(client, addr, *val)
            self.recv_count += 1
            return
        self._params[addr] = list(args)            # generic SET
        self._push(addr, *args, exclude=client)
        self._h_default(addr, *args)

    # -- the desk -> the app -----------------------------------------------
    def move_fader_externally(self, ch: int, db: float) -> None:
        """Simulate a HUMAN moving a fader on the desk surface: update the model
        and push the change to the app (this is what reconciliation adopts)."""
        pos = db_to_fader(db)
        self.fader[ch] = pos
        addr = f"/ch/{ch:02d}/mix/fader"
        self._params[addr] = [pos]
        if self._client is not None:
            self._client.send_message(addr, pos)
        self._push(addr, pos)                 # subscribed editors (X32-Edit) see it too

    def _start_meters(self):
        if self._meter_thread is None:
            self._meter_thread = threading.Thread(target=self._meter_loop,
                                                  name="emudesk-meters", daemon=True)
            self._meter_thread.start()

    def _meter_loop(self):
        period = 1.0 / self.meter_hz
        while not self._stop.wait(period):
            if not self.subscribed or self._client is None:
                continue
            # plausible 0..1 meter levels; values are illustrative, the LAYOUT is
            # the contract (encode_meter_blob).
            self._i += 1
            vals = (0.3 + 0.2 * np.sin(self._i * 0.2 + np.arange(self.n_meters))).tolist()
            try:
                self._client.send_message("/meters/1", encode_meter_blob(vals))
                self.meters_sent += 1
            except OSError:
                pass

    @staticmethod
    def _ext_pick(k: int):
        """Round-robin a non-meas channel to 'humanly' nudge; None if the map has
        no movable channels (e.g. a meas-mic-only bench map)."""
        chans = [c for c in C.CHANNELS if c != C.MEAS_MIC_CH]
        return chans[k % len(chans)] if chans else None

    def _ext_loop(self):
        k = 0
        while not self._stop.wait(12.0):       # every 12 s, "a human" nudges a fader
            if not self.subscribed:
                continue
            ch = self._ext_pick(k)
            if ch is None:
                continue
            k += 1
            self.move_fader_externally(ch, -8.0 + 4.0 * ((k % 3) - 1))

    # -- lifecycle ----------------------------------------------------------
    def start(self):
        from pythonosc.dispatcher import Dispatcher
        from pythonosc.osc_server import ThreadingOSCUDPServer
        from pythonosc.udp_client import SimpleUDPClient
        disp = Dispatcher()
        # One reply-address-aware entry point: _h_any routes the app's commands
        # through the existing handlers AND serves an editor's discovery/sync.
        disp.set_default_handler(self._h_any, needs_reply_address=True)
        self._server = ThreadingOSCUDPServer(("0.0.0.0", self.listen_port), disp)
        self._client = SimpleUDPClient(*self.app)
        threading.Thread(target=self._server.serve_forever, name="emudesk",
                         daemon=True).start()
        if self.external_moves:
            self._ext_thread = threading.Thread(target=self._ext_loop,
                                               name="emudesk-ext", daemon=True)
            self._ext_thread.start()
        return self

    def stop(self):
        self._stop.set()
        if self._server is not None:
            try:
                self._server.shutdown()
                self._server.server_close()
            except OSError:
                pass
            self._server = None
        for c in list(self._clients.values()) + ([self._client] if self._client else []):
            sock = getattr(c, "_sock", None)
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass
        self._clients.clear()


# ---------------------------------------------------------------------------
# Timed fake audio stream (drives the REAL capture callback at block rate)
# ---------------------------------------------------------------------------
class TimedAudioStream:
    """A stand-in for sounddevice.InputStream: a timer thread that fires the
    capture callback at the true block rate with generated multichannel content,
    so SoundDeviceCapture's queue/drop/underrun/dead paths run under real timing.
    Inject via `SoundDeviceCapture(stream_factory=...)`.

    Toggles for fault injection: `.deliver = False` simulates a device unplug
    (callbacks stop -> dead-stream detection); `.xrun_next = True` flags one xrun.
    """

    def __init__(self, callback, channels: int, samplerate: int = C.SAMPLE_RATE,
                 blocksize: int = C.BLOCK, content=None, seed: int = 5) -> None:
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
            # Deliver as many blocks as wall-clock demands. On a busy machine (e.g.
            # serving the dashboard to a phone) the daemon thread can be descheduled
            # for >100 ms; a plain wait(period) would then starve the consumer and
            # trip a FALSE dead-stream alert. Catching up keeps the queue fed.
            burst = 0
            while next_t <= now and burst < 8:
                if self.deliver:                # deliver=False == "unplugged"
                    frame = self.content(self._i)
                    self._i += 1
                    status = "input overflow" if self.xrun_next else None
                    self.xrun_next = False
                    try:
                        self.callback(frame, self.blocksize, None, status)
                    except Exception:
                        pass
                next_t += period
                burst += 1
            if next_t <= now:                   # capped the burst -> resync, no backlog
                next_t = now + period
            if self._stop.wait(max(0.001, min(period, next_t - time.perf_counter()))):
                break

    def start(self):
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="timed-audio",
                                           daemon=True)
            self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
            self._thread = None

    def close(self):
        self.stop()
