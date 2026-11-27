"""Recorded replies for paid calls (README.md), after trio-mix-assistant's recorded fixtures. A game whose characters speak through a model is
different every run and costs money; enhance.json shim.replay lists the routes of those calls and the folder their recordings live in.
install(page, mode) routes those calls of one page:
  replay: answer each call from the store by a hash of its request; a call with no recording is aborted (left silent) and counted in
          <out_dir>/replay_misses.log, so a gate can see what was not covered.
  record: forward the call to the real service (this SPENDS) and save the reply. Recording is the owner's decision, never a worker's:
          the store is a protected path in the game's enhance.json."""
import hashlib, json, os, pathlib
STORE = pathlib.Path(os.environ.get("ENHANCE_REPLAY_STORE") or "replay_store")
MISSES = pathlib.Path(os.environ.get("ENHANCE_OUT") or ".") / "replay_misses.log"
ROUTES = tuple(json.loads(os.environ.get("ENHANCE_REPLAY_ROUTES") or "[]"))
def key(req):
    body = req.post_data or ""
    try: body = json.dumps(json.loads(body), sort_keys=True)   # the same request in another key order is the same request
    except Exception: pass
    return hashlib.sha256(f"{req.method} {req.url.split('?')[0].rsplit('/', 1)[-1]} {body}".encode()).hexdigest()[:24]
# a recorded reply matches only the very same request, so the page must make the same requests every run: its randomness is seeded (as a scene
# check does), when ENHANCE_REPLAY_SEED is set (enhance.json shim.replay.seed); the game itself is not touched
SEED = os.environ.get("ENHANCE_REPLAY_SEED") or ""
def install(page, mode, stats=None):
    stats = stats if stats is not None else {"replay_hits": 0, "replay_misses": 0}
    if mode not in ("replay", "record", "fill"): raise ValueError(f"ENHANCE_REPLAY must be replay, record, fill or off, not {mode!r}")
    def handle(route):
        k = key(route.request); f = STORE / f"{k}.json"
        if mode == "fill" and f.exists(): stats["replay_hits"] += 1; rec = json.loads(f.read_text(encoding="utf-8")); route.fulfill(status=rec["status"], headers={"Content-Type": "application/json"}, body=rec["body"]); return   # fill: replay what is recorded, record only what is missing (a replay runs faster than the live service, so the requests that follow differ: a second fill run records those)
        if mode == "replay":
            if f.exists(): stats["replay_hits"] += 1; rec = json.loads(f.read_text(encoding="utf-8")); route.fulfill(status=rec["status"], headers={"Content-Type": "application/json"}, body=rec["body"]); return
            stats["replay_misses"] += 1
            MISSES.parent.mkdir(parents=True, exist_ok=True)
            with open(MISSES, "a", encoding="utf-8", newline="\n") as log: log.write(f"{k} {route.request.url} {(route.request.post_data or '')[:200]}\n")
            route.abort(); return
        STORE.mkdir(parents=True, exist_ok=True); resp = route.fetch(); body = resp.text()
        f.write_text(json.dumps({"url": route.request.url, "request": route.request.post_data, "status": resp.status, "body": body}, indent=1), encoding="utf-8", newline="\n")
        route.fulfill(response=resp, body=body)
    if SEED: page.add_init_script("(() => { let s = " + str(int(SEED)) + "; Math.random = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; })()")
    for p in ROUTES: page.route(p, handle)
