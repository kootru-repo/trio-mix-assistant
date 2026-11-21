"""Entry point — launch the mix-assistant dashboard.

    python run.py                 # simulation mode (no hardware needed)
    python run.py --port 8770
    python run.py --hardware --console-ip 192.168.1.50   # real M32C

In simulation mode a closed-loop stage drives the assistant so you can watch
feedback get caught, clips trimmed, and the vocal ride compensate — live.
"""

from __future__ import annotations

import argparse
import contextlib
import logging
import os
import socket
import ssl
import sys
from typing import TYPE_CHECKING, Any, NoReturn

from trio_mix import config as C
from trio_mix import template as tmpl
from trio_mix.engine import Engine
from trio_mix.server import serve

if TYPE_CHECKING:
    from http.server import ThreadingHTTPServer

    from trio_mix.capture import SoundDeviceCapture

HERE = os.path.dirname(os.path.abspath(__file__))
WILDCARD_HOSTS = ("0.0.0.0", "::")
AUTO_CANDIDATES = 6


def _utf8_stdout() -> None:
    """Windows consoles default to cp1252, which cannot print the status glyphs."""
    reconfigure = getattr(sys.stdout, "reconfigure", None)
    if reconfigure is not None:
        with contextlib.suppress(ValueError, OSError):
            reconfigure(encoding="utf-8")


def _fail(*lines: str) -> NoReturn:
    for line in lines:
        print(line)
    sys.exit(2)


def _dev(v: str | None) -> int | str | None:
    """Parse an --audio-device/--output-device value: int index or device name."""
    if v is None:
        return None
    return int(v) if str(v).isdigit() else v


def _lan_ip() -> str | None:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return str(s.getsockname()[0])
    except OSError:
        return None
    finally:
        s.close()


def _all_lan_ips() -> list[str]:
    """Every non-loopback IPv4 the machine has — so an operator on a venue with a
    VPN / second NIC can pick the address that's actually on the tablet's network
    (the server binds all interfaces, only the *printed* URL needs the right one)."""
    ips: list[str] = []
    primary = _lan_ip()
    if primary:
        ips.append(primary)
    with contextlib.suppress(Exception):
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = str(info[4][0])
            if not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    return ips


