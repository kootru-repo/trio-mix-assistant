import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import tls from "node:tls";
import { ManualClock } from "../src/core/clock.ts";
import { Engine } from "../src/core/engine/index.ts";
import { ensureCert } from "../src/host/tls.ts";
import { createServer } from "../src/host/server.ts";
import { hostAllowed, originAllowed } from "../src/host/server/guards.ts";
import { jsonForHtml, jsonText, strictLoads } from "../src/host/server/json.ts";
import { LoginLimiter } from "../src/host/server/limiter.ts";
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

const rig = async (
  opts: { pin?: string | null; caPem?: string | null; limiter?: LoginLimiter; tls?: { key: string; cert: string } } = {},
): Promise<Rig> => {
  const engine = new TestEngine({ clock: new ManualClock(100, 1_700_000_000), sim: true });
  const srv = createServer({
    engine,
    staticDir,
    pin: opts.pin ?? null,
    caPem: opts.caPem ?? null,
    ...(opts.limiter !== undefined ? { limiter: opts.limiter } : {}),
    ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
  });
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
  lastOpcode = -1;
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

  static async connect(
    port: number,
    extra: string[] = [],
    keyOverride?: string,
  ): Promise<{ client: WsClient; head: string }> {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const client = new WsClient(socket);
    const key = keyOverride ?? randomBytes(16).toString("base64");
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
    this.lastOpcode = frame[0]! & 0x0f;
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

  sendRaw(b0: number, payload: Buffer): void {
    this.socket.write(Buffer.concat([Buffer.from([b0, 0x80 | payload.length]), Buffer.alloc(4), payload]));
  }

  async readUntilClose(): Promise<number | null> {
    for (let i = 0; i < 20; i++) {
      let f: Buffer;
      try {
        f = await this.read();
      } catch {
        return null;
      }
      if (this.lastOpcode === 0x8) return f.length >= 2 ? f.readUInt16BE(0) : 0;
    }
    return null;
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
  const r = await rig({ pin: "135246" });
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
  const r = await rig({ pin: "135246" });
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
  const r = await rig({ pin: "135246" });
  try {
    const res = await post(r, "/api/login", { pin: "0000" });
    assert.equal(res.status, 401);
    assert.equal(JSON.parse(res.body).ok, false);
  } finally {
    await r.close();
  }
});

test("the correct PIN unlocks control", async () => {
  const r = await rig({ pin: "135246" });
  try {
    const res = await post(r, "/api/login", { pin: "135246" });
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
  const r = await rig({ pin: "135246" });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await post(r, "/api/login", { pin: "x" })).status, 401);
    assert.equal((await post(r, "/api/login", { pin: "x" })).status, 429);
  } finally {
    await r.close();
  }
});

