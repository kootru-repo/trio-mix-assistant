import base64
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", ".."))
OUT = os.path.join(HERE, "..", "fixtures")


def f32(arr):
    a = np.asarray(arr, dtype="<f4")
    return base64.b64encode(a.tobytes()).decode("ascii")


def f64(arr):
    a = np.asarray(arr, dtype="<f8")
    return base64.b64encode(a.tobytes()).decode("ascii")


def num(x):
    if x is None:
        return None
    return float(x)


def write(name, data):
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, name + ".json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, separators=(",", ":"))
    print("wrote", name)
