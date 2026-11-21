import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import test from "node:test";
import { ManualClock } from "../src/core/clock.ts";
import { Engine } from "../src/core/engine/index.ts";
import { LoginLimiter, createServer, hostAllowed, jsonForHtml, originAllowed, jsonText, strictLoads } from "../src/host/server.ts";
import type { DashboardServer } from "../src/host/server.ts";

const staticDir = join(import.meta.dirname, "..", "..", "static");

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const request = (
  port: number,
  method: string,
  path: string,
  opts: { body?: string | Buffer; headers?: Record<string, string> } = {},
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(opts.body));
    const req = http.request({ host: "127.0.0.1", port, method, path, headers, agent: false, timeout: 5000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(opts.body);
  });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Rig {
  engine: TestEngine;
  srv: DashboardServer;
  port: number;
  base: string;
  close(): Promise<void>;
}

class TestEngine extends Engine {
  rebuild(): void {
    this.rebuildTelemetry();
  }
}

const rig = async (opts: { pin?: string | null; caPem?: string | null } = {}): Promise<Rig> => {
  const engine = new TestEngine({ clock: new ManualClock(100, 1_700_000_000), sim: true });
  const srv = createServer({ engine, staticDir, pin: opts.pin ?? null, caPem: opts.caPem ?? null });
  const { port } = await srv.start(0, "127.0.0.1");
  return {
    engine,
    srv,
    port,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await srv.stop();
      await engine.stop();
    },
  };
};

const getJson = async (r: Rig, path: string, headers: Record<string, string> = {}): Promise<any> =>
  JSON.parse((await request(r.port, "GET", path, { headers })).body);

const post = (r: Rig, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> =>
  request(r.port, "POST", path, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });

class WsClient {
  private buf: Buffer = Buffer.alloc(0);
  private waiters: (() => void)[] = [];
  closed = false;
  readonly socket: net.Socket;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (c: Buffer) => {
      this.buf = Buffer.concat([this.buf, c]);
      this.wake();
    });
    const onEnd = (): void => {
      this.closed = true;
      this.wake();
    };
    socket.on("close", onEnd);
    socket.on("end", onEnd);
    socket.on("error", onEnd);
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private async until(ready: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!ready()) {
      if (this.closed || Date.now() > deadline) return ready();
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    return true;
  }

  static async connect(port: number, extra: string[] = []): Promise<{ client: WsClient; head: string }> {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const client = new WsClient(socket);
    const key = randomBytes(16).toString("base64");
    socket.write(
      [
        "GET /ws HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${key}`,
        ...extra,
      ].join("\r\n") + "\r\n\r\n",
    );
    await client.until(() => client.buf.includes("\r\n\r\n"), 5000);
    const at = client.buf.indexOf("\r\n\r\n");
    assert.ok(at >= 0, "no handshake response");
    const head = client.buf.subarray(0, at).toString("latin1");
    client.buf = client.buf.subarray(at + 4);
    if (head.startsWith("HTTP/1.1 101")) {
      const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      assert.ok(head.includes(`Sec-WebSocket-Accept: ${accept}`), head);
    }
    return { client, head };
  }

  async read(): Promise<Buffer> {
    assert.ok(await this.until(() => this.frameLen() > 0, 5000), "no frame");
    const n = this.frameLen();
    const frame = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    const h = frame[1]! & 0x7f;
    const off = h === 126 ? 4 : h === 127 ? 10 : 2;
    return Buffer.from(frame.subarray(off));
  }

  private frameLen(): number {
    const b = this.buf;
    if (b.length < 2) return 0;
    let ln = b[1]! & 0x7f;
    let off = 2;
    if (ln === 126) {
      if (b.length < 4) return 0;
      ln = b.readUInt16BE(2);
      off = 4;
    } else if (ln === 127) {
      if (b.length < 10) return 0;
      ln = Number(b.readBigUInt64BE(2));
      off = 10;
    }
    return b.length >= off + ln ? off + ln : 0;
  }

  sendText(text: string): void {
    const p = Buffer.from(text);
    this.socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | p.length]), Buffer.alloc(4), p]));
  }

  sendFrag(p: Buffer, fin: boolean, opcode: number): void {
    this.socket.write(Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | p.length]), Buffer.alloc(4), p]));
  }

  async closedWithin(ms: number): Promise<boolean> {
    return this.until(() => this.closed, ms);
  }

  destroy(): void {
    this.socket.destroy();
  }
}

