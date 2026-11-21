import base64
import json
import os
import tempfile

from fixture_util import write

from trio_mix import venue
from trio_mix.advisor import Advisor
from trio_mix.sessionlog import SessionLog

EVENTS = [
    (
        "Barn",
        [
            {
                "kind": "feedback",
                "level": "notice",
                "ch": 1,
                "role": "lead_vox",
                "msg": "2500 Hz on lead_vox",
            },
            {
                "kind": "feedback",
                "level": "notice",
                "ch": 1,
                "role": "lead_vox",
                "msg": "2480 Hz on lead_vox",
            },
            {"kind": "clip", "level": "warn", "ch": 6, "role": "cajon", "msg": "near clip"},
            {"kind": "feedback", "msg": "180 Hz on bass"},
            {"kind": "system", "msg": "caf\u00e9 \u2014 ready"},
            {"kind": "feedback", "msg": None},
        ],
    ),
    (
        "Barn",
        [
            {
                "kind": "feedback",
                "level": "notice",
                "ch": 2,
                "role": "gtr",
                "msg": "2510 Hz on gtr",
            },
            {"kind": "manual", "ch": None, "role": None, "msg": "fader"},
        ],
    ),
    (
        "Cellar",
        [
            {"kind": "feedback", "msg": "3150 Hz"},
            {"kind": "feedback", "msg": "no number here"},
            {"kind": "feedback", "msg": "9999999 Hz"},
        ],
    ),
    ("Empty Room", []),
]

MODELS = [
    venue.VenueModel(
        venue="The Barn", shows=3, feedback_freqs=[{"hz": 2500, "count": 5}], confidence=1.0
    ),
    venue.VenueModel(venue="Caf\u00e9 \u2014 Nord", shows=1, confidence=0.33, updated=1700000000.5),
    venue.VenueModel(),
]

CONTEXTS = [
    {"recent_events": [], "mode": "simulation"},
    {"a": 1, "b": [1, 2, {"c": "caf\u00e9 \u2014 \u201cq\u201d"}], "d": None, "e": True, "f": 0.5},
    {"big": "x" * 7000},
]

PARSE = [
    "",
    "no json",
    'Sure! {"performer_prompt":"Lower the cajon","room_assessment":"boomy","severity":"warn"} done',
    '{"severity":"bogus"}',
    '{"severity":"  WARN "}',
    '{"performer_prompt": 12, "room_assessment": null, "severity": true}',
    "[1,2]",
    "{not json}",
    '{"performer_prompt":"' + "a" * 300 + '","room_assessment":"' + "b" * 300 + '"}',
    '{"performer_prompt":"  spaced  "} trailing {"x":1}',
]


def main():
    tmp = tempfile.mkdtemp()
    path = os.path.join(tmp, "sessions.db")
    sl = SessionLog(path)
    sids = []
    for name, events in EVENTS:
        sids.append(sl.start_session(venue=name, template="Trio", mode="simulation"))
        for ev in events:
            sl.log_event(ev)
        sl.flush()
    sl.close()
    with open(path, "rb") as f:
        raw = f.read()
    sl = SessionLog(path)
    out = {
        "db": base64.b64encode(raw).decode("ascii"),
        "sids": sids,
        "summaries": {str(s): sl.summary(s) for s in sids},
        "recent": {str(s): sl.recent(50, s) for s in sids},
        "recent2": sl.recent(2, sids[0]),
        "feedback": {v: sl.venue_feedback(v) for v in ("Barn", "Cellar", "Empty Room", "Nope")},
        "shows": {v: sl.venue_shows(v) for v in ("Barn", "Cellar", "Empty Room", "Nope")},
        "history": {v: sl.venue_history(v) for v in ("Barn", "Cellar", "Nope")},
        "models": {
            v: venue.build_model(sl, v, 1700000000.5).__dict__
            for v in ("Barn", "Cellar", "Empty Room")
        },
    }
    sl.close()
    out["model_json"] = []
    for m in MODELS:
        d = tempfile.mkdtemp()
        p = venue.save_model(m, d)
        with open(p, encoding="utf-8") as f:
            out["model_json"].append(
                {"model": m.__dict__, "file": os.path.basename(p), "text": f.read()}
            )
    out["contexts"] = [json.dumps(c)[:6000] for c in CONTEXTS]
    out["parse"] = [{"in": t, "out": Advisor.parse(t)} for t in PARSE]
    write("sessionlog", out)


main()