test("lockout does not revoke an authenticated device", async () => {
  const r = await rig({ pin: "135246" });
  try {
    const login = await post(r, "/api/login", { pin: "135246" });
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
  const r = await rig({ pin: "135246" });
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
  const r = await rig({ pin: "135246" });
  try {
    const res = await post(r, "/api/login", { pin: "135246" }, { Origin: "https://evil.example" });
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
  const r = await rig({ pin: "135246" });
  try {
    const anon = await WsClient.connect(r.port);
    assert.ok(anon.head.startsWith("HTTP/1.1 401"), anon.head);
    anon.client.destroy();
    const login = await post(r, "/api/login", { pin: "135246" });
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
  const b = await rig({ pin: "135246", caPem: pem });
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
  assert.equal(jsonText({ a: [1, 2.5, "x", null, true], b: { c: "é" } }), '{"a":[1,2.5,"x",null,true],"b":{"c":"é"}}');
  assert.equal(jsonText([1e-7, 1.5e20, 0.0001, NaN, Infinity]), "[1e-7,150000000000000000000,0.0001,null,null]");
  assert.equal(jsonText(undefined), "null");
  assert.equal(jsonForHtml({ s: "</script>&" }), '{"s":"\\u003c/script\\u003e\\u0026"}');
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

test("limiter caps distributed guessing globally but lets fresh addresses in up to a larger limit", () => {
  const { lim, clock } = limiter();
  assert.ok(lim.admit("10.0.0.1"));
  for (let i = 0; i < lim.globalAttempts - 1; i++) assert.ok(lim.admit("10.0.1." + i));
  assert.ok(!lim.admit("10.0.0.1"));
  const fresh = Array.from({ length: lim.globalFreshAttempts }, (_, i) => lim.admit("10.1.0." + i));
  assert.equal(fresh.filter(Boolean).length, lim.globalFreshAttempts - lim.globalAttempts);
  assert.ok(!lim.admit("10.9.9.9"));
  clock.now += lim.globalWindowS + 1.0;
  assert.ok(lim.admit("10.9.9.9"));
});

test("a correct PIN from a fresh address is not blocked by a few failing addresses", () => {
  const { lim } = limiter();
  for (let a = 0; a < 4; a++) for (let i = 0; i < 5; i++) lim.admit("10.0.3." + a);
  assert.ok(lim.admit("10.0.4.4"));
});

test("limiter keys IPv6 addresses by their /64", () => {
  const { lim } = limiter();
  for (let i = 0; i < lim.maxFails; i++) lim.admit("2001:db8:1:2:aaaa::" + (i + 1).toString(16));
  assert.ok(lim.locked("2001:db8:1:2:bbbb::9"));
  assert.ok(!lim.admit("2001:db8:1:2::ffff"));
  assert.ok(!lim.locked("2001:db8:1:3::1"));
  assert.ok(lim.admit("2001:db8:1:3::1"));
});

test("limiter success removes only the matching address from the global window", () => {
  const { lim, clock } = limiter();
  assert.ok(lim.admit("10.0.5.0"));
  clock.now += 30;
  for (let i = 0; i < lim.globalAttempts - 1; i++) assert.ok(lim.admit("10.0.6." + i));
  lim.success("10.0.5.0");
  clock.now += 31;
  assert.ok(lim.admit("10.0.6.0"));
  assert.ok(!lim.admit("10.0.6.0"));
});

test("limiter address table is bounded", () => {
  const { lim, clock } = limiter();
  for (let i = 0; i < lim.maxClients * 3; i++) {
    clock.now += lim.globalWindowS;
    lim.admit(`addr-${i}`);
  }
  assert.ok(lim.clientCount <= lim.maxClients);
});

const quietErrors = async (fn: () => Promise<void>): Promise<void> => {
  const original = console.error;
  console.error = () => undefined;
  try {
    await fn();
  } finally {
    console.error = original;
  }
};

const sseCollector = (port: number): { chunks: string[]; req: http.ClientRequest } => {
  const chunks: string[] = [];
  const req = http.get({ host: "127.0.0.1", port, path: "/events", agent: false }, (res) => {
    res.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  });
  req.on("error", () => undefined);
  return { chunks, req };
};

test("a fragmentation flood is closed quickly with 1009 and does not stall the server", async () => {
  const r = await rig();
  const { client } = await WsClient.connect(r.port);
  try {
    await client.read();
    const parts: Buffer[] = [Buffer.from([0x01, 0x81, 0, 0, 0, 0, 0x78])];
    const cont = Buffer.from([0x00, 0x81, 0, 0, 0, 0, 0x78]);
    for (let i = 0; i < 262000; i++) parts.push(cont);
    const started = Date.now();
    client.socket.write(Buffer.concat(parts));
    assert.equal(await client.readUntilClose(), 1009);
    const probe = Date.now();
    assert.equal((await request(r.port, "GET", "/manifest.webmanifest")).status, 200);
    assert.ok(Date.now() - probe < 1000);
    assert.ok(Date.now() - started < 2500, "flood took " + String(Date.now() - started) + " ms");
  } finally {
    client.destroy();
    await r.close();
  }
});

test("a fragmented message up to the frame cap is delivered", async () => {
  const r = await rig();
  const { client } = await WsClient.connect(r.port);
  try {
    await client.read();
    const payload = Buffer.from(JSON.stringify({ type: "fader", ch: 4, db: -6.0 }) + " ".repeat(60));
    const mid = payload.length - 63;
    client.sendFrag(payload.subarray(0, mid), false, 0x1);
    for (let i = mid; i < payload.length - 1; i++) client.sendFrag(payload.subarray(i, i + 1), false, 0x0);
    client.sendFrag(payload.subarray(payload.length - 1), true, 0x0);
    await sleep(300);
    assert.ok(Math.abs(r.engine.assistant.faderDb.get(4)! - -6.0) < 0.05);
  } finally {
    client.destroy();
    await r.close();
  }
});

test("websocket protocol violations close with 1002", async () => {
  const cases: [string, (c: WsClient) => void][] = [
    ["reserved bit", (c) => c.sendRaw(0xc1, Buffer.from("x"))],
    ["fragmented ping", (c) => c.sendRaw(0x09, Buffer.from("x"))],
    ["oversized ping", (c) => c.socket.write(Buffer.concat([Buffer.from([0x89, 0x80 | 126, 0, 126]), Buffer.alloc(4), Buffer.alloc(126)]))],
    ["reserved opcode", (c) => c.sendRaw(0x83, Buffer.from("x"))],
    ["reserved control opcode", (c) => c.sendRaw(0x8b, Buffer.from("x"))],
    [
      "data frame inside a fragmented message",
      (c) => {
        c.sendRaw(0x01, Buffer.from("a"));
        c.sendRaw(0x81, Buffer.from("b"));
      },
    ],
    ["stray continuation", (c) => c.sendRaw(0x80, Buffer.from("x"))],
    ["one byte close payload", (c) => c.sendRaw(0x88, Buffer.from([0x03]))],
  ];
  const r = await rig();
  try {
    for (const [name, act] of cases) {
      const { client } = await WsClient.connect(r.port);
      try {
        await client.read();
        act(client);
        assert.equal(await client.readUntilClose(), 1002, name);
      } finally {
        client.destroy();
      }
    }
  } finally {
    await r.close();
  }
});

test("an oversized websocket frame closes with 1009 and a close frame echoes its code", async () => {
  const r = await rig();
  try {
    const big = await WsClient.connect(r.port);
    await big.client.read();
    const hdr = Buffer.alloc(14);
    hdr[0] = 0x81;
    hdr[1] = 0x80 | 127;
    hdr.writeBigUInt64BE(BigInt(1 << 20), 2);
    big.client.socket.write(hdr);
    assert.equal(await big.client.readUntilClose(), 1009);
    big.client.destroy();
    const echo = await WsClient.connect(r.port);
    await echo.client.read();
    echo.client.sendRaw(0x88, Buffer.from([0x03, 0xe9]));
    assert.equal(await echo.client.readUntilClose(), 1001);
    echo.client.destroy();
  } finally {
    await r.close();
  }
});

test("the websocket key must be 16 random bytes in base64", async () => {
  const r = await rig();
  try {
    for (const key of ["abc", "", "!!!!!!!!!!!!!!!!!!!!!!==", randomBytes(15).toString("base64"), randomBytes(17).toString("base64")]) {
      const bad = await WsClient.connect(r.port, [], key);
      assert.ok(bad.head.startsWith("HTTP/1.1 400"), `${key}: ${bad.head}`);
      bad.client.destroy();
    }
    const ok = await WsClient.connect(r.port);
    assert.ok(ok.head.startsWith("HTTP/1.1 101"));
    ok.client.destroy();
  } finally {
    await r.close();
  }
});

test("an engine that throws while streaming does not take the server down", async () => {
  await quietErrors(async () => {
    const r = await rig();
    const sse = sseCollector(r.port);
    const { client } = await WsClient.connect(r.port);
    try {
      await client.read();
      await sleep(150);
      const original = r.engine.snapshot();
      r.engine.snapshot = () => {
        throw new Error("boom");
      };
      await sleep(450);
      assert.equal((await request(r.port, "GET", "/manifest.webmanifest")).status, 200);
      assert.equal((await request(r.port, "GET", "/state")).status, 500);
      assert.equal((await request(r.port, "GET", "/")).status, 500);
      const recovered = { ...original, uptime: 777777 };
      r.engine.snapshot = () => recovered;
      const seen = JSON.parse((await client.read()).toString("utf8"));
      assert.equal(seen.uptime, 777777);
      await sleep(250);
      assert.ok(sse.chunks.join("").includes('"uptime":777777'));
      assert.equal((await request(r.port, "GET", "/manifest.webmanifest")).status, 200);
    } finally {
      sse.req.destroy();
      client.destroy();
      await r.close();
    }
  });
});

test("an engine bug on a POST is a 500 and the server survives; bad input stays a 400", async () => {
  await quietErrors(async () => {
    const limiter = new LoginLimiter();
    const r = await rig({ pin: "135246", limiter });
    try {
      const login = await post(r, "/api/login", { pin: "135246" });
      const cookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
      r.engine.panic = () => {
        throw new TypeError("engine bug");
      };
      assert.equal((await post(r, "/api/panic", { on: true }, { Cookie: cookie })).status, 500);
      const broken = await request(r.port, "POST", "/api/command", { body: "{broken", headers: { Cookie: cookie } });
      assert.equal(broken.status, 400);
      limiter.success = () => {
        throw new Error("limiter bug");
      };
      assert.equal((await post(r, "/api/login", { pin: "135246" })).status, 500);
      assert.equal((await request(r.port, "GET", "/manifest.webmanifest")).status, 200);
    } finally {
      await r.close();
    }
  });
});

test("every response carries the security headers and the inline script carries the nonce", async () => {
  const r = await rig();
  try {
    const a = await request(r.port, "GET", "/");
    const b = await request(r.port, "GET", "/");
    const csp = String(a.headers["content-security-policy"]);
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce);
    assert.notEqual(nonce, /'nonce-([^']+)'/.exec(String(b.headers["content-security-policy"]))?.[1]);
    for (const part of [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "manifest-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ]) {
      assert.ok(csp.includes(part), part);
    }
    const scripts = a.body.match(/<script\b[^>]*>/g) ?? [];
    assert.ok(scripts.length >= 2);
    for (const tag of scripts) assert.ok(tag.includes("src=") || tag.includes(`nonce="${nonce}"`), tag);
    assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(a.body));
    assert.ok(!a.body.includes("__NONCE__"));
    for (const path of ["/", "/state", "/manifest.webmanifest", "/dashboard.js", "/nope"]) {
      const res = await request(r.port, "GET", path);
      assert.equal(res.headers["x-content-type-options"], "nosniff", path);
      assert.equal(res.headers["referrer-policy"], "no-referrer", path);
      assert.equal(res.headers["x-frame-options"], "DENY", path);
      assert.ok(String(res.headers["content-security-policy"]).includes("script-src 'self' 'nonce-"), path);
    }
    for (const path of ["/", "/state"]) {
      assert.equal((await request(r.port, "GET", path)).headers["cache-control"], "no-store", path);
    }
    const posted = await post(r, "/api/panic", { on: false });
    assert.equal(posted.headers["cache-control"], "no-store");
    const sse = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      const req = http.get(r.base + "/events", { agent: false }, (res) => {
        resolve(res.headers);
        req.destroy();
      });
      req.on("error", (e) => {
        if (!req.destroyed) reject(e);
      });
    });
    assert.equal(sse["cache-control"], "no-store");
    assert.equal(sse["x-content-type-options"], "nosniff");
  } finally {
    await r.close();
  }
});

test("the shipped dashboard page has exactly one inline script and no inline handlers", () => {
  const html = readFileSync(join(staticDir, "index.html"), "utf8");
  const inline = html.match(/<script\b(?![^>]*\bsrc=)[^>]*>/g) ?? [];
  assert.equal(inline.length, 1);
  assert.ok(inline[0]!.includes('nonce="__NONCE__"'));
  assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(html));
  assert.ok(!/javascript:/i.test(html));
});