test("index page seeds the initial state", async () => {
  const r = await rig();
  try {
    const res = await request(r.port, "GET", "/");
    assert.equal(res.status, 200);
    assert.ok(res.body.includes("Mix-Assistant"));
    assert.ok(res.body.includes("window.__INITIAL__"));
    assert.ok(!res.body.includes("__INITIAL_STATE__"));
    assert.ok(res.body.includes('<script src="/dashboard.js">'));
  } finally {
    await r.close();
  }
});

test("compiled scripts are served as plain scripts", async () => {
  const r = await rig();
  try {
    for (const [path, marker] of [
      ["/dashboard.js", "function render("],
      ["/login.js", "/api/login"],
    ] as const) {
      const res = await request(r.port, "GET", path);
      assert.equal(res.status, 200);
      assert.ok(String(res.headers["content-type"]).startsWith("text/javascript"));
      assert.equal(res.headers["cache-control"], "no-cache");
      assert.ok(res.body.includes(marker));
      assert.ok(!/^\s*(export|import)\b/m.test(res.body));
    }
  } finally {
    await r.close();
  }
});

test("static scripts are an allowlist", async () => {
  const r = await rig();
  try {
    for (const path of ["/server.ts", "/../server.ts", "/static/dashboard.js", "/dashboard.ts"]) {
      assert.equal((await request(r.port, "GET", path)).status, 404, path);
    }
  } finally {
    await r.close();
  }
});

test("state, control endpoints and PWA assets", async () => {
  const r = await rig();
  try {
    const st = await request(r.port, "GET", "/state");
    assert.equal(st.status, 200);
    const data = JSON.parse(st.body);
    for (const key of ["status", "enabled", "channels", "calibration", "log"]) assert.ok(key in data, key);
    assert.equal(data.channels.length, 8);

    let res = await post(r, "/api/toggle", { job: "vocal_ride", on: true });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).enabled.vocal_ride, true);
    res = await post(r, "/api/toggle", { job: "vocal_ride", on: false });
    assert.equal(JSON.parse(res.body).enabled.vocal_ride, false);

    let d = JSON.parse((await post(r, "/api/panic", { on: true })).body);
    assert.equal(d.status, "takeover");
    assert.equal(d.main_muted, true);
    d = JSON.parse((await post(r, "/api/panic", { on: false })).body);
    assert.equal(d.status, "live");

    d = JSON.parse((await post(r, "/api/lead_target", { db: -9.5 })).body);
    assert.ok(Math.abs(d.lead.target - -9.5) < 0.05);

    const man = await request(r.port, "GET", "/manifest.webmanifest");
    assert.equal(man.status, 200);
    const manifest = JSON.parse(man.body);
    assert.equal(manifest.display, "standalone");
    assert.ok(manifest.icons.length > 0);
    const icon = await request(r.port, "GET", "/icon.svg");
    assert.equal(icon.status, 200);
    assert.ok(icon.body.includes("<svg"));
  } finally {
    await r.close();
  }
});

test("command endpoint and coach mode", async () => {
  const r = await rig();
  try {
    const res = await post(r, "/api/command", { type: "mute", ch: 3, on: true });
    assert.equal(res.status, 200);
    const ch3 = JSON.parse(res.body).channels.find((c: any) => c.ch === 3);
    assert.equal(ch3.muted, true);

    const coach = await post(r, "/api/command", { type: "coach", on: true });
    assert.equal(coach.status, 200);
    const data = JSON.parse(coach.body);
    assert.equal(data.coach.on, true);
    assert.equal(data.op_mode, "coach");
    assert.ok("recs" in data.coach);
    const off = JSON.parse((await post(r, "/api/command", { type: "coach", on: false })).body);
    assert.equal(off.coach.on, false);
  } finally {
    await r.close();
  }
});

test("initial state cannot break out of the script element", async () => {
  const r = await rig();
  try {
    r.engine.show.current = "</script><xss-marker>";
    r.engine.rebuild();
    const res = await request(r.port, "GET", "/");
    assert.equal(res.status, 200);
    assert.ok(!res.body.includes("<xss-marker>"));
    assert.ok(!res.body.includes("</script><xss-marker>"));
    assert.ok(res.body.includes("\\u003c/script\\u003e\\u003cxss-marker\\u003e"));
  } finally {
    await r.close();
  }
});

