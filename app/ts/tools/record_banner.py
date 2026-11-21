import contextlib
import io

from fixture_util import write

import run
from trio_mix import config as C

COMBOS = [
    [],
    ["--lan"],
    ["--lan", "--https"],
    ["--lan", "--https", "--pin", "1234"],
    ["--lan", "--pin", "1234"],
    ["--pin", "1234"],
    ["--lan", "--trust"],
    ["--trust"],
    ["--emulate"],
    ["--emulate", "--lan", "--https", "--trace-osc"],
    ["--hardware", "--lan", "--port", "9000"],
    ["--host", "::"],
]


def capture(argv, scheme, ip, alts):
    run.HERE = "<app>"
    run._all_lan_ips = lambda: alts
    run._print_qr = lambda url: print("  Scan with the tablet camera:\n[QR " + url + "]")
    args = run.parse_args(argv)
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        run.print_banner(args, scheme, ip)
    return out.getvalue()


def emulator_text(ip, trace):
    class Emu:
        listen_port = C.CONSOLE_PORT

        def start(self):
            return None

    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        run.start_emulator(Emu(), ip, trace)
    return out.getvalue()


def main():
    cases = []
    for argv in COMBOS:
        for scheme in ("http", "https"):
            for ip, alts in (
                (None, []),
                ("192.168.1.23", ["192.168.1.23", "10.0.0.7", "172.16.4.9"]),
            ):
                cases.append(
                    {
                        "argv": argv,
                        "scheme": scheme,
                        "ip": ip,
                        "alts": alts,
                        "text": capture(argv, scheme, ip, alts),
                    }
                )
    emu = [
        {"ip": ip, "trace": trace, "text": emulator_text(ip, trace)}
        for ip in ("192.168.1.23", None)
        for trace in (False, True)
    ]
    write("banner", {"cases": cases, "emulator": emu})


if __name__ == "__main__":
    main()
