"""Config-file launcher — partners edit show.conf and double-click start; this
reads the config, builds the right command, opens the dashboard, and runs the
server. No command-line knowledge required.

Run modes (set MODE in show.conf): hardware | emulate | sim.
Special args: `--list-devices` (print audio inputs), `--rehearse` (force emulate).
"""

from __future__ import annotations

import contextlib
import os
import sys
import threading
import time
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))


def read_conf(path: str) -> dict[str, str]:
    cfg: dict[str, str] = {}
    if not os.path.exists(path):
        return cfg
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            cfg[k.strip().upper()] = v.strip()
    return cfg


def _yes(v: object) -> bool:
    return str(v).strip().lower() in ("1", "yes", "y", "true", "on")


def build_argv(cfg: dict[str, str], rehearse: bool = False) -> tuple[list[str], str, str]:
    argv = ["run.py"]
    mode = "emulate" if rehearse else cfg.get("MODE", "sim").strip().lower()
    if _yes(cfg.get("AUTO", "no")):
        argv += ["--auto"]
    if mode == "hardware":
        argv += ["--hardware"]
        ip = cfg.get("CONSOLE_IP", "").strip()
        if ip:
            argv += ["--console-ip", ip]
        else:
            print(
                "  [!] MODE=hardware but CONSOLE_IP is blank in show.conf — "
                "the console feed won't connect until you set it."
            )
        dev = cfg.get("AUDIO_DEVICE", "").strip()
        if dev:
            argv += ["--audio-device", dev]
        else:
            print(
                "  [i] AUDIO_DEVICE blank — running manual mixing + scene recall "
                "only (the assistant won't listen). Run list-devices to pick one."
            )
        outdev = cfg.get("OUTPUT_DEVICE", "").strip()
        if outdev:
            argv += ["--output-device", outdev]
        igain = cfg.get("INPUT_GAIN", "").strip()
        if igain:
            argv += ["--input-gain", igain]
        ab = cfg.get("ABLESET_PORT", "").strip()
        if ab:
            argv += ["--ableset-port", ab]
    elif mode == "emulate":
        argv += ["--emulate"]

    tmpl = cfg.get("TEMPLATE", "").strip()
    if tmpl:
        argv += ["--template", tmpl if os.path.isabs(tmpl) else os.path.join(HERE, tmpl)]
    venue = cfg.get("VENUE", "").strip()
    if venue:
        argv += ["--venue", venue]
    lan = _yes(cfg.get("LAN", "yes"))
    if lan:
        argv += ["--lan"]
    https = _yes(cfg.get("HTTPS", "yes"))
    if https:
        argv += ["--https"]
    pin = cfg.get("PIN", "").strip()
    if pin:
        argv += ["--pin", pin]
        if lan and not https:
            print(
                "  [!] PIN is set but HTTPS=no — the PIN travels unencrypted. "
                "Set HTTPS=yes in show.conf."
            )
    port = cfg.get("PORT", "").strip() or "8770"
    argv += ["--port", port]
    if _yes(cfg.get("ADVISOR", "no")):
        argv += ["--advisor"]
    return argv, mode, port


def _open_browser_later(url: str, delay: float = 2.0) -> None:
    def go():
        time.sleep(delay)
        with contextlib.suppress(webbrowser.Error, OSError):
            webbrowser.open(url)

    threading.Thread(target=go, daemon=True).start()


def main() -> None:
    reconfigure = getattr(sys.stdout, "reconfigure", None)
    if reconfigure is not None:
        with contextlib.suppress(ValueError, OSError):
            reconfigure(encoding="utf-8")
    try:
        import run
    except Exception as e:
        print("Could not load the app:", e)
        print("Run setup first  (setup.bat on Windows, 'bash setup.command' on macOS).")
        input("Press Enter to close...")
        sys.exit(1)

    args = sys.argv[1:]
    cfg = read_conf(os.path.join(HERE, "show.conf"))

    if "--list-devices" in args:
        sys.argv = ["run.py", "--list-devices"]
        run.main()
        return

    rehearse = "--rehearse" in args
    argv, mode, port = build_argv(cfg, rehearse=rehearse)
    scheme = "https" if "--https" in argv else "http"
    print("=" * 60)
    print("  Trio Mix-Assistant —", "REHEARSE (emulator)" if rehearse else mode.upper())
    print("  Dashboard:", f"{scheme}://127.0.0.1:{port}/   (and the LAN URL/QR below)")
    print("  Press Ctrl+C in this window to stop.")
    print("=" * 60)
    _open_browser_later(f"{scheme}://127.0.0.1:{port}/")
    sys.argv = argv
    run.main()


if __name__ == "__main__":
    main()