def _print_qr(url: str) -> None:
    """Print a scannable terminal QR of the URL (optional; needs `qrcode`)."""
    try:
        import qrcode
    except ImportError:
        return
    qr = qrcode.QRCode(border=2)
    qr.add_data(url)
    qr.make(fit=True)
    print("  Scan with the tablet camera:")
    qr.print_ascii(out=sys.stdout, invert=True)


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="Acoustic Trio Mix-Assistant")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument(
        "--lan",
        action="store_true",
        help="bind to the LAN so tablets can connect (shorthand for --host 0.0.0.0)",
    )
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument(
        "--hardware", action="store_true", help="drive a real M32C over OSC (default: simulation)"
    )
    ap.add_argument(
        "--emulate",
        action="store_true",
        help="run the FULL hardware stack against an in-process desk "
        "emulator + timed audio over real sockets (no gear needed)",
    )
    ap.add_argument("--console-ip", default=None)
    ap.add_argument(
        "--audio-device",
        default=None,
        help="input audio device (index or name) for the listening half; "
        "omit to run hardware mode with manual control only",
    )
    ap.add_argument(
        "--output-device",
        default=None,
        help="output device (index or name) the calibration pink noise "
        "plays to — point this at the PA (default: OS default output)",
    )
    ap.add_argument(
        "--input-gain",
        type=float,
        default=0.0,
        help="digital input boost in dB for a quiet mic/interface "
        "(e.g. a dynamic Samson Q9U); try 20-40",
    )
    ap.add_argument(
        "--channel-map",
        default=None,
        help="explicit console-channel:device-column map for the input "
        "device, e.g. '1:0,2:1,8:9' (console 1-based, column 0-based). "
        "Default: console N -> device column N-1. Use when the console's "
        "USB routing doesn't send channel N to USB column N-1.",
    )
    ap.add_argument(
        "--auto",
        action="store_true",
        help="auto-detect the best input device, size the channel map "
        "to it, and auto-set input gain (no --audio-device needed)",
    )
    ap.add_argument(
        "--trace-osc",
        action="store_true",
        help="(--emulate) print every OSC address an editor (Mixing "
        "Station, X32-Edit) asks the emulated desk for — for "
        "protocol fidelity work",
    )
    ap.add_argument("--list-devices", action="store_true", help="list input audio devices and exit")
    ap.add_argument(
        "--https",
        action="store_true",
        help="serve over TLS (self-signed) so iPad/Android get Wake Lock + a real PWA install",
    )
    ap.add_argument(
        "--pin",
        default=None,
        help="require this access PIN to open the dashboard and control "
        "the console (recommended on untrusted networks; pair with "
        "--https). Omit for no auth on a trusted FOH LAN.",
    )
    ap.add_argument(
        "--trust",
        action="store_true",
        help="serve a cert signed by a local root CA (implies --https). "
        "Install the printed root once per device (browse to /ca.pem) "
        "for a fully-trusted, warning-FREE https connection.",
    )
    ap.add_argument(
        "--template",
        default=None,
        help="show-template JSON (songs -> scene + reference levels); "
        "omit to use the built-in trio setlist",
    )
    ap.add_argument(
        "--ableset-port",
        type=int,
        default=None,
        help="listen for AbleSet song/section OSC on this UDP port "
        "(hardware mode); enables automatic scene recall",
    )
    ap.add_argument(
        "--no-show-clock",
        action="store_true",
        help="disable the simulated show clock (no auto song changes)",
    )
    ap.add_argument(
        "--venue", default="", help="venue name — tags the session log for venue learning"
    )
    ap.add_argument(
        "--session-db",
        default=None,
        help="SQLite path for session logging (default: ./sessions.db; use 'off' to disable)",
    )
    ap.add_argument(
        "--advisor",
        action="store_true",
        help="enable the Claude advisory layer (needs ANTHROPIC_API_KEY; "
        "advisory notes only — never controls the mix)",
    )
    ap.add_argument(
        "--advisor-interval",
        type=float,
        default=30.0,
        help="seconds between advisor checks (default 30)",
    )
    return ap


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    args = build_parser().parse_args(argv)
    if args.lan:
        args.host = "0.0.0.0"
    if args.trust:
        args.https = True
    return args


def _mode_name(args: argparse.Namespace) -> str:
    return "emulated" if args.emulate else "hardware" if args.hardware else "simulation"


def load_show_template(args: argparse.Namespace) -> tmpl.ShowTemplate:
    try:
        show_template = tmpl.load(args.template) if args.template else tmpl.default_template()
    except (OSError, tmpl.TemplateError, ValueError) as exc:
        _fail(f"  [!] show template error: {exc}")
    if show_template.channels:
        C.apply_channel_map(show_template.channels)
        print(f"  Channel map: {len(C.CHANNELS)} channels from template '{show_template.name}'")
    return show_template


def load_channel_map(args: argparse.Namespace) -> dict[int, int] | None:
    if not args.channel_map:
        return None
    from trio_mix.capture import parse_channel_map

    try:
        chan_map = parse_channel_map(args.channel_map)
    except ValueError as exc:
        _fail(f"  [!] --channel-map: {exc}")
    missing = [ch for ch in C.CHANNELS if ch not in chan_map]
    if missing:
        print(
            f"  [!] --channel-map is missing console channel(s) {missing}; "
            "they won't be captured. Add them or omit --channel-map."
        )
    if args.auto:
        print("  [i] --channel-map is ignored with --auto (auto sizes its own map).")
    return chan_map


def _quiet_stop(source: SoundDeviceCapture) -> None:
    try:
        source.stop()
    except Exception:
        logging.getLogger(__name__).debug("candidate input did not stop cleanly", exc_info=True)