test("telemetry is serialised once per change and shared by every stream client", async () => {
  const r = await rig();
  const fixed = { ...r.engine.snapshot(), uptime: 111 };
  let calls = 0;
  r.engine.snapshot = () => {
    calls += 1;
    return fixed;
  };
  const a = sseCollector(r.port);
  const b = sseCollector(r.port);
  const { client } = await WsClient.connect(r.port);
  try {
    assert.equal((await client.read()).toString("utf8"), JSON.stringify(fixed));
    await sleep(550);
    assert.equal(a.chunks.length, 1);
    assert.equal(b.chunks.length, 1);
    assert.equal(a.chunks[0], `data: ${JSON.stringify(fixed)}\n\n`);
    assert.equal(a.chunks[0], b.chunks[0]);
    assert.ok(calls <= 11, "snapshot called " + String(calls) + " times");
    const next = { ...fixed, uptime: 222 };
    r.engine.snapshot = () => next;
    await sleep(300);
    assert.equal(a.chunks.length, 2);
    assert.equal(a.chunks[1], b.chunks[1]);
    assert.equal(JSON.parse((await client.read()).toString("utf8")).uptime, 222);
  } finally {
    a.req.destroy();
    b.req.destroy();
    client.destroy();
    await r.close();
  }
});

test("state is plain JSON text", async () => {
  const r = await rig();
  try {
    const res = await request(r.port, "GET", "/state");
    assert.equal(res.body, JSON.stringify(r.engine.snapshot()));
  } finally {
    await r.close();
  }
});

