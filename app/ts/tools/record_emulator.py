import socket
import threading
import time

from fixture_util import write
from pythonosc.dispatcher import Dispatcher
from pythonosc.osc_message_builder import OscMessageBuilder
from pythonosc.osc_server import ThreadingOSCUDPServer
from pythonosc.udp_client import SimpleUDPClient

from trio_mix.emulator import EmulatedDesk
from trio_mix.metersrv import decode_meter_blob

LOCAL_IP = "10.0.0.5"


def tag(v):
    if isinstance(v, int):
        return "i"
    if isinstance(v, float):
        return "f"
    return "s"


def dgram(addr, args):
    b = OscMessageBuilder(address=addr)
    for a in args:
        b.add_arg(a)
    return b.build().dgram


def udp():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    s.settimeout(0.12)
    return s


def drain(sock, window=0.12):
    out = []
    end = time.monotonic() + window
    while time.monotonic() < end:
        try:
            data, _ = sock.recvfrom(65535)
        except TimeoutError:
            continue
        out.append(data.hex())
    return out


def steps():
    s = []

    def send(addr, *args):
        s.append({"op": "send", "addr": addr, "args": [{"t": tag(a), "v": a} for a in args]})

    send("/info")
    send("/xinfo")
    send("/status")
    send("/ch/01/config/name")
    send("/ch/01/mix/fader")
    send("/ch/01/mix/on")
    send("/node", "ch/01/config/name")
    send("/node", "ch/01/config")
    send("/node", "ch/03/mix")
    send("/ch/03/mix/fader", 0.5)
    send("/ch/03/mix/fader")
    send("/node", "ch/03/mix")
    send("/ch/04/mix/on", 0)
    send("/ch/04/mix/on")
    send("/node", "/ch/04/mix/")
    send("/node", "ch/02")
    send("/node", "main/st/mix")
    send("/node", "-prefs")
    send("/node", "-show/showfile/show")
    send("/showdump")
    send("/node", "-show/showfile/scene/002")
    s.append({"op": "scene_names", "names": {"2": "Bloom"}})
    send("/node", "-show/showfile/scene/002")
    send("/node", "-show/showfile/scene/099")
    send("/node", "-show/showfile/cue/494")
    send("/node", "-show/showfile/snippet/000")
    for path in (
        "fxrtn/01/mix/13",
        "fxrtn/01/mix/14",
        "outputs/rec/01",
        "outputs/aes/02",
        "outputs/main/03/delay",
        "outputs/p16/04",
        "bus/05/mix/01",
        "bus/05/mix/02",
        "ch/27/eq/3",
        "auxin/04/eq/1",
        "ch/10/dyn",
        "ch/10/gate",
        "ch/27/dyn/filter",
        "ch/01/insert",
        "headamp/000",
        "-libs/ch/100",
        "-libs/fx/001",
        "-libs/r/050",
        "nothing/here",
    ):
        send("/node", path)
    send("/headamp/053/phantom")
    send("/-usb/dir/046/name")
    send("/headamp/053/gain")
    send("/headamp/053/gain")
    send("/ch/08/eq/1/f", 0.5)
    send("/ch/08/eq/1/f")
    send("/ch/08/eq/1/type", 2)
    send("/node", "ch/08/eq/1")
    send("/ch/09/config/name", "Kick In")
    send("/node", "ch/09/config")
    send("/ch/09/config/color", 5)
    send("/node", "ch/09/config")
    send("/node", "ch/05")
    send("/ch/10/mix/fader", 0.123456)
    send("/node", "ch/10/mix")
    send("/ch/10/mix/fader", 0.0)
    send("/node", "ch/10/mix")
    send("/xremote")
    send("/ch/11/mix/fader", 0.8)
    send("/ch/11/mix/on", 0)
    send("/ch/12/eq/2/g", 0.25)
    s.append({"op": "external", "ch": 2, "db": -6.0})
    s.append({"op": "external", "ch": 3, "db": 4.5})
    send("/-action/goscene", 7)
    send("/unsubscribe")
    send("/renew")
    send("/some/unknown/thing", 1, 2.5, "x")
    send("/some/unknown/thing")
    return s


def boot(app_port):
    desk = EmulatedDesk(listen_port=0, app_ip="127.0.0.1", app_port=app_port)
    desk._local = LOCAL_IP
    disp = Dispatcher()
    disp.set_default_handler(desk._h_any, needs_reply_address=True)
    desk._server = ThreadingOSCUDPServer(("127.0.0.1", 0), disp)
    desk._client = SimpleUDPClient("127.0.0.1", app_port)
    threading.Thread(target=desk._server.serve_forever, daemon=True).start()
    return desk, desk._server.server_address[1]


def run_script():
    app = udp()
    ed = udp()
    desk, port = boot(app.getsockname()[1])
    out = []
    try:
        for st in steps():
            if st["op"] == "send":
                ed.sendto(dgram(st["addr"], [a["v"] for a in st["args"]]), ("127.0.0.1", port))
            elif st["op"] == "external":
                desk.move_fader_externally(st["ch"], st["db"])
            elif st["op"] == "scene_names":
                desk.scene_names = {int(k): v for k, v in st["names"].items()}
            time.sleep(0.04)
            out.append({"step": st, "editor": drain(ed), "app": drain(app)})
        state = {
            "fader": {str(k): v for k, v in desk.fader.items()},
            "mute": {str(k): v for k, v in desk.mute.items()},
            "scene": desk.scene,
            "subscribed": desk.subscribed,
            "recv_count": desk.recv_count,
            "echo_count": desk.echo_count,
            "req_log": desk.req_log,
        }
    finally:
        desk.stop()
        app.close()
        ed.close()
    return out, state


def parse_blob(data):
    for off in range(0, len(data) - 8, 4):
        if data[off : off + 4] == b",b\x00\x00":
            n = int.from_bytes(data[off + 4 : off + 8], "big")
            return data[off + 8 : off + 8 + n]
    raise ValueError("no blob in packet")


def run_meters():
    res = {}
    cases = (
        ("meters2", "/meters", ["/meters/2", 2]),
        ("batch0", "/batchsubscribe", ["meters/0", "/meters/0", 0, 0, 2]),
        ("meters99", "/meters", ["/meters/99", 2]),
    )
    for name, addr, args in cases:
        app = udp()
        ed = udp()
        desk, port = boot(app.getsockname()[1])
        try:
            ed.settimeout(1.0)
            ed.sendto(dgram(addr, args), ("127.0.0.1", port))
            data, _ = ed.recvfrom(65535)
            res[name] = {
                "hex": data.hex(),
                "addr": data[: data.index(b"\x00")].decode(),
                "values": decode_meter_blob(parse_blob(data)),
            }
        finally:
            desk.stop()
            app.close()
            ed.close()
    return res


if __name__ == "__main__":
    script, state = run_script()
    write(
        "emulator",
        {"local_ip": LOCAL_IP, "script": script, "state": state, "meters": run_meters()},
    )