test("websocket telemetry and control", async () => {
  const r = await rig();
  const { client, head } = await WsClient.connect(r.port);
  try {
    assert.ok(head.startsWith("HTTP/1.1 101"), head);
    const first = JSON.parse((await client.read()).toString("utf8"));
    assert.equal(first.channels.length, 8);
    client.sendText(JSON.stringify({ type: "fader", ch: 1, db: -7.0 }));
    await sleep(300);
    assert.ok(Math.abs(r.engine.assistant.faderDb.get(1)! - -7.0) < 0.05);
  } finally {
    client.destroy();
    await r.close();
  }
});

test("oversized, NaN and deeply nested bodies are rejected with 400", async () => {
  const r = await rig();
  try {
    const big = JSON.stringify({ type: "toggle", job: "x", on: true, pad: "A".repeat(70000) });
    const cases: (string | Buffer)[] = [
      big,
      '{"type":"fader","ch":1,"db":NaN}',
      "[".repeat(10000) + "]".repeat(10000),
    ];
    for (const body of cases) {
      const res = await request(r.port, "POST", "/api/command", { body, headers: { "Content-Type": "application/json" } });
      assert.equal(res.status, 400);
    }
  } finally {
    await r.close();
  }
});

test("an unmasked websocket frame closes the connection", async () => {
  const r = await rig();
  const { client } = await WsClient.connect(r.port);
  try {
    await client.read();
    const payload = Buffer.from('{"type":"fader","ch":2,"db":-3}');
    client.socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    assert.ok(await client.closedWithin(2500), "server did not close on an unmasked frame");
  } finally {
    client.destroy();
    await r.close();
  }
});

test("websocket fragmented message", async () => {
  const r = await rig();
  const { client } = await WsClient.connect(r.port);
  try {
    await client.read();
    const payload = Buffer.from(JSON.stringify({ type: "fader", ch: 2, db: -5.0 }));
    const mid = payload.length >> 1;
    client.sendFrag(payload.subarray(0, mid), false, 0x1);
    client.sendFrag(payload.subarray(mid), true, 0x0);
    await sleep(300);
    assert.ok(Math.abs(r.engine.assistant.faderDb.get(2)! - -5.0) < 0.05);
  } finally {
    client.destroy();
    await r.close();
  }
});

test("websocket ping is answered with a pong and a stray continuation closes", async () => {
  const r = await rig();
  const { client } = await WsClient.connect(r.port);
  try {
    await client.read();
    const p = Buffer.from("hi");
    client.socket.write(Buffer.concat([Buffer.from([0x89, 0x80 | p.length]), Buffer.alloc(4), p]));
    let pong = false;
    for (let i = 0; i < 5 && !pong; i++) {
      const f = await client.read();
      pong = f.toString("utf8") === "hi";
    }
    assert.ok(pong, "no pong");
    client.sendFrag(Buffer.from("x"), true, 0x0);
    assert.ok(await client.closedWithin(2500));
  } finally {
    client.destroy();
    await r.close();
  }
});

test("sse stream yields a frame", async () => {
  const r = await rig();
  try {
    const chunk = await new Promise<{ status: number; ctype: string; data: Buffer }>((resolve, reject) => {
      const req = http.get(r.base + "/events", { agent: false, timeout: 5000 }, (res) => {
        res.once("data", (c: Buffer) => {
          resolve({ status: res.statusCode ?? 0, ctype: String(res.headers["content-type"]), data: c });
          req.destroy();
        });
      });
      req.on("error", (e) => {
        if (!req.destroyed) reject(e);
      });
    });
    assert.equal(chunk.status, 200);
    assert.ok(chunk.ctype.includes("text/event-stream"));
    assert.ok(chunk.data.toString("utf8").startsWith("data: "));
  } finally {
    await r.close();
  }
});

test("concurrent streams are capped at 32 and released on close", async () => {
  const r = await rig();
  const open: http.ClientRequest[] = [];
  try {
    const status: number[] = [];
    for (let i = 0; i < 33; i++) {
      status.push(
        await new Promise<number>((resolve, reject) => {
          const req = http.get(r.base + "/events", { agent: false }, (res) => {
            resolve(res.statusCode ?? 0);
            res.resume();
          });
          open.push(req);
          req.on("error", (e) => {
            if (!req.destroyed) reject(e);
          });
        }),
      );
    }
    assert.equal(status.filter((s) => s === 200).length, 32);
    assert.equal(status[32], 503);
    for (const req of open) req.destroy();
    for (let i = 0; i < 40 && r.srv.streamsInUse > 0; i++) await sleep(50);
    assert.equal(r.srv.streamsInUse, 0);
  } finally {
    for (const req of open) req.destroy();
    await r.close();
  }
});

