import json
import types

from fixture_util import write

import trio_mix.engine.calibration as engine_calibration
from trio_mix.clock import ManualClock
from trio_mix.engine import Engine
from trio_mix.showclock import ShowState
from trio_mix.venue import VenueModel


class SyncThread:
    def __init__(self, target=None, args=(), daemon=None, name=None):
        self.target = target
        self.args = args

    def start(self):
        self.target(*self.args)


engine_calibration.threading = types.SimpleNamespace(Thread=SyncThread)


def step(n):
    return {"op": "step", "n": n}


def cmd(**d):
    return {"op": "cmd", "d": d}


def snap(label):
    return {"op": "snapshot", "label": label}


def song(index, name, nxt, section="Song", bpm=None, playing=True):
    return {
        "op": "song",
        "state": {
            "songIndex": index,
            "songName": name,
            "nextSong": nxt,
            "section": section,
            "bpm": bpm,
            "playing": playing,
        },
    }


def main_scenario():
    ops = [snap("boot"), step(60), snap("first-3s")]
    ops += [
        cmd(type="toggle", job="vocal_ride", on=True),
        cmd(type="toggle", job="balance", on=True),
        cmd(type="toggle", job="unmask", on=True),
        cmd(type="toggle", job="phase", on=True),
        cmd(type="toggle", job="nonsense", on=True),
        cmd(type="lead_target", db=-8.5),
        cmd(type="fader", ch=2, db=-3.25),
        cmd(type="fader", ch=99, db=0),
        cmd(type="mute", ch=4, on=True),
        cmd(type="master", db=-2.0),
        cmd(type="eq", ch=1, band=2, hz=1850, gain=3.5, q=2.5, on=True),
        cmd(type="eq", ch=1, band=9, hz=1850),
        cmd(type="eq", ch=8, band=1, hz=100),
        cmd(type="send", ch=2, fx=1, db=-18.0),
        cmd(type="send", ch=2, fx=7, db=-18.0),
        cmd(type="fx", fx=2, db=-12.0),
        cmd(type="scene", index=3),
        cmd(type="reset_notches"),
        cmd(type="balance_capture"),
        snap("after-commands"),
        step(40),
        snap("settled"),
    ]
    ops += [
        cmd(type="fader", ch="x", db=0),
        cmd(type="fader", db=0),
        cmd(type="mute", ch=1),
        cmd(type="eq", ch=1, band=1, hz="not-a-number"),
        cmd(type="bogus"),
        {"op": "raw", "d": [1, 2, 3]},
        {"op": "raw", "d": "text"},
        step(5),
        snap("after-bad-commands"),
    ]
    ops += [step(500), snap("ring-and-clip")]
    ops += [step(300), snap("recovered")]
    ops += [
        song(0, "Gravity", "Bloom"),
        song(0, "Gravity", "Bloom", section="Chorus"),
        song(1, "Bloom", "Wildflower", bpm=120.0),
        step(30),
        snap("songs"),
        song(3, "Tide", "Gravity"),
        song(9, "Unknown Song", ""),
        step(10),
        snap("guest-and-unknown"),
    ]
    ops += [
        {"op": "reconcile", "ch": 2, "db": 2.0},
        {"op": "reconcile", "ch": 2, "db": 2.2},
        step(30),
        {"op": "reconcile", "ch": 2, "db": 5.0},
        {"op": "reconcile", "ch": 77, "db": 5.0},
        {"op": "meters", "n": 70},
        {
            "op": "venue",
            "model": {
                "venue": "Bar",
                "shows": 2,
                "feedback_freqs": [{"hz": 800, "count": 3}, {"hz": 2500, "count": 1}],
                "confidence": 0.67,
                "updated": 5.0,
            },
        },
        step(20),
        snap("reconcile-venue"),
    ]
    ops += [cmd(type="calibrate"), {"op": "await_calibration"}, step(30), snap("calibrated")]
    ops += [cmd(type="calibrate"), {"op": "await_calibration"}, snap("calibrated-twice")]
    ops += [
        cmd(type="coach", on=True),
        step(80),
        snap("coach-on"),
        cmd(type="calibrate"),
        {"op": "await_calibration"},
        song(2, "Wildflower", "Tide"),
        step(40),
        snap("coach-calibrated"),
        cmd(type="coach", on=False),
    ]
    ops += [
        cmd(type="panic", on=True),
        cmd(type="calibrate"),
        cmd(type="scene", index=4),
        step(20),
        snap("takeover"),
        cmd(type="panic", on=False),
        step(20),
        snap("released"),
    ]
    ops += [
        {
            "op": "advice",
            "d": {
                "performer_prompt": "  Ease the vocal  ",
                "room_assessment": "boomy",
                "severity": "WARN",
            },
        },
        snap("advice"),
    ]
    ops += [{"op": "advice", "d": {"performer_prompt": "", "severity": "loud"}}, {"op": "context"}]
    return ops


def run(ops):
    clock = ManualClock(start=100.0, wall=1_700_000_000.0)
    e = Engine(sim=True, tick=0.05, clock=clock)
    last = clock.monotonic()
    out = {"snapshots": [], "contexts": []}
    for op in ops:
        kind = op["op"]
        if kind == "step":
            for _ in range(op["n"]):
                clock.advance(e.tick)
                now = clock.monotonic()
                e.step(now, last)
                last = now
        elif kind == "cmd" or kind == "raw":
            e.command(op["d"])
        elif kind == "snapshot":
            out["snapshots"].append(
                {"label": op["label"], "t": json.loads(json.dumps(e.snapshot()))}
            )
        elif kind == "song":
            s = op["state"]
            e.on_song_change(
                ShowState(
                    song_index=s["songIndex"],
                    song_name=s["songName"],
                    next_song=s["nextSong"],
                    section=s["section"],
                    bpm=s["bpm"],
                    playing=s["playing"],
                )
            )
        elif kind == "reconcile":
            e.reconcile_fader(op["ch"], op["db"])
        elif kind == "meters":
            e.set_console_meters([0.0] * op["n"])
        elif kind == "venue":
            e.apply_venue_model(VenueModel(**op["model"]))
        elif kind == "await_calibration":
            pass
        elif kind == "advice":
            e.on_advice(op["d"])
        elif kind == "context":
            out["contexts"].append(json.loads(json.dumps(e.advisor_context())))
        else:
            raise ValueError(kind)
    out["events"] = json.loads(json.dumps(list(e.events)))
    out["final"] = {
        "status": e.status,
        "calib_status": e.calib_status,
        "muted": {str(k): v for k, v in e.muted.items()},
        "master_db": e.master_db,
        "wire_len": len(e.con.wire_log),
    }
    return out


if __name__ == "__main__":
    ops = main_scenario()
    result = run(ops)
    kinds = {}
    for ev in result["events"]:
        kinds[ev["kind"]] = kinds.get(ev["kind"], 0) + 1
    print(len(result["snapshots"]), "snapshots; events kept", len(result["events"]), kinds)
    write("engine", {"ops": ops, **result})
