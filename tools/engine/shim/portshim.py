"""Run a probe or tool unchanged against another port, with paid calls replayed (README.md):
  ENHANCE_PORT=5181 python <engine>/shim/portshim.py tools/NAME_probe.py [args]      (the gate sets every variable itself)
The patches are in shimlib.py (also loaded into child processes through sitecustomize.py when the gate sets PYTHONPATH).
Exit 3 means inconclusive:
  - the port is not the game's usual one and no URL went through the shim, so nothing proves this tree was tested; or
  - ENHANCE_REPLAY_STRICT=1 (the gate sets it for probes that need recorded replies) and a call had no recording."""
import os, runpy, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import shimlib
shimlib.apply()
if len(sys.argv) < 2: print(__doc__); sys.exit(64)
script = sys.argv[1]; sys.argv = sys.argv[1:]
code = 0
try: runpy.run_path(script, run_name="__main__")
except SystemExit as e: code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
S = shimlib.STATS
print(f"portshim: {S['rewrites']} URL(s) to port {shimlib.PORT}; replies {os.environ.get('ENHANCE_REPLAY', 'off')}: {S['replay_hits']} replayed, {S['replay_misses']} without a recording (left silent)", file=sys.stderr)
if code == 0 and shimlib.HOME and shimlib.PORT != shimlib.HOME and S["rewrites"] == 0: print("portshim: no URL went through the shim, so this run proves nothing about this tree", file=sys.stderr); code = 3
if code == 0 and os.environ.get("ENHANCE_REPLAY_STRICT") == "1" and S["replay_misses"]: print("portshim: this probe needs recorded replies and some had none, so its pass proves nothing", file=sys.stderr); code = 3
sys.exit(code)
