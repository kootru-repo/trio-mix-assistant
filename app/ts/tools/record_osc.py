import struct

import numpy as np
from fixture_util import write
from pythonosc.osc_message_builder import OscMessageBuilder

from trio_mix import osc
from trio_mix.metersrv import decode_meter_blob, encode_meter_blob


class Capture(osc.ConsoleBase):
    def __init__(self):
        super().__init__()
        self.sent = []

    def _send(self, addr, *args):
        self.sent.append((addr, args))


class Sim(osc.SimConsole):
    pass


def tag(v):
    if isinstance(v, bool):
        raise TypeError("bool arg")
    if isinstance(v, int):
        return "i"
    if isinstance(v, float):
        return "f"
    if isinstance(v, str):
        return "s"
    raise TypeError(type(v))


def dgram(addr, args):
    b = OscMessageBuilder(address=addr)
    for a in args:
        b.add_arg(a)
    return b.build().dgram.hex()


def script(c):
    c.set_fader_db(1, -7.3)
    c.set_fader_db(2, 99.0)
    c.set_fader_db(3, -50.0)
    c.nudge_gain_db(3, 20.0, 3.5)
    c.nudge_gain_db(1, 55.0, 30.0)
    c.nudge_gain_db(0, 0.0, 0.0)
    c.set_eq_notch(1, 1, 2500.5)
    c.set_eq_notch(2, 2, 10.0, gain_db=-12.0, q=0.1)
    c.set_bus_eq(2, 250.0, -4.5)
    c.set_bus_eq(3, 99999.0, 7.0, q=20.0)
    c.set_eq_band(4, 2, 1000.0, 3.0, 2.0, False)
    c.set_eq_band(4, 3, 120.0, -2.0, 4.0)
    c.set_send(2, 1, -12.0)
    c.set_fx_return(1, -3.0)
    c.recall_scene(5)
    c.set_main_mute(True)
    c.clear_channel_eq(3)
    c.set_fader_raw(1, -100.0)
    c.set_channel_mute(2, True)
    c.set_channel_mute(2, False)
    c.set_polarity(3, True)
    c.set_main_fader(4.0)
    c.subscribe_meters()
    c.set_eq_notch(1, 4, 800.0)
    c.set_eq_notch(1, 4, 900.0)


def sim_state(c):
    return {
        "fader_db": {str(k): v for k, v in c.fader_db.items()},
        "gain_db": {str(k): v for k, v in c.gain_db.items()},
        "notches": {str(k): v for k, v in c.notches.items()},
        "bus_eq": {str(k): v for k, v in c.bus_eq.items()},
        "main_muted": c.main_muted,
        "ch_muted": {str(k): v for k, v in c.ch_muted.items()},
        "master_db": c.master_db,
        "last_scene": c.last_scene,
        "eq_bands": {str(k): {str(b): d for b, d in v.items()} for k, v in c.eq_bands.items()},
        "sends": {f"{a},{b}": v for (a, b), v in c.sends.items()},
        "fx_returns": {str(k): v for k, v in c.fx_returns.items()},
        "polarity": {str(k): v for k, v in c.polarity.items()},
        "notch_freqs_1": c.notch_freqs(1),
        "predip": c.predip_freqs(),
        "tamed": [
            c.is_tamed(1, 900.0),
            c.is_tamed(1, 1500.0),
            c.is_tamed(2, 250.0),
            c.is_tamed(1, 0.0),
        ],
    }


def tables():
    dbs = [x * 0.5 for x in range(-200, 25)]
    fs = [x * 0.01 for x in range(101)]
    hz = [5.0, 20.0, 31.5, 100.0, 440.0, 1000.0, 2500.5, 8000.0, 20000.0, 50000.0]
    qs = [0.1, 0.3, 1.0, 2.0, 4.0, 8.0, 10.0, 30.0]
    return {
        "dbs": dbs,
        "db_to_fader": [osc.db_to_fader(d) for d in dbs],
        "fs": fs,
        "fader_to_db": [osc.fader_to_db(f) for f in fs],
        "hz": hz,
        "freq_param": [osc.freq_to_eq_param(h) for h in hz],
        "param_freq": [osc.eq_param_to_freq(osc.freq_to_eq_param(h)) for h in hz],
        "qs": qs,
        "q_param": [osc.q_to_param(q) for q in qs],
    }


def blobs():
    vals = [0.0, -1.5, 0.25, 3.0e-5, -120.0]
    good = encode_meter_blob(vals)
    short = good[:10]
    liar = struct.pack("<i", 1000) + struct.pack("<2f", 1.0, 2.0)
    neg = struct.pack("<i", -5) + struct.pack("<f", 1.0)
    return {
        "values": vals,
        "good_hex": good.hex(),
        "decoded": decode_meter_blob(good),
        "cases": [
            {"hex": h.hex(), "decoded": decode_meter_blob(h)}
            for h in (good, short, liar, neg, b"", b"\x01\x00")
        ],
        "np_float32_check": [float(np.float32(v)) for v in vals],
    }


if __name__ == "__main__":
    cap = Capture()
    script(cap)
    sim = Sim()
    script(sim)
    wire = [
        {"addr": a, "args": [{"t": tag(v), "v": v} for v in args], "hex": dgram(a, args)}
        for a, args in cap.sent
    ]
    write("osc", {"tables": tables(), "wire": wire, "sim": sim_state(sim), "blobs": blobs()})