def autodetect_source() -> SoundDeviceCapture | None:
    """Open candidate inputs in order and keep the first that delivers audio."""
    from trio_mix.capture import SoundDeviceCapture, autodetect_inputs

    cands = autodetect_inputs()
    if not cands:
        print("  [!] --auto: no input devices found (install sounddevice?) — manual only.")
        return None
    for cand in cands[:AUTO_CANDIDATES]:
        label = f"[{cand['index']}] {cand['name']} ({cand['hostapi']}"
        C.auto_channel_map(cand["channels"])
        source = SoundDeviceCapture(device=cand["index"])
        try:
            source.start()
            source.auto_gain()
        except Exception as exc:
            print(f"  [i] --auto: {label}) won't open ({type(exc).__name__}); trying next.")
            _quiet_stop(source)
            continue
        if source._auto_db is not None:
            print(
                f"  Auto input: {label}, {cand['channels']} ch) — mic "
                f"{source._auto_db:.0f} dBFS, +{source.gain_db:.0f} dB"
            )
            return source
        print(f"  [i] --auto: {label}) opened but delivered no audio (mic busy?); trying next.")
        _quiet_stop(source)
    print("  [!] --auto: no input delivered audio. Close other apps using the mic")
    print("      (mixer editors, voice tools) and check Windows mic privacy, then restart.")
    return None


def _device_source(args: argparse.Namespace, chan_map: dict[int, int] | None) -> SoundDeviceCapture:
    from trio_mix.capture import SoundDeviceCapture

    return SoundDeviceCapture(
        device=_dev(args.audio_device),
        output_device=_dev(args.output_device),
        channel_map=chan_map,
        gain_db=args.input_gain,
    )


def build_emulated(
    args: argparse.Namespace,
    show_template: tmpl.ShowTemplate,
    chan_map: dict[int, int] | None,
    auto_source: SoundDeviceCapture | None,
) -> tuple[Engine, Any]:
    from trio_mix.capture import SoundDeviceCapture
    from trio_mix.metersrv import MeterReceiver
    from trio_mix.showclock import SimShowClock

    try:
        from trio_mix.emulator import EmulatedDesk, TimedAudioStream
        from trio_mix.osc import OscConsole

        emu = EmulatedDesk(external_moves=True)
        emu.trace_requests = args.trace_osc
        emu.scene_names = {s.scene: s.name for s in show_template.songs if s.scene is not None}
        con = OscConsole("127.0.0.1")
    except RuntimeError as exc:
        _fail(f"  [!] --emulate needs python-osc: {exc}")
    if auto_source is not None:
        source = auto_source
    elif args.audio_device is not None:
        source = _device_source(args, chan_map)
        print(
            "  Listening on a REAL audio device against the emulated desk."
            + (f"  (+{args.input_gain:.0f} dB input)" if args.input_gain else "")
        )
    else:
        source = SoundDeviceCapture()
        channels = source.ndev
        source._stream_factory = lambda cb: TimedAudioStream(cb, channels=channels)
    engine = Engine(
        console=con, sim=False, source=source, tick=C.BLOCK / C.SAMPLE_RATE, template=show_template
    )
    engine.meter_rx = MeterReceiver(
        on_fader=engine.reconcile_fader, on_meters=engine.set_console_meters
    )
    if not args.no_show_clock:
        engine.show_clock = SimShowClock(show_template, on_change=engine.on_song_change)
    return engine, emu


def build_hardware(
    args: argparse.Namespace,
    show_template: tmpl.ShowTemplate,
    chan_map: dict[int, int] | None,
    auto_source: SoundDeviceCapture | None,
) -> Engine:
    from trio_mix.metersrv import MeterReceiver

    try:
        from trio_mix.osc import OscConsole

        con = OscConsole(args.console_ip or C.CONSOLE_IP)
    except RuntimeError as exc:
        _fail(
            f"  [!] {exc}", "      Run setup (setup.bat / setup.command) to install dependencies."
        )
    source = auto_source
    if source is None and args.audio_device is not None:
        source = _device_source(args, chan_map)
    engine = Engine(
        console=con, sim=False, source=source, tick=C.BLOCK / C.SAMPLE_RATE, template=show_template
    )
    engine.meter_rx = MeterReceiver(
        on_fader=engine.reconcile_fader, on_meters=engine.set_console_meters
    )
    if args.ableset_port is not None:
        from trio_mix.showclock import AbleSetReceiver

        engine.show_clock = AbleSetReceiver(on_change=engine.on_song_change, port=args.ableset_port)
    return engine


def build_simulation(args: argparse.Namespace, show_template: tmpl.ShowTemplate) -> Engine:
    engine = Engine(sim=True, template=show_template)
    if not args.no_show_clock:
        from trio_mix.showclock import SimShowClock

        engine.show_clock = SimShowClock(show_template, on_change=engine.on_song_change)
    return engine


