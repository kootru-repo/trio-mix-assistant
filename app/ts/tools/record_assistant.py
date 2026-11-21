import numpy as np
from fixture_util import write

from trio_mix import config as C
from trio_mix.assistant import MixAssistant
from trio_mix.clock import ManualClock
from trio_mix.dsp import ChannelFeatures, PhaseRelation
from trio_mix.osc import SimConsole


def feat(ch, now, rms, peak=-20.0, fb=None, contrast=None, harm=0.0):
    if contrast is None:
        contrast = 24.0 if fb else 6.0
    return {
        "op": "feat",
        "ch": ch,
        "now": now,
        "rms": rms,
        "peak": peak,
        "fb": fb,
        "contrast": contrast,
        "harm": harm,
    }


def phase(a, b, now, zero, best, lag_ms):
    return {"op": "phase", "a": a, "b": b, "now": now, "zero": zero, "best": best, "lag_ms": lag_ms}


def scenario_reflex():
    rng = np.random.default_rng(1)
    ops = []
    t = 1.0
    for i in range(14):
        jitter = float(rng.uniform(-0.004, 0.004))
        ops.append(feat(1, t, -30.0 + 0.5 * i, fb=2500.0 * (1 + jitter)))
        t += 0.1
    for i in range(14):
        ops.append(feat(1, t, -28.0 + 0.4 * i, fb=1000.0 + 2.0 * (i % 2), harm=0.5))
        t += 0.1
    for i in range(30):
        ops.append(feat(1, t, -26.0 + 0.6 * i, fb=800.0 * (1 + 0.001 * (i % 3)), harm=0.9))
        t += 0.1
    ops.append(feat(2, t, -20.0, peak=-0.5))
    ops.append(feat(2, t + 0.1, -20.0, peak=-0.2))
    ops.append(feat(2, t + 20.0, -30.0, peak=-30.0))
    ops.append(feat(2, t + 40.0, -30.0, peak=-30.0))
    ops.append(feat(2, t + 41.0, -30.0, peak=-30.0))
    ops.append(
        {"op": "calib", "corrections": [[250.0, -4.0]], "watch": [[400.0, 5.0], [2500.0, 4.5]]}
    )
    ops.append({"op": "cal_bus_bands", "bands": [1, 2, 3]})
    t += 60.0
    for _i in range(45):
        ops.append(feat(8, t, -20.0, peak=-10.0, contrast=6.0))
        t += 0.1
    for i in range(40):
        ops.append(feat(8, t, -20.0 + 0.5 * i, fb=400.0 * (1 + 0.002 * (i % 2)), contrast=24.0))
        t += 0.1
    for i in range(40):
        ops.append(feat(8, t, -5.0 + 0.5 * i, fb=3100.0, contrast=24.0))
        t += 0.1
    ops.append({"op": "reset_notches"})
    ops.append(feat(1, t, -60.0))
    return {"name": "reflex", "config": None, "ops": ops}


def scenario_levels():
    rng = np.random.default_rng(2)
    ops = [
        {"op": "enable", "job": "vocal_ride", "on": True},
        {"op": "enable", "job": "balance", "on": True},
    ]
    t = 10.0
    for _i in range(50):
        ops.append(feat(1, t, -14.0 + float(rng.normal(0, 1.5)), peak=-8.0))
        ops.append(feat(5, t, -22.0 + float(rng.normal(0, 1.0)), peak=-12.0))
        t += 0.12
    ops.append({"op": "capture_balance", "levels": {"7": -25.0}})
    for _i in range(40):
        ops.append(feat(5, t, -16.0, peak=-9.0))
        ops.append(feat(7, t, -19.0, peak=-9.0))
        ops.append(feat(1, t, -3.0, peak=-2.0))
        t += 0.2
    ops.append({"op": "manual", "ch": 1, "now": t})
    for _i in range(10):
        ops.append(feat(1, t, 2.0, peak=-2.0))
        t += 0.5
    ops.append({"op": "lead_target", "v": -9.0})
    for _i in range(30):
        ops.append(feat(1, t, -30.0, peak=-20.0))
        t += 0.3
    return {"name": "levels", "config": None, "ops": ops}


def scenario_coach():
    base = scenario_reflex()["ops"][:60] + scenario_levels()["ops"][:70]
    ops = [{"op": "coach", "on": True}, {"op": "enable", "job": "vocal_ride", "on": True}]
    ops += [
        {"op": "enable", "job": "balance", "on": True},
        {"op": "enable", "job": "phase", "on": True},
    ]
    ops += [{"op": "enable", "job": "unmask", "on": True}]
    ops += base
    ops.append(
        {
            "op": "calib_plan",
            "corrections": [[250.0, -4.0], [2500.0, -3.5]],
            "watch": [[400.0, 5.0], [800.0, 4.5], [250.0, 7.0]],
        }
    )
    ops.append({"op": "coach_snapshot", "now": 200.0})
    ops.append({"op": "coach_snapshot", "now": 400.0})
    ops.append({"op": "calib_plan", "corrections": [], "watch": []})
    ops.append({"op": "coach_snapshot", "now": 401.0})
    ops.append({"op": "coach", "on": False})
    ops.append({"op": "coach_snapshot", "now": 402.0})
    return {"name": "coach", "config": None, "ops": ops}