test("an idle event stream outlives the request timeout", { timeout: 30000 }, async () => {
  const r = await rig();
  const sse = sseCollector(r.port);
  try {
    await sleep(10700);
    assert.ok(sse.chunks.length >= 2, "keepalive frames expected, got " + String(sse.chunks.length));
    assert.equal(r.srv.streamsInUse, 1);
  } finally {
    sse.req.destroy();
    await r.close();
  }
});

test("connections beyond the cap are refused", async () => {
  const r = await rig();
  const socks: net.Socket[] = [];
  let closed = 0;
  try {
    for (let i = 0; i < 129; i++) {
      const s = net.createConnection({ host: "127.0.0.1", port: r.port });
      s.on("error", () => undefined);
      s.on("close", () => {
        closed += 1;
      });
      socks.push(s);
      await new Promise<void>((resolve) => {
        s.once("connect", () => resolve());
        s.once("error", () => resolve());
      });
    }
    await sleep(400);
    assert.equal(closed, 1);
  } finally {
    for (const s of socks) s.destroy();
    await r.close();
  }
});

test("a chunked POST is refused with 411", async () => {
  const r = await rig();
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const s = net.createConnection({ host: "127.0.0.1", port: r.port });
      let text = "";
      s.setEncoding("latin1");
      s.on("data", (c: string) => (text += c));
      s.on("close", () => resolve(text));
      s.on("error", reject);
      s.write(
        `POST /api/panic HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nTransfer-Encoding: chunked\r\n\r\n` +
          'b\r\n{"on":true}\r\n0\r\n\r\n',
      );
    });
    assert.ok(reply.startsWith("HTTP/1.1 411"), reply.slice(0, 40));
    assert.equal((await getJson(r, "/state")).status, "live");
  } finally {
    await r.close();
  }
});

