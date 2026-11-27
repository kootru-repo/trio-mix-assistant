"""The patches the gate puts into every Python process it starts (README.md), loaded through sitecustomize.py when ENHANCE_SHIM=1:
- every page.goto and urlopen to HOST:HOME_PORT (the game's usual dev server) goes to ENHANCE_PORT instead, so a tool that hard-codes the
  usual port tests the worker's own server;
- with ENHANCE_REPLAY=replay (the gate's default when the game lists paid routes in enhance.json shim.replay) every new page answers those
  calls from recordings and never reaches the paid service; record forwards and records (it spends: the owner's call); off leaves them alone.
Counts are kept in STATS for portshim.py to report. Every setting comes from the environment the gate builds (engine/lib.mjs pyEnv)."""
import os, sys, json, pathlib, urllib.request
def _defaults():
    """run by hand (a worker picturing its own server), not by the gate: read the game's enhance.json for what the gate would have set, so
    paid calls are still replayed by default. Set into os.environ, so child processes inherit the same settings."""
    if os.environ.get("ENHANCE_HOME_PORT") is not None: return
    d = pathlib.Path(os.environ.get("ENHANCE_ROOT") or os.getcwd()).resolve()
    while not (d / "enhance.json").exists() and d.parent != d: d = d.parent
    if not (d / "enhance.json").exists(): return
    cfg = json.loads((d / "enhance.json").read_text(encoding="utf-8")); shim = cfg.get("shim") or {}; rep = shim.get("replay")
    os.environ.setdefault("ENHANCE_HOME_PORT", str(cfg.get("port") or ""))
    os.environ.setdefault("ENHANCE_HOST", shim.get("rewrite_host", "localhost"))
    for name in shim.get("port_env", []):
        if os.environ.get(name) and not os.environ.get("ENHANCE_PORT"): os.environ["ENHANCE_PORT"] = os.environ[name]
    os.environ.setdefault("ENHANCE_OUT", str(d / cfg.get("out_dir", ".enhance/out")))
    if rep:
        os.environ.setdefault("ENHANCE_REPLAY", "replay"); os.environ.setdefault("ENHANCE_REPLAY_ROUTES", json.dumps(rep.get("routes", [])))
        os.environ.setdefault("ENHANCE_REPLAY_STORE", str(d / rep["store"]))
        if rep.get("seed") is not None: os.environ.setdefault("ENHANCE_REPLAY_SEED", str(rep["seed"]))
_defaults()
STATS = {"rewrites": 0, "replay_hits": 0, "replay_misses": 0}
HOST = os.environ.get("ENHANCE_HOST", "localhost")
HOME = os.environ.get("ENHANCE_HOME_PORT", "")
PORT = os.environ.get("ENHANCE_PORT", HOME)
FROM, TO = f"{HOST}:{HOME}", f"{HOST}:{PORT}"
def fix(url):
    if not HOME or not isinstance(url, str): return url
    # a URL already on this tree's port (the tool read it from shim.port_env, as the gate sets) proves this tree was tested just as a rewritten one does
    if PORT != HOME and TO in url: STATS["rewrites"] += 1; return url
    if FROM not in url: return url
    STATS["rewrites"] += 1
    return url.replace(FROM, TO) if PORT != HOME else url
def apply():
    if getattr(apply, "done", False): return
    apply.done = True
    try: from playwright.sync_api import Page, Frame, BrowserContext, Browser
    except Exception: Page = None
    if Page is not None:
        for cls in (Page, Frame):
            orig = cls.goto
            def goto(self, url, *a, __o=orig, **k): return __o(self, fix(url), *a, **k)
            cls.goto = goto
        mode = os.environ.get("ENHANCE_REPLAY", "off")
        if mode != "off":
            sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent)); import replay
            for cls in (Browser, BrowserContext):
                orig_new = cls.new_page
                def new_page(self, *a, __o=orig_new, **k):
                    pg = __o(self, *a, **k); replay.install(pg, mode, STATS); return pg
                cls.new_page = new_page
    orig_urlopen = urllib.request.urlopen
    def urlopen(url, *a, **k):
        if isinstance(url, str): url = fix(url)
        elif hasattr(url, "full_url") and FROM in url.full_url: url.full_url = fix(url.full_url)
        return orig_urlopen(url, *a, **k)
    urllib.request.urlopen = urlopen