test("Host header guard rejects rebinding names", async () => {
  const r = await rig();
  try {
    assert.equal((await request(r.port, "GET", "/", { headers: { Host: "evil.example.com" } })).status, 403);
    assert.equal((await request(r.port, "GET", "/")).status, 200);
    assert.equal((await request(r.port, "GET", "/", { headers: { Host: "mixer.local" } })).status, 200);
  } finally {
    await r.close();
  }
});

test("no PIN means open", async () => {
  const r = await rig({ pin: null });
  try {
    assert.equal((await request(r.port, "GET", "/state")).status, 200);
  } finally {
    await r.close();
  }
});

test("unauthenticated control is blocked and the login page is served", async () => {
  const r = await rig({ pin: "1352" });
  try {
    assert.equal((await request(r.port, "GET", "/state")).status, 401);
    assert.equal((await post(r, "/api/command", { type: "panic", on: true })).status, 401);
    const res = await request(r.port, "GET", "/");
    assert.equal(res.status, 200);
    assert.ok(res.body.includes("access PIN"));
    assert.ok(!res.body.includes("__INITIAL__"));
    assert.ok(res.body.includes('<script src="/login.js">'));
  } finally {
    await r.close();
  }
});

test("public PWA assets and the favicon need no PIN", async () => {
  const r = await rig({ pin: "1352" });
  try {
    assert.equal((await request(r.port, "GET", "/manifest.webmanifest")).status, 200);
    assert.equal((await request(r.port, "GET", "/icon.svg")).status, 200);
    assert.equal((await request(r.port, "GET", "/login.js")).status, 200);
    const fav = await request(r.port, "GET", "/favicon.ico");
    assert.equal(fav.status, 200);
    assert.equal(fav.headers["content-type"], "image/svg+xml");
    assert.ok(fav.body.includes("<svg"));
  } finally {
    await r.close();
  }
});

test("a wrong PIN is rejected", async () => {
  const r = await rig({ pin: "1352" });
  try {
    const res = await post(r, "/api/login", { pin: "0000" });
    assert.equal(res.status, 401);
    assert.equal(JSON.parse(res.body).ok, false);
  } finally {
    await r.close();
  }
});

test("the correct PIN unlocks control", async () => {
  const r = await rig({ pin: "1352" });
  try {
    const res = await post(r, "/api/login", { pin: "1352" });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).ok, true);
    const setc = String(res.headers["set-cookie"]);
    assert.ok(setc.includes("mixauth="));
    assert.ok(setc.includes("HttpOnly"));
    assert.ok(setc.includes("SameSite=Strict"));
    assert.ok(!setc.includes("Secure"));
    const cookie = setc.split(";", 1)[0]!;
    assert.equal((await request(r.port, "GET", "/state", { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await post(r, "/api/command", { type: "mute", ch: 3, on: true }, { Cookie: cookie })).status, 200);
    assert.equal((await request(r.port, "GET", "/state", { headers: { Cookie: "mixauth=nope" } })).status, 401);
  } finally {
    await r.close();
  }
});

test("lockout after repeated failures", async () => {
  const r = await rig({ pin: "1352" });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await post(r, "/api/login", { pin: "x" })).status, 401);
    assert.equal((await post(r, "/api/login", { pin: "x" })).status, 429);
  } finally {
    await r.close();
  }
});

