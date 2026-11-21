import glob
import os
import struct

import numpy as np

NEEDLE = struct.pack("<Q", 0x000EF33D8025EF6A)


def tables():
    root = os.path.join(os.path.dirname(np.__file__), "random")
    path = glob.glob(os.path.join(root, "_generator*.pyd")) + glob.glob(
        os.path.join(root, "_generator*.so")
    )
    with open(path[0], "rb") as fh:
        data = fh.read()
    at = data.find(NEEDLE)
    ki = struct.unpack("<256Q", data[at : at + 2048])
    wi = struct.unpack("<256d", data[at + 2048 : at + 4096])
    fi = struct.unpack("<256d", data[at + 4096 : at + 6144])
    assert fi[0] == 1.0 and ki[1] == 0
    return ki, wi, fi


def emit(name, values):
    body = ",\n  ".join(
        ", ".join(repr(float(v)) for v in values[i : i + 4]) for i in range(0, 256, 4)
    )
    return f"export const {name}: readonly number[] = [\n  {body},\n];\n"


if __name__ == "__main__":
    ki, wi, fi = tables()
    out = emit("ZIG_KI", ki) + "\n" + emit("ZIG_WI", wi) + "\n" + emit("ZIG_FI", fi)
    path = os.path.join(os.path.dirname(__file__), "..", "src", "core", "ziggurat.ts")
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(out)
    print("wrote", os.path.normpath(path))
