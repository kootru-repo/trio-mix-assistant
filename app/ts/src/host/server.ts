import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { truthy } from "../core/engine/base.ts";
import type { Engine } from "../core/engine/index.ts";
import { ICON_SVG, LOGIN_HTML, MANIFEST } from "./server/assets.ts";
import { hostAllowed, originAllowed, safeEqual } from "./server/guards.ts";
import { decodeUtf8, jsonForHtml, pyJson, pyStr, strictLoads } from "./server/json.ts";
import { LoginLimiter } from "./server/limiter.ts";
import { WS_MAX_FRAME, WsParser, wsAccept, wsFrame } from "./server/ws.ts";

export { hostAllowed, originAllowed } from "./server/guards.ts";
export { LoginLimiter } from "./server/limiter.ts";
export { jsonForHtml, pyJson, strictLoads } from "./server/json.ts";

const MAX_BODY = 1 << 16;
const MAX_DRAIN = 1 << 18;
const MAX_STREAMS = 32;
const SOCK_TIMEOUT_MS = 20000;
const HANDLER_TIMEOUT_MS = 15000;
const STREAM_INTERVAL_MS = 100;
const MAX_BACKLOG = 1 << 20;

const STATIC_JS: Record<string, string> = { "/dashboard.js": "dashboard.js", "/login.js": "login.js" };

export interface ServerOptions {
  engine: Engine;
  staticDir: string;
  pin?: string | null;
  caPem?: string | null;
  tls?: { key: string | Buffer; cert: string | Buffer } | null;
  limiter?: LoginLimiter;
}

export interface DashboardServer {
  start(port: number, host: string): Promise<{ port: number }>;
  stop(): Promise<void>;
  readonly limiter: LoginLimiter;
  readonly streamsInUse: number;
}

type Body = Record<string, unknown>;

const isRecord = (v: unknown): v is Body => typeof v === "object" && v !== null && !Array.isArray(v);

const errorBody = (code: number): string => {
  const msg = http.STATUS_CODES[code] ?? "Error";
  return (
    `<!DOCTYPE HTML>\n<html lang="en">\n    <head>\n        <meta charset="utf-8">\n        <title>Error response</title>\n    </head>\n` +
    `    <body>\n        <h1>Error response</h1>\n        <p>Error code: ${code}</p>\n        <p>Message: ${msg}.</p>\n    </body>\n</html>\n`
  );
};

const sendError = (res: ServerResponse, code: number): void => {
  const body = Buffer.from(errorBody(code), "utf8");
  res.writeHead(code, {
    Connection: "close",
    "Content-Type": "text/html;charset=utf-8",
    "Content-Length": String(body.length),
  });
  res.end(body);
};

const rawError = (socket: Socket, code: number): void => {
  const body = Buffer.from(errorBody(code), "utf8");
  const head =
    `HTTP/1.1 ${code} ${http.STATUS_CODES[code] ?? "Error"}\r\nConnection: close\r\n` +
    `Content-Type: text/html;charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n`;
  socket.end(Buffer.concat([Buffer.from(head, "latin1"), body]));
};

const sendText = (res: ServerResponse, text: string, ctype: string, extra: Record<string, string> = {}): void => {
  const body = Buffer.from(text, "utf8");
  res.writeHead(200, { "Content-Type": ctype, "Content-Length": String(body.length), ...extra });
  res.end(body);
};

const sendJson = (res: ServerResponse, obj: unknown, code: number = 200, extra: Record<string, string> = {}): void => {
  const body = Buffer.from(pyJson(obj), "utf8");
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": String(body.length), ...extra });
  res.end(body);
};

const pathOf = (url: string | undefined): string => (url ?? "").split("?", 1)[0]!.split("#", 1)[0]!;

const headerOf = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(", ") : v;
};