def scenario_phase():
    rng = np.random.default_rng(3)
    ops = [{"op": "enable", "job": "phase", "on": True}]
    t = 1.0
    for _i in range(30):
        ops.append(phase(2, 3, t, -0.9 + float(rng.normal(0, 0.02)), -0.9, 0.0))
        t += 0.1
    for _i in range(30):
        ops.append(phase(2, 3, t, -0.8, -0.8, 0.0))
        t += 0.5
    for _i in range(30):
        ops.append(phase(2, 3, t, 0.9, 0.9, 0.0))
        t += 0.1
    for _i in range(30):
        ops.append(phase(2, 3, t, 0.8, 0.9, 0.6))
        t += 1.0
    for _i in range(40):
        ops.append(phase(2, 3, t, 0.0, 0.1, 0.0))
        t += 0.1
    for _i in range(30):
        ops.append(phase(4, 5, t, -0.95, -0.95, 0.0))
        t += 0.1
    ops.append({"op": "coach", "on": True})
    for _i in range(10):
        ops.append(phase(4, 5, t, -0.95, -0.95, 0.0))
        ops.append(phase(2, 3, t, 0.8, 0.9, 0.7))
        t += 0.1
    return {"name": "phase", "config": None, "ops": ops}


def scenario_unmask():
    rng = np.random.default_rng(4)
    ops = [{"op": "enable", "job": "unmask", "on": True}]
    t = 1.0
    for _i in range(40):
        ops.append(feat(1, t, -20.0 + float(rng.normal(0, 1)), peak=-10.0))
        for ch in (4, 5, 6, 7):
            ops.append(feat(ch, t, -30.0, peak=-20.0))
        t += 0.1
    for _i in range(60):
        ops.append(feat(1, t, -60.0, peak=-50.0))
        for ch in (4, 5):
            ops.append(feat(ch, t, -30.0, peak=-20.0))
        t += 0.1
    for _i in range(20):
        ops.append(feat(1, t, -15.0, peak=-8.0))
        t += 0.1
    ops.append({"op": "release_unmask"})
    ops.append({"op": "coach", "on": True})
    ops.append(feat(1, t, -15.0, peak=-8.0))
    ops.append({"op": "coach", "on": False})
    ops.append({"op": "enable", "job": "feedback", "on": True})
    for i in range(30):
        ops.append(feat(4, t, -30.0 + 0.5 * i, fb=1500.0))
        t += 0.1
    return {"name": "unmask", "config": None, "ops": ops}


def scenario_stage():
    rng = np.random.default_rng(5)
    spec = {
        "map": {"1": "lead_vox", "2": "acoustic_gtr", "3": "stage_mic", "4": "meas_mic"},
        "lead": 1,
        "meas_mic": 4,
        "balance": [2],
        "guest": [],
        "stereo_links": [],
        "stage_mic": 3,
        "phase_pairs": [[1, 2]],
    }
    ops = [{"op": "enable", "job": "vocal_ride", "on": True}]
    t = 1.0
    for _i in range(80):
        ops.append(feat(3, t, -40.0 + float(rng.normal(0, 0.5)), peak=-30.0))
        t += 0.5
    for _i in range(20):
        ops.append(feat(3, t, -25.0, peak=-15.0))
        t += 5.0
    for _i in range(30):
        ops.append(feat(1, t, -12.0, peak=-5.0))
        ops.append(feat(2, t, -18.0, peak=-9.0))
        ops.append(feat(4, t, -50.0, peak=-40.0))
        t += 0.3
    ops.append(feat(9, t, -30.0))
    return {"name": "stage", "config": spec, "ops": ops}