test("lockout does not revoke an authenticated device", async () => {
  const r = await rig({ pin: "1352" });
  try {
    const login = await post(r, "/api/login", { pin: "1352" });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
    for (let i = 0; i < 5; i++) await post(r, "/api/login", { pin: "x" });
    assert.equal((await post(r, "/api/login", { pin: "x" })).status, 429);
    assert.equal((await request(r.port, "GET", "/state", { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await post(r, "/api/command", { type: "mute", ch: 3, on: true }, { Cookie: cookie })).status, 200);
  } finally {
    await r.close();
  }
});

test("parallel guesses cannot exceed the attempt limit", async () => {
  const r = await rig({ pin: "1352" });
  const body = JSON.stringify({ pin: "0000" });
  const head =
    `POST /api/login HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\n` +
    `Content-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`;
  const socks: net.Socket[] = [];
  const replies: string[] = [];
  const waiting: ((() => void) | null)[] = [];
  try {
    for (let i = 0; i < 10; i++) {
      const s = net.createConnection({ host: "127.0.0.1", port: r.port });
      s.setEncoding("latin1");
      replies.push("");
      waiting.push(null);
      s.on("data", (c: string) => {
        replies[i] += c;
      });
      s.on("error", () => undefined);
      socks.push(s);
      await new Promise<void>((resolve) => s.once("connect", resolve));
    }
    for (const s of socks) s.write(head);
    await sleep(500);
    const code = (i: number): number => Number(replies[i]!.split(" ", 3)[1]);
    const pending = socks.map((_, i) => i).filter((i) => replies[i] === "");
    const codes = socks.map((_, i) => i).filter((i) => replies[i] !== "").map(code);
    for (const i of pending) socks[i]!.write(body);
    for (let t = 0; t < 100 && pending.some((i) => replies[i] === ""); t++) await sleep(50);
    for (const i of pending) codes.push(code(i));
    assert.equal(codes.filter((c) => c === 401).length, 5, String(codes));
    assert.equal(codes.filter((c) => c === 429).length, 5, String(codes));
  } finally {
    for (const s of socks) s.destroy();
    await r.close();
  }
});

test("a cross-origin POST is rejected and a same-origin POST is allowed", async () => {
  const r = await rig();
  try {
    for (const origin of ["https://evil.example", "http://127.0.0.1:1", "null", "garbage"]) {
      const res = await request(r.port, "POST", "/api/panic", {
        body: JSON.stringify({ on: true }),
        headers: { "Content-Type": "text/plain", Origin: origin },
      });
      assert.equal(res.status, 403, origin);
    }
    assert.equal((await getJson(r, "/state")).status, "live");
    const ok = await request(r.port, "POST", "/api/panic", {
      body: JSON.stringify({ on: true }),
      headers: { "Content-Type": "application/json", Origin: r.base },
    });
    assert.equal(ok.status, 200);
    assert.equal((await getJson(r, "/state")).status, "takeover");
  } finally {
    await r.close();
  }
});

test("a cross-origin login is rejected", async () => {
  const r = await rig({ pin: "1352" });
  try {
    const res = await post(r, "/api/login", { pin: "1352" }, { Origin: "https://evil.example" });
    assert.equal(res.status, 403);
  } finally {
    await r.close();
  }
});

test("websocket origin guard", async () => {
  const r = await rig();
  try {
    const bad = await WsClient.connect(r.port, ["Origin: https://evil.example"]);
    assert.ok(bad.head.startsWith("HTTP/1.1 403"), bad.head);
    bad.client.destroy();
    const same = await WsClient.connect(r.port, [`Origin: ${r.base}`]);
    assert.ok(same.head.startsWith("HTTP/1.1 101"), same.head);
    same.client.destroy();
    const none = await WsClient.connect(r.port);
    assert.ok(none.head.startsWith("HTTP/1.1 101"), none.head);
    none.client.destroy();
  } finally {
    await r.close();
  }
});

test("websocket needs the PIN cookie", async () => {
  const r = await rig({ pin: "1352" });
  try {
    const anon = await WsClient.connect(r.port);
    assert.ok(anon.head.startsWith("HTTP/1.1 401"), anon.head);
    anon.client.destroy();
    const login = await post(r, "/api/login", { pin: "1352" });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
    const ok = await WsClient.connect(r.port, [`Cookie: ${cookie}`]);
    assert.ok(ok.head.startsWith("HTTP/1.1 101"), ok.head);
    ok.client.destroy();
  } finally {
    await r.close();
  }
});

test("the CA certificate route", async () => {
  const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
  const a = await rig({ caPem: pem });
  const b = await rig({ pin: "1352", caPem: pem });
  const c = await rig();
  try {
    const res = await request(a.port, "GET", "/ca.pem");
    assert.equal(res.status, 200);
    assert.ok(res.body.includes("BEGIN CERTIFICATE"));
    assert.equal(res.headers["content-type"], "application/x-x509-ca-cert");
    assert.equal((await request(b.port, "GET", "/ca.pem")).status, 200);
    assert.equal((await request(c.port, "GET", "/ca.pem")).status, 404);
  } finally {
    await a.close();
    await b.close();
    await c.close();
  }
});

test("origin rules", () => {
  assert.ok(originAllowed(null, "192.168.1.50:8770"));
  assert.ok(originAllowed("https://192.168.1.50:8770", "192.168.1.50:8770"));
  assert.ok(originAllowed("http://Mixer.local:8770", "mixer.local:8770"));
  assert.ok(originAllowed("https://192.168.1.50", "192.168.1.50"));
  assert.ok(!originAllowed("https://evil.example", "192.168.1.50:8770"));
  assert.ok(!originAllowed("https://192.168.1.50:9999", "192.168.1.50:8770"));
  assert.ok(!originAllowed("null", "192.168.1.50:8770"));
  assert.ok(!originAllowed("", "192.168.1.50:8770"));
  assert.ok(!originAllowed("file://192.168.1.50:8770", "192.168.1.50:8770"));
  assert.ok(!originAllowed("http://[bad", "192.168.1.50:8770"));
});

test("host rules", () => {
  for (const h of ["", "127.0.0.1:8770", "localhost", "LOCALHOST:80", "mixer.local", "[::1]:8770", "::1", "10.0.0.2"]) {
    assert.ok(hostAllowed(h), h);
  }
  for (const h of ["evil.example.com", "evil.example.com:8770", "10.0.0.2.evil.com"]) assert.ok(!hostAllowed(h), h);
});

test("strict JSON and serialisation", () => {
  assert.throws(() => strictLoads('{"a":NaN}'));
  assert.throws(() => strictLoads('{"a":Infinity}'));
  assert.throws(() => strictLoads("[".repeat(5000) + "]".repeat(5000)));
  assert.deepEqual(strictLoads('{"a":[1,2,{"b":"]["}]}'), { a: [1, 2, { b: "][" }] });
  assert.equal(jsonText({ a: [1, 2.5, "x", null, true], b: { c: "é" } }), '{"a": [1, 2.5, "x", null, true], "b": {"c": "\\u00e9"}}');
  assert.equal(jsonText([1e-7, 1.5e20, 0.0001, NaN]), "[1e-07, 1.5e+20, 0.0001, NaN]");
  assert.equal(jsonForHtml({ s: "</script>&" }), '{"s": "\\u003c/script\\u003e\\u0026"}');
});

const limiter = (): { lim: LoginLimiter; clock: { now: number } } => {
  const clock = { now: 1000.0 };
  return { lim: new LoginLimiter(() => clock.now), clock };
};

test("limiter lockout is per address", () => {
  const { lim } = limiter();
  const admitted = Array.from({ length: lim.maxFails + 3 }, () => lim.admit("10.0.0.66"));
  assert.deepEqual(admitted, [...Array(lim.maxFails).fill(true), false, false, false]);
  assert.ok(lim.locked("10.0.0.66"));
  assert.ok(!lim.locked("10.0.0.2"));
  assert.ok(lim.admit("10.0.0.2"));
});

test("limiter lock expires", () => {
  const { lim, clock } = limiter();
  for (let i = 0; i < lim.maxFails; i++) lim.admit("10.0.0.66");
  clock.now += lim.lockS + 0.1;
  assert.ok(!lim.locked("10.0.0.66"));
  assert.ok(lim.admit("10.0.0.66"));
});

test("limiter success clears the address and refunds the attempt", () => {
  const { lim } = limiter();
  for (let i = 0; i < lim.maxFails - 1; i++) lim.admit("10.0.0.2");
  assert.ok(lim.admit("10.0.0.2"));
  lim.success("10.0.0.2");
  assert.ok(!lim.locked("10.0.0.2"));
  for (let i = 0; i < lim.globalAttempts * 2; i++) {
    assert.ok(lim.admit("10.0.0.2"));
    lim.success("10.0.0.2");
  }
});

test("limiter caps distributed guessing globally", () => {
  const { lim, clock } = limiter();
  const admitted = Array.from({ length: lim.globalAttempts + 10 }, (_, i) => lim.admit(`10.0.1.${i}`));
  assert.equal(admitted.filter(Boolean).length, lim.globalAttempts);
  assert.ok(!lim.admit("10.0.9.9"));
  clock.now += lim.globalWindowS + 1.0;
  assert.ok(lim.admit("10.0.9.9"));
});

test("limiter address table is bounded", () => {
  const { lim, clock } = limiter();
  for (let i = 0; i < lim.maxClients * 3; i++) {
    clock.now += lim.globalWindowS;
    lim.admit(`addr-${i}`);
  }
  assert.ok(lim.clientCount <= lim.maxClients);
});