const readBody = (req: IncomingMessage): Promise<Body> =>
  new Promise((resolve, reject) => {
    const raw = headerOf(req, "content-length") ?? "0";
    if (raw.trim() !== "" && !/^\s*[+-]?\d+\s*$/.test(raw)) {
      reject(new RangeError("bad Content-Length"));
      return;
    }
    const n = raw.trim() === "" ? 0 : Number(raw);
    if (n < 0) {
      reject(new RangeError("bad Content-Length"));
      return;
    }
    if (n === 0) {
      resolve({});
      return;
    }
    if (n > MAX_DRAIN) {
      reject(new RangeError("request body too large"));
      return;
    }
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on("data", (c: Buffer) => {
      if (n <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () =>
      settle(() => {
        if (n > MAX_BODY) {
          reject(new RangeError("request body too large"));
          return;
        }
        try {
          const obj = strictLoads(decodeUtf8(Buffer.concat(chunks)));
          resolve(isRecord(obj) ? obj : {});
        } catch (e) {
          reject(e);
        }
      }),
    );
    req.on("error", (e) => settle(() => reject(e)));
    req.on("close", () => settle(() => reject(new Error("connection closed"))));
  });

const isBadMessage = (e: unknown): boolean =>
  e instanceof TypeError || e instanceof RangeError || e instanceof SyntaxError;

export function createServer(opts: ServerOptions): DashboardServer {
  const { engine, staticDir } = opts;
  const pin = opts.pin !== undefined && opts.pin !== null && String(opts.pin) !== "" ? String(opts.pin) : null;
  const token = pin !== null ? randomBytes(32).toString("base64url") : null;
  const caPem = opts.caPem ?? null;
  const limiter = opts.limiter ?? new LoginLimiter();
  let streams = 0;
  const sockets = new Set<Socket>();

  const readStatic = (name: string): string => readFileSync(join(staticDir, name), "utf8");

  const authed = (req: IncomingMessage): boolean => {
    if (pin === null) return true;
    for (const part of (headerOf(req, "cookie") ?? "").split(";")) {
      const p = part.trim();
      const eq = p.indexOf("=");
      const k = eq < 0 ? p : p.slice(0, eq);
      const v = eq < 0 ? "" : p.slice(eq + 1);
      if (k === "mixauth") return safeEqual(v, token ?? "");
    }
    return false;
  };

  const hostOk = (req: IncomingMessage): boolean => hostAllowed(headerOf(req, "host"));
  const originOk = (req: IncomingMessage): boolean =>
    originAllowed(headerOf(req, "origin") ?? null, headerOf(req, "host"));

  const serveSse = (res: ServerResponse, socket: Socket): void => {
    if (streams >= MAX_STREAMS) {
      sendError(res, 503);
      return;
    }
    streams += 1;
    let timer: NodeJS.Timeout | null = null;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      if (timer !== null) clearInterval(timer);
      streams -= 1;
    };
    res.on("close", release);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    socket.setTimeout(SOCK_TIMEOUT_MS);
    socket.once("timeout", () => socket.destroy());
    const push = (): void => {
      if (res.writableLength > MAX_BACKLOG) {
        socket.destroy();
        return;
      }
      res.write(`data: ${pyJson(engine.snapshot())}\n\n`);
    };
    push();
    timer = setInterval(push, STREAM_INTERVAL_MS);
  };

  const serveWs = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    if (!hostOk(req) || !originOk(req)) return rawError(socket, 403);
    if (!authed(req)) return rawError(socket, 401);
    const key = headerOf(req, "sec-websocket-key");
    if (key === undefined || key === "") return rawError(socket, 400);
    if (streams >= MAX_STREAMS) return rawError(socket, 503);
    streams += 1;
    let released = false;
    let done = false;
    let timer: NodeJS.Timeout | null = null;
    const release = (): void => {
      if (released) return;
      released = true;
      if (timer !== null) clearInterval(timer);
      streams -= 1;
    };
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer !== null) clearInterval(timer);
      socket.end();
      setTimeout(() => socket.destroy(), 2000).unref();
    };
    socket.on("close", release);
    socket.on("error", () => {
      done = true;
      release();
    });
    socket.setTimeout(SOCK_TIMEOUT_MS);
    socket.once("timeout", () => socket.destroy());
    socket.setNoDelay(true);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
    );
    const send = (data: string | Buffer, opcode: number = 0x1): void => {
      if (done) return;
      if (socket.writableLength > MAX_BACKLOG) {
        finish();
        return;
      }
      socket.write(wsFrame(data, opcode));
    };
    const parser = new WsParser();
    let frag: Buffer = Buffer.alloc(0);
    let fragOp: number | null = null;
    const onFrame = (fin: boolean, opcode: number, payload: Buffer): boolean => {
      if (opcode === 0x8) return false;
      if (opcode === 0x9) {
        send(payload, 0xa);
        return true;
      }
      if (opcode === 0xa) return true;
      if (opcode === 0x0) {
        if (fragOp === null) return false;
        frag = Buffer.concat([frag, payload]);
      } else if (opcode === 0x1 || opcode === 0x2) {
        frag = Buffer.from(payload);
        fragOp = opcode;
      } else return true;
      if (frag.length > WS_MAX_FRAME) return false;
      if (fin && fragOp !== null) {
        const data = frag;
        const op = fragOp;
        frag = Buffer.alloc(0);
        fragOp = null;
        if (op === 0x1 && data.length > 0) {
          try {
            engine.command(strictLoads(decodeUtf8(data)));
          } catch (e) {
            if (!isBadMessage(e)) return false;
          }
        }
      }
      return true;
    };
    const onData = (chunk: Buffer): void => {
      if (done) return;
      parser.push(chunk);
      for (;;) {
        const f = parser.next();
        if (f === null) return;
        if (f === "bad" || !onFrame(f.fin, f.opcode, f.payload)) {
          finish();
          return;
        }
      }
    };
    socket.on("data", onData);
    send(pyJson(engine.snapshot()));
    timer = setInterval(() => send(pyJson(engine.snapshot())), STREAM_INTERVAL_MS);
    if (head.length > 0) onData(head);
  };

  const doLogin = (req: IncomingMessage, res: ServerResponse): void => {
    const addr = String(req.socket.remoteAddress ?? "");
    if (!limiter.admit(addr)) {
      sendError(res, 429);
      return;
    }
    readBody(req).then(
      async (body) => {
        const ok = pin !== null && safeEqual(pyStr(body["pin"] ?? ""), pin);
        if (!ok) {
          await new Promise((r) => setTimeout(r, limiter.delayS * 1000));
          sendJson(res, { ok: false }, 401);
          return;
        }
        limiter.success(addr);
        let cookie = `mixauth=${token}; HttpOnly; SameSite=Strict; Path=/`;
        if ((req.socket as TLSSocket).encrypted === true) cookie += "; Secure";
        sendJson(res, { ok: true }, 200, { "Set-Cookie": cookie });
      },
      () => sendError(res, 400),
    );
  };

  const doGet = (req: IncomingMessage, res: ServerResponse): void => {
    if (!hostOk(req)) return sendError(res, 403);
    const path = pathOf(req.url);
    if (path === "/" || path.startsWith("/index")) {
      if (!authed(req)) return sendText(res, LOGIN_HTML, "text/html; charset=utf-8");
      const html = readStatic("index.html").split("__INITIAL_STATE__").join(jsonForHtml(engine.snapshot()));
      sendText(res, html, "text/html; charset=utf-8");
    } else if (path === "/state") {
      if (!authed(req)) return sendError(res, 401);
      sendJson(res, engine.snapshot());
    } else if (path === "/events") {
      if (!authed(req)) return sendError(res, 401);
      serveSse(res, req.socket);
    } else if (path === "/ws") {
      if (!originOk(req)) return sendError(res, 403);
      if (!authed(req)) return sendError(res, 401);
      sendError(res, 400);
    } else if (path === "/manifest.webmanifest") {
      sendText(res, MANIFEST, "application/manifest+json");
    } else if (path === "/icon.svg" || path === "/favicon.ico") {
      sendText(res, ICON_SVG, "image/svg+xml");
    } else if (Object.hasOwn(STATIC_JS, path)) {
      sendText(res, readStatic(STATIC_JS[path]!), "text/javascript; charset=utf-8", { "Cache-Control": "no-cache" });
    } else if ((path === "/ca.pem" || path === "/ca.crt") && caPem !== null && caPem !== "") {
      sendText(res, caPem, "application/x-x509-ca-cert", {
        "Content-Disposition": 'attachment; filename="MixAssistant-CA.pem"',
      });
    } else sendError(res, 404);
  };

  const control = (url: string, body: Body): boolean => {
    if (url === "/api/toggle") engine.setEnabled(pyStr(body["job"]), truthy(body["on"]));
    else if (url === "/api/panic") engine.panic(truthy(body["on"]));
    else if (url === "/api/calibrate") engine.runCalibration();
    else if (url === "/api/lead_target") {
      engine.setLeadTarget(Object.hasOwn(body, "db") ? body["db"] : engine.assistant.leadTarget);
    } else if (url === "/api/reset_notches") engine.resetNotches();
    else if (url === "/api/balance_capture") engine.captureBalanceNow();
    else if (url === "/api/scene") engine.recallSceneManual(body["index"] ?? null);
    else if (url === "/api/command") engine.command(body);
    else return false;
    return true;
  };

  const doPost = (req: IncomingMessage, res: ServerResponse): void => {
    if (!hostOk(req) || !originOk(req)) return sendError(res, 403);
    const url = req.url ?? "";
    if (url === "/api/login") return doLogin(req, res);
    if (!authed(req)) return sendError(res, 401);
    readBody(req).then(
      (body) => {
        try {
          if (!control(url, body)) return sendError(res, 404);
        } catch (e) {
          return sendError(res, isBadMessage(e) ? 400 : 500);
        }
        sendJson(res, engine.snapshot());
      },
      () => sendError(res, 400),
    );
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    try {
      if (req.method === "GET") doGet(req, res);
      else if (req.method === "POST") doPost(req, res);
      else sendError(res, 501);
    } catch {
      if (res.headersSent) res.socket?.destroy();
      else sendError(res, 500);
    }
  };

  const serverOpts = {
    requireHostHeader: false,
    keepAliveTimeout: HANDLER_TIMEOUT_MS,
    headersTimeout: HANDLER_TIMEOUT_MS,
    requestTimeout: 0,
  };
  const server: http.Server =
    opts.tls !== undefined && opts.tls !== null
      ? https.createServer({ ...serverOpts, key: opts.tls.key, cert: opts.tls.cert }, handle)
      : http.createServer(serverOpts, handle);
  server.timeout = HANDLER_TIMEOUT_MS;
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => undefined);
  });
  server.on("tlsClientError", () => undefined);
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    try {
      if (req.method === "GET" && pathOf(req.url) === "/ws") {
        serveWs(req, socket, head);
        return;
      }
      const res = new http.ServerResponse(req);
      res.assignSocket(socket);
      res.shouldKeepAlive = false;
      res.on("finish", () => socket.end());
      handle(req, res);
    } catch {
      socket.destroy();
    }
  });

  return {
    limiter,
    get streamsInUse(): number {
      return streams;
    },
    start(port: number, host: string): Promise<{ port: number }> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve({ port: (server.address() as AddressInfo).port });
        });
      });
    },
    stop(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
      });
    },
  };
}