class Replayer:
    def __init__(self, scenario):
        self.saved = C.channel_map_state()
        if scenario["config"]:
            C.apply_channel_map(scenario["config"])
        self.clock = ManualClock(start=0.0, wall=1_700_000_000.0)
        self.con = SimConsole()
        self.events = []
        self.a = MixAssistant(self.con, on_event=self.events.append, clock=self.clock)
        self.snapshots = []
        self.errors = []

    def close(self):
        C.restore_channel_map_state(self.saved)

    def sync(self, now):
        if now is not None and now > self.clock.monotonic():
            self.clock.advance(now - self.clock.monotonic())

    def run(self, op):
        kind = op["op"]
        self.sync(op.get("now"))
        a = self.a
        if kind == "feat":
            f = ChannelFeatures(
                rms_dbfs=op["rms"],
                peak_dbfs=op["peak"],
                fb_freq=op["fb"],
                contrast_db=op["contrast"],
                harmonicity=op["harm"],
            )
            a.on_features(op["ch"], f, op["now"])
        elif kind == "phase":
            rel = PhaseRelation(
                zero_corr=op["zero"], best_corr=op["best"], lag_samples=0, lag_ms=op["lag_ms"]
            )
            a.handle_phase(op["a"], op["b"], rel, op["now"])
        elif kind == "coach":
            a.set_coach_mode(op["on"])
        elif kind == "enable":
            a.enabled[op["job"]] = op["on"]
        elif kind == "capture_balance":
            a.capture_balance({int(k): v for k, v in op["levels"].items()})
        elif kind == "manual":
            a.note_manual(op["ch"], op["now"])
        elif kind == "lead_target":
            a.lead_target = op["v"]
        elif kind == "calib":
            from trio_mix.calibration import CalibrationResult

            a.set_calibration(
                CalibrationResult(
                    baseline={},
                    corrections=[tuple(x) for x in op["corrections"]],
                    watchlist=[tuple(x) for x in op["watch"]],
                )
            )
        elif kind == "calib_plan":
            from trio_mix.calibration import CalibrationResult, Calibrator

            res = CalibrationResult(
                baseline={},
                corrections=[tuple(x) for x in op["corrections"]],
                watchlist=[tuple(x) for x in op["watch"]],
            )
            a.coach_calibration(Calibrator(self.con).plan(res))
        elif kind == "cal_bus_bands":
            a.cal_bus_bands = set(op["bands"])
        elif kind == "reset_notches":
            a.reset_notches()
        elif kind == "release_unmask":
            a.release_unmask()
        elif kind == "coach_snapshot":
            self.snapshots.append(a.coach_snapshot(op["now"]))
        else:
            raise ValueError(kind)

    def state(self):
        a = self.a
        c = self.con
        return {
            "snapshot": a.snapshot(),
            "enabled": a.enabled,
            "fader_db": {str(k): v for k, v in a.fader_db.items()},
            "gain_db": {str(k): v for k, v in a.gain_db.items()},
            "used_notch_band": {str(k): v for k, v in a.used_notch_band.items()},
            "fb_bus_bands": a.fb_bus_bands,
            "used_bus_notch_band": a.used_bus_notch_band,
            "in_ema": {str(k): v for k, v in a.in_ema.items()},
            "balance_targets": {str(k): v for k, v in a.balance_targets.items()},
            "polarity": {str(k): v for k, v in a.polarity.items()},
            "phase_status": {f"{k[0]},{k[1]}": v for k, v in a.phase_status.items()},
            "duck_gain": a.duck_gain,
            "duck_applied": {str(k): v for k, v in a.duck_applied.items()},
            "vox_level_ema": a.vox_level_ema,
            "room": [a.room_level_db, a.room_contrast_db, a.room_confidence],
            "stage_baseline": a.stage_baseline,
            "lead_target": a.lead_target,
            "log_len": len(a.log),
            "coach_recs": sorted(
                [[k[0], k[1]] for k in a.coach_recs], key=lambda x: (x[0], x[1] or -1)
            ),
            "wire": [[addr, *list(args)] for addr, *args in c.wire_log],
            "console": {
                "fader_db": {str(k): v for k, v in c.fader_db.items()},
                "gain_db": {str(k): v for k, v in c.gain_db.items()},
                "notches": {str(k): v for k, v in c.notches.items()},
                "bus_eq": {str(k): v for k, v in c.bus_eq.items()},
                "eq_bands": {
                    str(k): {str(b): d for b, d in v.items()} for k, v in c.eq_bands.items()
                },
                "polarity": {str(k): v for k, v in c.polarity.items()},
            },
        }


def run(scenario):
    r = Replayer(scenario)
    try:
        for op in scenario["ops"]:
            try:
                r.run(op)
            except KeyError as exc:
                r.errors.append(f"KeyError:{exc.args[0]}")
        return {
            "name": scenario["name"],
            "config": scenario["config"],
            "ops": scenario["ops"],
            "events": r.events,
            "snapshots": r.snapshots,
            "errors": r.errors,
            "state": r.state(),
        }
    finally:
        r.close()


if __name__ == "__main__":
    scenarios = [
        scenario_reflex(),
        scenario_levels(),
        scenario_coach(),
        scenario_phase(),
        scenario_unmask(),
        scenario_stage(),
    ]
    out = [run(s) for s in scenarios]
    for s in out:
        kinds = {}
        for e in s["events"]:
            kinds[e["kind"]] = kinds.get(e["kind"], 0) + 1
        print(s["name"], len(s["events"]), kinds, "errors", s["errors"])
    write("assistant", out)
