import base64
import json
import os
import socket
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from trio_mix.engine import Engine
from trio_mix.server import serve


def _ws_connect(port):
    s = socket.create_connection(("127.0.0.1", port), timeout=5)
    key = base64.b64encode(b"0123456789abcdef").decode()
    s.sendall(
        (
            f"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        ).encode()
    )
    data = b""
    while b"\r\n\r\n" not in data:
        data += s.recv(1024)
    assert b" 101 " in data.split(b"\r\n")[0], data[:64]
    return s


def _ws_recv_n(s, n):
    b = b""
    while len(b) < n:
        b += s.recv(n - len(b))
    return b


def _ws_read(s):
    h = _ws_recv_n(s, 2)
    ln = h[1] & 0x7F
    if ln == 126:
        ln = int.from_bytes(_ws_recv_n(s, 2), "big")
    elif ln == 127:
        ln = int.from_bytes(_ws_recv_n(s, 8), "big")
    return _ws_recv_n(s, ln)


def _ws_send(s, text):
    payload = text.encode()
    s.sendall(bytes([0x81, 0x80 | len(payload)]) + b"\x00\x00\x00\x00" + payload)


def _ws_send_frag(s, payload, fin, opcode):
    b0 = (0x80 if fin else 0x00) | opcode
    s.sendall(bytes([b0, 0x80 | len(payload)]) + b"\x00\x00\x00\x00" + payload)


class TestServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = Engine(sim=True)
        cls.httpd = serve(cls.engine, "127.0.0.1", 0)
        cls.port = cls.httpd.server_address[1]
        cls.t = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.t.start()
        cls.base = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.engine.stop()

    def _get(self, path):
        with urllib.request.urlopen(self.base + path, timeout=5) as r:
            return r.status, r.read().decode("utf-8")

    def _post(self, path, body):
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read().decode("utf-8"))

    def test_index_html(self):
        status, body = self._get("/")
        self.assertEqual(status, 200)
        self.assertIn("Mix-Assistant", body)
        self.assertIn("window.__INITIAL__", body)
        self.assertNotIn("__INITIAL_STATE__", body)
        self.assertIn('<script src="/dashboard.js">', body)

    def test_compiled_scripts_served(self):
        for path, marker in (("/dashboard.js", "function render("), ("/login.js", "/api/login")):
            req = urllib.request.Request(self.base + path)
            with urllib.request.urlopen(req, timeout=5) as r:
                self.assertEqual(r.status, 200)
                self.assertTrue(r.headers["Content-Type"].startswith("text/javascript"))
                self.assertEqual(r.headers["Cache-Control"], "no-cache")
                body = r.read().decode("utf-8")
            self.assertIn(marker, body)
            self.assertNotRegex(body, r"(?m)^\s*(export|import)\b")

    def test_static_js_is_an_allowlist(self):
        for path in ("/server.py", "/../server.py", "/static/dashboard.js", "/dashboard.ts"):
            req = urllib.request.Request(self.base + path)
            try:
                with urllib.request.urlopen(req, timeout=5) as r:
                    status = r.status
            except urllib.error.HTTPError as e:
                status = e.code
            self.assertEqual(status, 404, path)

    def test_state_json(self):
        status, body = self._get("/state")
        self.assertEqual(status, 200)
        data = json.loads(body)
        for key in ("status", "enabled", "channels", "calibration", "log"):
            self.assertIn(key, data)
        self.assertEqual(len(data["channels"]), 8)

    def test_toggle_endpoint(self):
        status, data = self._post("/api/toggle", {"job": "vocal_ride", "on": True})
        self.assertEqual(status, 200)
        self.assertTrue(data["enabled"]["vocal_ride"])
        _, data2 = self._post("/api/toggle", {"job": "vocal_ride", "on": False})
        self.assertFalse(data2["enabled"]["vocal_ride"])

    def test_panic_endpoint(self):
        _, data = self._post("/api/panic", {"on": True})
        self.assertEqual(data["status"], "takeover")
        self.assertTrue(data["main_muted"])
        _, data2 = self._post("/api/panic", {"on": False})
        self.assertEqual(data2["status"], "live")

    def test_lead_target_endpoint(self):
        _, data = self._post("/api/lead_target", {"db": -9.5})
        self.assertAlmostEqual(data["lead"]["target"], -9.5, places=1)

    def test_pwa_assets(self):
        status, body = self._get("/manifest.webmanifest")
        self.assertEqual(status, 200)
        man = json.loads(body)
        self.assertEqual(man["display"], "standalone")
        self.assertTrue(man["icons"])
        istatus, isvg = self._get("/icon.svg")
        self.assertEqual(istatus, 200)
        self.assertIn("<svg", isvg)

    def test_command_endpoint(self):
        status, data = self._post("/api/command", {"type": "mute", "ch": 3, "on": True})
        self.assertEqual(status, 200)
        ch3 = next(c for c in data["channels"] if c["ch"] == 3)
        self.assertTrue(ch3["muted"])

    def test_coach_mode_command(self):
        status, data = self._post("/api/command", {"type": "coach", "on": True})
        self.assertEqual(status, 200)
        self.assertTrue(data["coach"]["on"])
        self.assertEqual(data["op_mode"], "coach")
        self.assertIn("recs", data["coach"])
        _, off = self._post("/api/command", {"type": "coach", "on": False})
        self.assertFalse(off["coach"]["on"])

    def test_initial_state_cannot_break_out_of_script(self):
        with self.engine._lock:
            self.engine.show["current"] = "</script><xss-marker>"
            self.engine._rebuild_telemetry()
        status, html = self._get("/")
        self.assertEqual(status, 200)
        self.assertNotIn("<xss-marker>", html)
        self.assertNotIn("</script><xss-marker>", html)
        self.assertIn("\\u003c/script\\u003e\\u003cxss-marker\\u003e", html)

    def test_websocket_telemetry_and_control(self):
        s = _ws_connect(self.port)
        try:
            first = json.loads(_ws_read(s).decode("utf-8"))
            self.assertEqual(len(first["channels"]), 8)
            _ws_send(s, json.dumps({"type": "fader", "ch": 1, "db": -7.0}))
            time.sleep(0.3)
            self.assertAlmostEqual(self.engine.assistant.fader_db[1], -7.0, places=1)
        finally:
            s.close()

    def test_oversized_body_rejected(self):
        import urllib.error

        big = json.dumps({"type": "toggle", "job": "x", "on": True, "pad": "A" * 70000}).encode()
        req = urllib.request.Request(
            self.base + "/api/command",
            data=big,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(cm.exception.code, 400)

    def test_nan_body_rejected(self):
        import urllib.error

        req = urllib.request.Request(
            self.base + "/api/command",
            data=b'{"type":"fader","ch":1,"db":NaN}',
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(cm.exception.code, 400)

    def test_deeply_nested_json_rejected(self):
        import urllib.error

        body = b"[" * 10000 + b"]" * 10000
        req = urllib.request.Request(
            self.base + "/api/command",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(cm.exception.code, 400)

    def test_unmasked_ws_frame_closes_connection(self):
        s = _ws_connect(self.port)
        try:
            _ws_read(s)
            payload = b'{"type":"fader","ch":2,"db":-3}'
            s.sendall(bytes([0x81, len(payload)]) + payload)
            s.settimeout(2.5)
            closed = False
            try:
                while True:
                    if not s.recv(4096):
                        closed = True
                        break
            except TimeoutError:
                closed = False
            self.assertTrue(closed, "server did not close on an unmasked frame")
        finally:
            s.close()

    def test_websocket_fragmented_message(self):
        s = _ws_connect(self.port)
        try:
            _ws_read(s)
            payload = json.dumps({"type": "fader", "ch": 2, "db": -5.0}).encode()
            mid = len(payload) // 2
            _ws_send_frag(s, payload[:mid], fin=False, opcode=0x1)
            _ws_send_frag(s, payload[mid:], fin=True, opcode=0x0)
            time.sleep(0.3)
            self.assertAlmostEqual(self.engine.assistant.fader_db[2], -5.0, places=1)
        finally:
            s.close()

    def test_sse_stream_yields_frame(self):
        with urllib.request.urlopen(self.base + "/events", timeout=5) as r:
            self.assertEqual(r.status, 200)
            self.assertIn("text/event-stream", r.headers.get("Content-Type", ""))
            chunk = r.read(64)
            self.assertTrue(chunk.startswith(b"data: "))


class TestSecurityHardening(unittest.TestCase):
    """PIN auth + DNS-rebinding Host guard. Each test spins up its own server so
    the (per-process) auth/lockout state stays isolated."""

    def _server(self, pin=None, ca_pem=None):
        eng = Engine(sim=True)
        httpd = serve(eng, "127.0.0.1", 0, pin=pin, ca_pem=ca_pem)
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(eng.stop)
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        return f"http://127.0.0.1:{port}"

    def _req(self, base, method, path, body=None, cookie=None, host=None):
        data = json.dumps(body).encode() if body is not None else None
        headers = {}
        if data is not None:
            headers["Content-Type"] = "application/json"
        if cookie:
            headers["Cookie"] = cookie
        if host:
            headers["Host"] = host
        req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, r.headers, r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read().decode("utf-8")

    def test_rebinding_host_rejected(self):
        base = self._server()
        st, _, _ = self._req(base, "GET", "/", host="evil.example.com")
        self.assertEqual(st, 403)
        st_ip, _, _ = self._req(base, "GET", "/")
        self.assertEqual(st_ip, 200)
        st_local, _, _ = self._req(base, "GET", "/", host="mixer.local")
        self.assertEqual(st_local, 200)

    def test_no_pin_means_open(self):
        base = self._server(pin=None)
        st, _, _ = self._req(base, "GET", "/state")
        self.assertEqual(st, 200)

    def test_unauthed_control_blocked_and_login_page_served(self):
        base = self._server(pin="1352")
        self.assertEqual(self._req(base, "GET", "/state")[0], 401)
        self.assertEqual(
            self._req(base, "POST", "/api/command", {"type": "panic", "on": True})[0], 401
        )
        st, _, body = self._req(base, "GET", "/")
        self.assertEqual(st, 200)
        self.assertIn("access PIN", body)
        self.assertNotIn("__INITIAL__", body)

    def test_public_pwa_assets_need_no_pin(self):
        base = self._server(pin="1352")
        self.assertEqual(self._req(base, "GET", "/manifest.webmanifest")[0], 200)
        self.assertEqual(self._req(base, "GET", "/icon.svg")[0], 200)
        self.assertEqual(self._req(base, "GET", "/login.js")[0], 200)

    def test_favicon_is_served_so_browsers_log_no_404(self):
        base = self._server(pin="1352")
        st, hdrs, body = self._req(base, "GET", "/favicon.ico")
        self.assertEqual(st, 200)
        self.assertEqual(hdrs.get("Content-Type"), "image/svg+xml")
        self.assertIn("<svg", body)

    def test_login_page_loads_external_script(self):
        base = self._server(pin="1352")
        _, _, body = self._req(base, "GET", "/")
        self.assertIn('<script src="/login.js">', body)

    def test_wrong_pin_rejected(self):
        base = self._server(pin="1352")
        st, _, body = self._req(base, "POST", "/api/login", {"pin": "0000"})
        self.assertEqual(st, 401)
        self.assertFalse(json.loads(body)["ok"])

    def test_correct_pin_unlocks_control(self):
        base = self._server(pin="1352")
        st, hdrs, body = self._req(base, "POST", "/api/login", {"pin": "1352"})
        self.assertEqual(st, 200)
        self.assertTrue(json.loads(body)["ok"])
        setc = hdrs.get("Set-Cookie")
        self.assertIn("mixauth=", setc)
        self.assertIn("HttpOnly", setc)
        self.assertIn("SameSite=Strict", setc)
        cookie = setc.split(";", 1)[0]
        self.assertEqual(self._req(base, "GET", "/state", cookie=cookie)[0], 200)
        st_cmd, _, _ = self._req(
            base, "POST", "/api/command", {"type": "mute", "ch": 3, "on": True}, cookie=cookie
        )
        self.assertEqual(st_cmd, 200)
        self.assertEqual(self._req(base, "GET", "/state", cookie="mixauth=nope")[0], 401)

    def test_lockout_after_repeated_failures(self):
        base = self._server(pin="1352")
        for _ in range(5):
            self.assertEqual(self._req(base, "POST", "/api/login", {"pin": "x"})[0], 401)
        self.assertEqual(self._req(base, "POST", "/api/login", {"pin": "x"})[0], 429)

    def test_lockout_does_not_revoke_an_authenticated_device(self):
        base = self._server(pin="1352")
        _, hdrs, _ = self._req(base, "POST", "/api/login", {"pin": "1352"})
        cookie = hdrs.get("Set-Cookie").split(";", 1)[0]
        for _ in range(5):
            self._req(base, "POST", "/api/login", {"pin": "x"})
        self.assertEqual(self._req(base, "POST", "/api/login", {"pin": "x"})[0], 429)
        self.assertEqual(self._req(base, "GET", "/state", cookie=cookie)[0], 200)
        self.assertEqual(
            self._req(
                base, "POST", "/api/command", {"type": "mute", "ch": 3, "on": True}, cookie=cookie
            )[0],
            200,
        )

    def test_parallel_guesses_cannot_exceed_the_attempt_limit(self):
        import socket

        base = self._server(pin="1352")
        port = int(base.rsplit(":", 1)[1])
        body = json.dumps({"pin": "0000"}).encode()
        head = (
            f"POST /api/login HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
            f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n"
        ).encode()
        socks = [socket.create_connection(("127.0.0.1", port), timeout=5) for _ in range(10)]
        try:
            for sock in socks:
                sock.sendall(head)
            time.sleep(0.5)
            codes, pending = [], []
            for sock in socks:
                sock.settimeout(0.3)
                try:
                    codes.append(int(sock.recv(64).split(b" ", 2)[1]))
                except (OSError, IndexError, ValueError):
                    pending.append(sock)
            for sock in pending:
                sock.settimeout(5)
                sock.sendall(body)
            for sock in pending:
                codes.append(int(sock.recv(64).split(b" ", 2)[1]))
        finally:
            for sock in socks:
                sock.close()
        self.assertEqual(codes.count(401), 5, codes)
        self.assertEqual(codes.count(429), 5, codes)

    def _origin_req(self, base, path, body, origin, ctype="application/json"):
        req = urllib.request.Request(
            base + path,
            data=json.dumps(body).encode(),
            headers={"Content-Type": ctype, "Origin": origin},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status
        except urllib.error.HTTPError as e:
            return e.code

    def test_cross_origin_post_rejected(self):
        base = self._server()
        for origin in ("https://evil.example", "http://127.0.0.1:1", "null", "garbage"):
            st = self._origin_req(base, "/api/panic", {"on": True}, origin, ctype="text/plain")
            self.assertEqual(st, 403, origin)
        _, _, body = self._req(base, "GET", "/state")
        self.assertEqual(json.loads(body)["status"], "live")

    def test_same_origin_post_allowed(self):
        base = self._server()
        self.assertEqual(self._origin_req(base, "/api/panic", {"on": True}, base), 200)
        _, _, body = self._req(base, "GET", "/state")
        self.assertEqual(json.loads(body)["status"], "takeover")

    def test_cross_origin_login_rejected(self):
        base = self._server(pin="1352")
        self.assertEqual(
            self._origin_req(base, "/api/login", {"pin": "1352"}, "https://evil.example"), 403
        )

    def _ws_upgrade(self, base, origin=None):
        import base64
        import os
        import socket

        port = int(base.rsplit(":", 1)[1])
        lines = [
            "GET /ws HTTP/1.1",
            f"Host: 127.0.0.1:{port}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: " + base64.b64encode(os.urandom(16)).decode(),
        ]
        if origin is not None:
            lines.append("Origin: " + origin)
        with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
            sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
            return int(sock.recv(64).split(b" ", 2)[1])

    def test_cross_origin_websocket_rejected(self):
        base = self._server()
        self.assertEqual(self._ws_upgrade(base, "https://evil.example"), 403)

    def test_same_origin_and_originless_websocket_allowed(self):
        base = self._server()
        self.assertEqual(self._ws_upgrade(base, base), 101)
        self.assertEqual(self._ws_upgrade(base), 101)

    def test_ca_pem_route(self):
        pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"
        base = self._server(ca_pem=pem)
        st, hdrs, body = self._req(base, "GET", "/ca.pem")
        self.assertEqual(st, 200)
        self.assertIn("BEGIN CERTIFICATE", body)
        self.assertEqual(hdrs.get("Content-Type"), "application/x-x509-ca-cert")
        base_pin = self._server(pin="1352", ca_pem=pem)
        self.assertEqual(self._req(base_pin, "GET", "/ca.pem")[0], 200)

    def test_ca_pem_absent_when_not_configured(self):
        base = self._server()
        self.assertEqual(self._req(base, "GET", "/ca.pem")[0], 404)


class TestOriginGuard(unittest.TestCase):
    def test_origin_rules(self):
        from trio_mix.server import _origin_allowed

        self.assertTrue(_origin_allowed(None, "192.168.1.50:8770"))
        self.assertTrue(_origin_allowed("https://192.168.1.50:8770", "192.168.1.50:8770"))
        self.assertTrue(_origin_allowed("http://Mixer.local:8770", "mixer.local:8770"))
        self.assertTrue(_origin_allowed("https://192.168.1.50", "192.168.1.50"))
        self.assertFalse(_origin_allowed("https://evil.example", "192.168.1.50:8770"))
        self.assertFalse(_origin_allowed("https://192.168.1.50:9999", "192.168.1.50:8770"))
        self.assertFalse(_origin_allowed("null", "192.168.1.50:8770"))
        self.assertFalse(_origin_allowed("", "192.168.1.50:8770"))
        self.assertFalse(_origin_allowed("file://192.168.1.50:8770", "192.168.1.50:8770"))
        self.assertFalse(_origin_allowed("http://[bad", "192.168.1.50:8770"))


class TestLoginLimiter(unittest.TestCase):
    def _limiter(self):
        from trio_mix.server import LoginLimiter

        self.now = 1000.0
        return LoginLimiter(clock=lambda: self.now)

    def test_lockout_is_per_address(self):
        lim = self._limiter()
        admitted = [lim.admit("10.0.0.66") for _ in range(lim.MAX_FAILS + 3)]
        self.assertEqual(admitted, [True] * lim.MAX_FAILS + [False] * 3)
        self.assertTrue(lim.locked("10.0.0.66"))
        self.assertFalse(lim.locked("10.0.0.2"))
        self.assertTrue(lim.admit("10.0.0.2"))

    def test_lock_expires(self):
        lim = self._limiter()
        for _ in range(lim.MAX_FAILS):
            lim.admit("10.0.0.66")
        self.now += lim.LOCK_S + 0.1
        self.assertFalse(lim.locked("10.0.0.66"))
        self.assertTrue(lim.admit("10.0.0.66"))

    def test_success_clears_the_address_and_refunds_the_attempt(self):
        lim = self._limiter()
        for _ in range(lim.MAX_FAILS - 1):
            lim.admit("10.0.0.2")
        self.assertTrue(lim.admit("10.0.0.2"))
        lim.success("10.0.0.2")
        self.assertFalse(lim.locked("10.0.0.2"))
        for _ in range(lim.GLOBAL_ATTEMPTS * 2):
            self.assertTrue(lim.admit("10.0.0.2"))
            lim.success("10.0.0.2")

    def test_distributed_guessing_is_capped_globally(self):
        lim = self._limiter()
        admitted = [lim.admit(f"10.0.1.{i}") for i in range(lim.GLOBAL_ATTEMPTS + 10)]
        self.assertEqual(sum(admitted), lim.GLOBAL_ATTEMPTS)
        self.assertFalse(lim.admit("10.0.9.9"))
        self.now += lim.GLOBAL_WINDOW_S + 1.0
        self.assertTrue(lim.admit("10.0.9.9"))

    def test_address_table_is_bounded(self):
        lim = self._limiter()
        for i in range(lim.MAX_CLIENTS * 3):
            self.now += lim.GLOBAL_WINDOW_S
            lim.admit(f"addr-{i}")
        self.assertLessEqual(len(lim._clients), lim.MAX_CLIENTS)


if __name__ == "__main__":
    unittest.main()