test("only the exact index paths serve the dashboard", async () => {
  const r = await rig();
  try {
    assert.equal((await request(r.port, "GET", "/index.html")).status, 200);
    assert.equal((await request(r.port, "GET", "/indexXYZ")).status, 404);
    assert.equal((await request(r.port, "GET", "/index")).status, 404);
  } finally {
    await r.close();
  }
});

test("listening beyond loopback needs a PIN unless an open dashboard is allowed explicitly", async () => {
  const engine = new TestEngine({ clock: new ManualClock(100, 1_700_000_000), sim: true });
  try {
    const open = createServer({ engine, staticDir });
    await assert.rejects(open.start(0, "0.0.0.0"), /without a PIN/);
    await assert.rejects(open.start(0, "::"), /without a PIN/);
    const local = createServer({ engine, staticDir });
    assert.ok((await local.start(0, "127.0.0.1")).port > 0);
    await local.stop();
    const allowed = createServer({ engine, staticDir, allowOpen: true });
    assert.ok((await allowed.start(0, "0.0.0.0")).port > 0);
    await allowed.stop();
    const pinned = createServer({ engine, staticDir, pin: "135246" });
    assert.ok((await pinned.start(0, "0.0.0.0")).port > 0);
    await pinned.stop();
    assert.throws(() => createServer({ engine, staticDir, pin: "12345" }), /at least 6/);
    assert.ok(createServer({ engine, staticDir, pin: "123456" }));
  } finally {
    await engine.stop();
  }
});

test("https serves the dashboard to a modern client and refuses RSA key exchange", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mix_https_"));
  const [certfile, keyfile] = ensureCert(dir, ["localhost", "127.0.0.1"]);
  const cert = readFileSync(certfile, "utf8");
  const r = await rig({ tls: { key: readFileSync(keyfile, "utf8"), cert } });
  try {
    const body = await new Promise<string>((resolve, reject) => {
      https
        .get({ host: "127.0.0.1", port: r.port, path: "/state", ca: cert, agent: false }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        })
        .on("error", reject);
    });
    assert.equal(JSON.parse(body).channels.length, 8);
    const negotiate = (opts: tls.ConnectionOptions): Promise<string> =>
      new Promise((resolve) => {
        const c = tls.connect({ host: "127.0.0.1", port: r.port, rejectUnauthorized: false, ...opts }, () => {
          const name = c.getCipher().name;
          c.destroy();
          resolve(name);
        });
        c.on("error", (e) => resolve("error:" + e.message));
      });
    assert.match(await negotiate({ ciphers: "ECDHE-RSA-AES128-GCM-SHA256", maxVersion: "TLSv1.2" }), /ECDHE/);
    assert.match(await negotiate({ ciphers: "AES128-GCM-SHA256", maxVersion: "TLSv1.2" }), /^error:/);
    assert.match(await negotiate({ ciphers: "AES128-SHA", maxVersion: "TLSv1.2" }), /^error:/);
  } finally {
    await r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the shipped dashboard reloads on an expired session, reports bad frames and does not double-escape text", () => {
  const js = readFileSync(join(staticDir, "dashboard.js"), "utf8");
  const norm = js.replace(/\s+/g, " ");
  assert.match(norm, /status === 401\) location\.reload\(\)/);
  assert.match(norm, /console\.warn\("dashboard: dropped an unreadable telemetry frame"/);
  assert.match(norm, /catch \(e\) \{ badFrame\(e\)/);
  assert.ok(!/esc\(String\(cap\.name\)/.test(js));
});