def attach_session_log(engine: Engine, args: argparse.Namespace, template_name: str) -> None:
    db = args.session_db if args.session_db is not None else os.path.join(HERE, "sessions.db")
    if str(db).lower() == "off":
        return
    from trio_mix.sessionlog import SessionLog

    slog = SessionLog(db)
    slog.start_session(venue=args.venue, template=template_name, mode=_mode_name(args))
    engine.session_log = slog
    print(f"  Session log: {db}" + (f"  (venue: {args.venue})" if args.venue else ""))


def attach_venue(engine: Engine, args: argparse.Namespace) -> None:
    if not args.venue:
        return
    from trio_mix import venue as venuemod

    venue_dir = os.path.join(HERE, "venues")
    engine.venue = args.venue
    engine.venue_dir = venue_dir
    model = venuemod.load_model(args.venue, venue_dir)
    if model is None:
        print(f"  Venue '{args.venue}': no model yet — will learn after this show.")
        return
    engine.apply_venue_model(model)
    print(
        f"  Venue model: {model.shows} show(s), {len(model.feedback_freqs)} "
        f"freq(s), confidence {model.confidence:.0%}"
    )


def attach_advisor(engine: Engine, args: argparse.Namespace) -> None:
    if not args.advisor:
        return
    from trio_mix.advisor import Advisor

    adv = Advisor(
        get_context=engine.advisor_context,
        on_advice=engine.on_advice,
        interval=args.advisor_interval,
    )
    if adv.available:
        engine.advisor = adv
        print("  Claude advisor: ON (advisory notes only)")
    else:
        print("  [!] --advisor requested but ANTHROPIC_API_KEY is not set; advisor disabled.")


def start_emulator(emu: Any, ip: str | None, trace: bool) -> None:
    try:
        emu.start()
    except OSError as exc:
        _fail(
            f"  [!] Desk emulator could not bind OSC port {emu.listen_port}: {exc}",
            "      Another --emulate session is probably running. Stop it and retry.",
        )
    print("  Mixer app: connect Mixing Station (console type Behringer X32, access")
    print(f'             Full) to  {ip}:{emu.listen_port}  — appears as "{C.X32_NAME}" in search.')
    print(
        f"             X32-Edit/M32-Edit also work; identity = {C.X32_MODEL}/{C.X32_FW}"
        + ("  [--trace-osc ON]" if trace else "")
    )


def prepare_tls(args: argparse.Namespace) -> tuple[tuple[str, str] | None, str | None]:
    """Return ((certfile, keyfile), ca_pem); (None, None) when TLS is off or unavailable."""
    if not args.https:
        return None, None
    try:
        from trio_mix import tls

        hosts = list(dict.fromkeys(["localhost", "127.0.0.1", *_all_lan_ips()]))
        certdir = os.path.join(HERE, ".certs")
        ca_pem = None
        if args.trust:
            certfile, keyfile, cafile = tls.ensure_trusted_cert(certdir, hosts)
            with open(cafile, encoding="utf-8") as f:
                ca_pem = f.read()
        else:
            certfile, keyfile = tls.ensure_cert(certdir, hosts)
        return (certfile, keyfile), ca_pem
    except Exception as exc:
        print(f"  [!] --https unavailable ({type(exc).__name__}: {exc}); serving over http.")
        print("      For TLS: pip install cryptography  (or put openssl on PATH).")
        return None, None


def wrap_tls(httpd: ThreadingHTTPServer, tls_files: tuple[str, str] | None) -> str:
    """Wrap the listening socket in TLS; return the scheme actually served."""
    if not tls_files:
        return "http"
    try:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(*tls_files)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    except (OSError, ssl.SSLError, ValueError) as exc:
        print(f"  [!] --https unavailable ({type(exc).__name__}: {exc}); serving over http.")
        return "http"
    return "https"


