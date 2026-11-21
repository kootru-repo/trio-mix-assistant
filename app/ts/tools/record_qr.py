import io

import qrcode
from fixture_util import write


def version_of(text):
    qr = qrcode.QRCode(border=2)
    qr.add_data(text)
    qr.make(fit=True)
    return qr.version


def capacity_edges():
    out = []
    for n in range(1, 260):
        version = version_of("a" * n)
        nxt = version_of("a" * (n + 1))
        if nxt != version and version <= 10:
            out.extend(["a" * n, "a" * (n + 1)])
    return out


def inputs():
    urls = [
        "https://192.168.1.23:8770/",
        "http://192.168.1.23:8770/",
        "http://10.0.0.5:8765/",
        "https://10.12.34.56:8770/dashboard",
        "http://192.168.0.101:8770/?pin=1234",
        "https://172.16.254.3:9443/mix/app/index.html?token=abcdef0123456789",
        "http://127.0.0.1:80/",
        "http://192.168.1.23:8770/#/channels/12/strip?bank=2&view=dense&theme=dark",
        "https://192.168.100.200:65535/a/very/long/path/that/keeps/going/and/going/to/push/the/version/up/"
        "index.html?session=0123456789abcdef0123456789abcdef&pin=987654",
    ]
    short = [
        "A",
        "0",
        "hello",
        "HELLO WORLD",
        "12345678901234567890123456789",
        "HTTP://EXAMPLE.COM/ABCDEFGHIJKLMNOP",
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        "abc\n",
        "12345\n",
        "https://192.168.1.23:8770/12345678901234567890123456",
    ]
    non_ascii = [
        "Mix-Assistant café über",
        "ミキサー http://192.168.1.23:8770/",
        "☃☃☃ \U0001f3b9 stage left",
    ]
    return urls + short + capacity_edges() + non_ascii


def render(text):
    qr = qrcode.QRCode(border=2)
    qr.add_data(text)
    qr.make(fit=True)
    buf = io.StringIO()
    qr.print_ascii(out=buf, invert=True)
    rows = ["".join("1" if m else "0" for m in row) for row in qr.modules]
    return {
        "text": text,
        "version": qr.version,
        "modules": rows,
        "ascii": buf.getvalue(),
    }


def main():
    seen = set()
    cases = []
    for text in inputs():
        if text in seen:
            continue
        seen.add(text)
        cases.append(render(text))
    write("qr", {"cases": cases})


if __name__ == "__main__":
    main()