def _print_trust_steps(args: argparse.Namespace, scheme: str, ip: str | None) -> None:
    capath = os.path.join(HERE, ".certs", "ca.pem")
    host_url = ip or (args.host if args.host not in WILDCARD_HOSTS else "127.0.0.1")
    print("  Trusted TLS — do this ONCE per device for ZERO warnings:")
    print("    1) Get the root CA onto the device — copy / AirDrop / email this file:")
    print(f"         {capath}")
    if ip:
        print(
            "       (or, if a device lets you tap through the warning once: "
            f"{scheme}://{ip}:{args.port}/ca.pem )"
        )
    print("    2) Install + TRUST it:")
    print(
        "         iOS:     install the profile, then Settings > General > About > "
        "Certificate Trust Settings > enable it"
    )
    print("         Android: Settings > Security > Install a certificate > CA certificate")
    print("         macOS:   double-click > Keychain 'System' > set this cert to 'Always Trust'")
    print(
        "         Windows: double-click > Install > Local Machine > "
        "'Trusted Root Certification Authorities'"
    )
    print(f"    3) Reload  {scheme}://{host_url}:{args.port}/  — trusted, no warning.")


def print_banner(args: argparse.Namespace, scheme: str, ip: str | None) -> None:
    mode = "EMULATED-HARDWARE" if args.emulate else "HARDWARE" if args.hardware else "SIMULATION"
    print(f"Trio Mix-Assistant [{mode}] -> {scheme}://{args.host}:{args.port}/")
    if args.pin:
        print("  PIN auth: ON — the dashboard asks for the PIN before it opens.")
        if scheme != "https":
            print("  [!] PIN over plain http is sniffable on the LAN — add --https.")
    elif args.host in WILDCARD_HOSTS:
        print("  [!] No PIN: anyone on this network can open the dashboard and control the")
        print("      console. On shared WiFi set one (--pin, or PIN= in show.conf).")
    if args.trust and scheme == "https":
        _print_trust_steps(args, scheme, ip)
    if args.emulate:
        print("  Real OSC stack over localhost sockets against the desk emulator.")
        print("  NB: wire formats are assumptions — see HARDWARE_BRINGUP.md to validate.")
    if args.host in WILDCARD_HOSTS and ip:
        tablet_url = f"{scheme}://{ip}:{args.port}/"
        print(f"  Tablet (iPad / Galaxy Tab S7): open  {tablet_url}  then Add to Home Screen")
        alts = [a for a in _all_lan_ips() if a != ip]
        if alts:
            print(
                "  If that's unreachable, try: "
                + ", ".join(f"{scheme}://{a}:{args.port}/" for a in alts)
            )
        if scheme == "https":
            print("  (self-signed: accept the certificate warning once on the tablet)")
        _print_qr(tablet_url)
    elif scheme == "http":
        print("  For a tablet, restart with  --lan  (add --https for Wake Lock).")
    print("Press Ctrl+C to stop.")


def main(argv: list[str] | None = None) -> None:
    _utf8_stdout()
    logging.basicConfig(level=logging.WARNING, format="  [%(levelname)s] %(name)s: %(message)s")
    args = parse_args(argv)

    if args.list_devices:
        from trio_mix.capture import list_audio_devices

        print(list_audio_devices())
        return

    show_template = load_show_template(args)
    chan_map = load_channel_map(args)
    auto_source = autodetect_source() if args.auto else None

    emu = None
    if args.emulate:
        engine, emu = build_emulated(args, show_template, chan_map, auto_source)
    elif args.hardware:
        engine = build_hardware(args, show_template, chan_map, auto_source)
    else:
        engine = build_simulation(args, show_template)

    attach_session_log(engine, args, show_template.name)
    attach_venue(engine, args)
    attach_advisor(engine, args)

    ip = _lan_ip()
    if emu is not None:
        start_emulator(emu, ip, args.trace_osc)
    tls_files, ca_pem = prepare_tls(args)

    try:
        httpd = serve(engine, args.host, args.port, pin=args.pin, ca_pem=ca_pem)
    except OSError as exc:
        if emu is not None:
            emu.stop()
        _fail(
            f"  [!] Could not open the dashboard on port {args.port}: {exc}",
            f"      Another copy already running? Try a different port:  --port {args.port + 1}",
        )
    engine.start()
    scheme = wrap_tls(httpd, tls_files)
    print_banner(args, scheme, ip)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        httpd.shutdown()
        engine.stop()
        if emu is not None:
            emu.stop()


if __name__ == "__main__":
    main()
