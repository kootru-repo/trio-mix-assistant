import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { isIP } from "node:net";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Calibrator } from "../core/calibration.ts";
import type { Clock } from "../core/clock.ts";
import { copyConfig } from "../core/config.ts";
import type { Config } from "../core/config.ts";
import { SimConsole, dbToFader } from "../core/console.ts";
import { makeScrubber, redact } from "../core/diagnostics.ts";
import { listAudioDevices } from "../core/devicecapture.ts";
import { generatePinkNoise } from "../core/dsp.ts";
import { EmulatedDesk } from "../core/emulator.ts";
import { Engine } from "../core/engine/index.ts";
import { MeterReceiver } from "../core/metersrv.ts";
import { decodeReply, encodeMessage, oscStr } from "../core/oscwire.ts";
import { SeededRng } from "../core/rng.ts";
import { AbleSetReceiver } from "../core/showclock.ts";
import type { ShowState } from "../core/showclock.ts";
import { fromObject } from "../core/template.ts";
import type { Peer } from "../core/transport.ts";
import { tuningLines } from "../core/tuning.ts";
import { buildModel } from "../core/venue.ts";
import {
  Desk,
  VetFailure,
  VetLog,
  VetSkip,
  measureSound,
  must,
  operatorLines,
  skipRow,
  soundVerdict,
  step,
  summaryLines,
  tableLines,
  traceLines,
  vetConsole,
  vetSequence,
} from "../core/vet.ts";
import type { VetControl, VetHostPort, VetRequest, VetSummary } from "../core/ports.ts";
import type { SoundSource, StepSpec, VetProof, VetRow } from "../core/vet.ts";
import { parseCliArgs } from "./args.ts";
import type { Args } from "./args.ts";
import { OPEN_WAIT_S, moduleFacts, systemFacts, within } from "./diagnose.ts";
import { buildArgv, readConf } from "./launcher.ts";
import type { Io } from "./main.ts";
import { OpenDashboardRefused, createServer } from "./server.ts";
import type { DashboardServer } from "./server.ts";
import { LoginLimiter } from "./server/limiter.ts";
import { SessionLog } from "./sessionlog.ts";
import { allLanIps, ensureCert, ensureTrustedCert, tlsHosts } from "./tls.ts";
import { VenueStore } from "./venuestore.ts";

export const PHONE_WAIT_S = 120;
const HTTP_TIMEOUT_MS = 5000;

export interface VetAudio extends SoundSource {
  start(): void;
  ready(): Promise<void>;
  stop(): void;
  settled(): Promise<void>;
}

export interface LiveConsole {
  rx: MeterReceiver;
  ip: string;
  port: number;
}

export interface VetHooks {
  live?: LiveConsole | null;
  control?: VetControl | null;
  openSource: (() => VetAudio) | null;
  lanIp: () => Promise<string | null>;
  phoneSeconds?: number;
  localPort?: number;
  cfg: Config;
}

interface Ctx {
  args: Args;
  io: Io;
  hooks: VetHooks;
  rows: VetRow[];
  log: VetLog;
  clock: Clock;
  stopped: () => boolean;
  cfg: Config;
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Target {
  port: number;
  secure: boolean;
  ca: string | null;
}

interface RequestOptions {
  cookie?: string;
  json?: unknown;
  origin?: string;
}

function request(log: VetLog, target: Target, method: string, path: string, opts: RequestOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = opts.json === undefined ? null : Buffer.from(JSON.stringify(opts.json), "utf8");
    const headers: Record<string, string> = {};
    if (opts.cookie) headers["Cookie"] = opts.cookie;
    if (opts.origin) headers["Origin"] = opts.origin;
    if (body !== null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(body.length);
    }
    const base = { host: "127.0.0.1", port: target.port, method, path, headers, agent: false, timeout: HTTP_TIMEOUT_MS };
    const onReply = (res: http.IncomingMessage): void => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        log.note(`http ${method} ${path} → ${status}`);
        resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", reject);
    };
    const req = target.secure
      ? https.request({ ...base, ...(target.ca === null ? {} : { ca: target.ca }) }, onReply)
      : http.request(base, onReply);
    req.on("timeout", () => req.destroy(new Error(`${method} ${path} timed out`)));
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

function firstEvent(target: Target, cookie: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: target.port,
        method: "GET",
        path: "/events",
        headers: { Cookie: cookie },
        agent: false,
        timeout: HTTP_TIMEOUT_MS,
      },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => {
          text += c.toString("utf8");
          if (text.includes("\n\n")) {
            req.destroy();
            resolve(text);
          }
        });
        res.on("error", () => undefined);
      },
    );
    req.on("timeout", () => req.destroy(new Error("no event arrived")));
    req.on("error", (e) => reject(e));
    req.end();
  });
}

function socketExchange(target: Target, cookie: string, command: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(target.port, "127.0.0.1");
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("the live connection did not open in time"));
    }, HTTP_TIMEOUT_MS);
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.on("connect", () => {
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\nCookie: ${cookie}\r\n\r\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buf.subarray(0, end).toString("latin1");
        if (!head.startsWith("HTTP/1.1 101")) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(`the live connection was refused: ${head.split("\r\n")[0]}`));
          return;
        }
        upgraded = true;
        buf = buf.subarray(end + 4);
      }
      if (buf.length < 4) return;
      const payload = Buffer.from(JSON.stringify(command), "utf8");
      const mask = randomBytes(4);
      const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
      socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
      clearTimeout(timer);
      const opcode = buf[0]! & 0x0f;
      setTimeout(() => {
        socket.destroy();
        resolve(opcode === 1 ? "text" : `opcode ${opcode}`);
      }, 150);
    });
  });
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const HERE = "This computer";

const local = (ctx: Ctx, id: string, area: string, title: string, covers: string[], body: () => Promise<string>): Promise<void> =>
  step(ctx.rows, ctx.log, { id, area, title, proof: "this computer", covers }, async () => {
    if (ctx.stopped()) throw new VetSkip("stopped before this step ran");
    return body();
  });

async function thisComputer(ctx: Ctx): Promise<void> {
  const { io } = ctx;
  await local(ctx, "sys_audio_module", HERE, "Audio module loads", ["feature:audio-module"], async () => {
    const m = moduleFacts(io.factory);
    must(m.ok, `the audio module did not load: ${m.error ?? "unknown error"}`);
    return `${m.inputs} input device${m.inputs === 1 ? "" : "s"} found`;
  });
  await local(ctx, "conf_show", HERE, "show.conf is read without errors", ["feature:show-conf"], async () => {
    const notes: string[] = [];
    const cfg = readConf(join(io.layout.appDir, "show.conf"));
    const plan = buildArgv(cfg, io.layout.appDir, false, (l) => notes.push(l));
    parseCliArgs(plan.argv);
    parseCliArgs(buildArgv(cfg, io.layout.appDir, true).argv);
    const warned = notes.filter((n) => n.includes("[!]")).length;
    return (
      `mode ${plan.mode}, dashboard port ${plan.port}` + (warned ? `, ${warned} warning${warned === 1 ? "" : "s"} when it starts` : "")
    );
  });
  await local(ctx, "conf_templates", HERE, "Show templates load", ["feature:templates"], async () => {
    const dir = join(io.layout.appDir, "templates");
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".json"));
    } catch {
      throw new VetSkip("there is no templates folder beside show.conf");
    }
    const bad: string[] = [];
    for (const n of names) {
      try {
        fromObject(JSON.parse(readFileSync(join(dir, n), "utf8")), ctx.cfg);
      } catch (e) {
        bad.push(`${n}: ${errText(e)}`);
      }
    }
    must(bad.length === 0, bad.join("; "));
    return `${names.length} template${names.length === 1 ? "" : "s"} loaded`;
  });
  await local(ctx, "sys_session_log", HERE, "Session log and venue model", ["feature:session-log", "feature:venue-model"], async () => {
    const dir = mkdtempSync(join(tmpdir(), "trio-vet-"));
    let slog: SessionLog | null = null;
    try {
      slog = new SessionLog(join(dir, "sessions.db"));
      slog.startSession("Vet Venue", "vet", "vet");
      slog.logEvent({ time: ctx.clock.hhmmss(), kind: "feedback", ch: 4, role: "acoustic_gtr", msg: "2500 Hz on ch 4 → notch band 1" });
      await slog.flush();
      must(slog.recent(1).length === 1, "an event written to the log could not be read back");
      const store = new VenueStore(join(dir, "venues"));
      store.save(buildModel(slog, "Vet Venue", ctx.clock.time()));
      const back = store.load("Vet Venue");
      must(back !== null && back.feedback_freqs.some((f) => f.hz === 2500), "the venue model did not keep the feedback frequency");
      return "an event was stored and read back, and a venue model was built, saved and loaded";
    } finally {
      if (slog !== null) slog.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

interface Link {
  desk: Desk;
  rx: MeterReceiver;
}

async function link(
  ctx: Ctx,
  listenIp: string,
  port: number,
  allowFrom: string | null,
  proof: VetProof,
  reach: (localPort: number) => Promise<Peer>,
): Promise<Link> {
  const rx = new MeterReceiver(ctx.io.udp, { ip: listenIp, port, allowFrom, cfg: ctx.cfg });
  await rx.start();
  let target: Peer;
  try {
    target = await reach(rx.port);
  } catch (e) {
    rx.stop();
    throw e;
  }
  const desk = new Desk({
    transmit: (data) => rx.send(data, target),
    clock: ctx.clock,
    log: ctx.log,
    proof,
    stopped: ctx.stopped,
    cfg: ctx.cfg,
  });
  rx.onMessage = (addr, args) => desk.receive(addr, args);
  return { desk, rx };
}

const EMU = "Built-in emulator";
const WEB = "Dashboard";

async function emulatorExtras(ctx: Ctx, emu: EmulatedDesk): Promise<void> {
  const spec = (id: string, title: string, covers: string[]): StepSpec => ({ id, area: EMU, title, proof: "this computer", covers });
  await step(
    ctx.rows,
    ctx.log,
    spec("emu_editor", "The emulator answers a mixer app's questions", ["feature:emulator-editor"]),
    async () => {
      const ep = await ctx.io.udp.bind(0, "127.0.0.1");
      const seen = new Set<string>();
      ep.onMessage((data) => {
        const m = decodeReply(data);
        if (m === null) return;
        seen.add(m.address);
        ctx.log.note(`recv (mixer-app socket) ${m.address}`);
      });
      try {
        const to = { host: "127.0.0.1", port: emu.listenPort };
        for (const addr of ["/info", "/xinfo", "/status", "/ch/01/config/name"]) {
          ctx.log.note(`send (mixer-app socket) ${addr}`);
          ep.send(encodeMessage(addr, []), to);
        }
        ctx.log.note("send (mixer-app socket) /node ch/01/config");
        ep.send(encodeMessage("/node", [oscStr("ch/01/config")]), to);
        const t0 = ctx.clock.monotonic();
        while (seen.size < 5 && ctx.clock.monotonic() - t0 < 1) await ctx.clock.sleep(0.02);
        for (const addr of ["/info", "/xinfo", "/status", "/ch/01/config/name", "node"]) must(seen.has(addr), `no answer to ${addr}`);
        return "identity, status, a channel name and a node request were all answered";
      } finally {
        ep.close();
      }
    },
  );
  await step(ctx.rows, ctx.log, spec("show_ableset", "An AbleSet song message is received", ["feature:ableset"]), async () => {
    const probe = await ctx.io.udp.bind(0, "127.0.0.1");
    const port = probe.port;
    probe.close();
    let got: ShowState | null = null;
    const rx = new AbleSetReceiver(
      ctx.io.udp,
      ctx.cfg,
      (s) => {
        got = s;
      },
      "127.0.0.1",
      port,
    );
    await rx.start();
    const ep = await ctx.io.udp.bind(0, "127.0.0.1");
    try {
      ep.send(encodeMessage("/setlist/activeSongName", [oscStr("Vet Song A")]), { host: "127.0.0.1", port });
      const t0 = ctx.clock.monotonic();
      while (got === null && ctx.clock.monotonic() - t0 < 1) await ctx.clock.sleep(0.02);
      const state = got as ShowState | null;
      must(state !== null && state.songName === "Vet Song A", "the song name sent over the network did not arrive");
      return "a song name sent over the network on this computer arrived";
    } finally {
      ep.close();
      rx.stop();
    }
  });
}

const cookieOf = (r: Reply): string => {
  const raw = r.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first ? first.split(";", 1)[0]! : "";
};

async function withServer<T>(
  opts: Parameters<typeof createServer>[0],
  secure: boolean,
  ca: string | null,
  body: (t: Target, s: DashboardServer) => Promise<T>,
): Promise<T> {
  const server = createServer(opts);
  const { port } = await server.start(0, "127.0.0.1");
  try {
    return await body({ port, secure, ca }, server);
  } finally {
    await server.stop();
  }
}

async function dashboard(ctx: Ctx, desk: Desk): Promise<void> {
  const { io, log } = ctx;
  const engine = new Engine({ console: desk.con, sim: false, source: null, tick: 0.02, clock: ctx.clock, cfg: ctx.cfg });
  const pin = randomBytes(6).toString("hex");
  const staticDir = io.layout.staticDir;
  const main = `/${ctx.cfg.MAIN_BUS}`;
  const W = (id: string, title: string, covers: string[], body: () => Promise<string>): Promise<void> =>
    local(ctx, id, WEB, title, covers, body);
  await withServer({ engine, staticDir, pin }, false, null, async (t) => {
    let cookie = "";
    await W("web_login_page", "Without the PIN the login page is shown", ["route:/", "route:/login.js"], async () => {
      const page = await request(log, t, "GET", "/");
      must(page.status === 200 && page.body.includes("/login.js"), `expected the login page, got status ${page.status}`);
      must(!page.body.includes("dashboard.js"), "the dashboard was served without the PIN");
      must((await request(log, t, "GET", "/login.js")).status === 200, "the login script was not served");
      return "the login page was served, not the dashboard";
    });
    await W("web_auth_required", "Without the PIN the state, live updates and commands are refused", ["feature:pin-required"], async () => {
      for (const [method, path] of [
        ["GET", "/state"],
        ["GET", "/events"],
        ["POST", "/api/toggle"],
        ["POST", "/api/command"],
      ] as const) {
        const r = await request(log, t, method, path, method === "POST" ? { json: {} } : {});
        must(r.status === 401, `${method} ${path} answered ${r.status}, expected 401`);
      }
      return "state, live updates and commands were all refused";
    });
    await W("web_login", "A wrong PIN is refused and the right PIN signs in", ["route:/api/login"], async () => {
      const wrong = await request(log, t, "POST", "/api/login", { json: { pin: "not-the-pin" } });
      must(wrong.status === 401, `a wrong PIN answered ${wrong.status}, expected 401`);
      const right = await request(log, t, "POST", "/api/login", { json: { pin } });
      cookie = cookieOf(right);
      must(right.status === 200 && cookie.startsWith("mixauth="), `the right PIN answered ${right.status}`);
      return "wrong PIN refused; right PIN accepted";
    });
    await W(
      "web_pages",
      "The dashboard page and its files are served",
      ["route:/index.html", "route:/dashboard.js", "route:/manifest.webmanifest", "route:/icon.svg", "route:/favicon.ico"],
      async () => {
        must(cookie !== "", "sign-in did not work, so this could not be checked");
        for (const path of ["/", "/index.html"]) {
          const page = await request(log, t, "GET", path, { cookie });
          must(page.status === 200 && page.body.includes("dashboard.js"), `${path} did not serve the dashboard (status ${page.status})`);
          must(
            !page.body.includes("__INITIAL_STATE__") && !page.body.includes("__NONCE__"),
            `${path} was served with unfilled placeholders`,
          );
        }
        for (const path of ["/dashboard.js", "/manifest.webmanifest", "/icon.svg", "/favicon.ico"]) {
          must((await request(log, t, "GET", path, { cookie })).status === 200, `${path} was not served`);
        }
        must((await request(log, t, "GET", "/nope", { cookie })).status === 404, "an unknown page did not answer 404");
        return "the page, its script, the app manifest and the icon were served";
      },
    );
    await W("web_state", "The state snapshot is served", ["route:/state"], async () => {
      const r = await request(log, t, "GET", "/state", { cookie });
      const state: unknown = r.status === 200 ? JSON.parse(r.body) : null;
      must(typeof state === "object" && state !== null && "channels" in state, `no usable state (status ${r.status})`);
      return "a snapshot with the channel list was returned";
    });
    await W("web_events", "Live updates stream to the page", ["route:/events"], async () => {
      const text = await firstEvent(t, cookie);
      must(text.startsWith("data: {"), "the first live update was not a state message");
      return "the first live update arrived";
    });
    await W("web_socket", "The live control connection opens and carries a command", ["route:/ws"], async () => {
      const kind = await socketExchange(t, cookie, { type: "lead_target", db: -19 });
      must(kind === "text", `the first message was ${kind}, not state text`);
      const t0 = ctx.clock.monotonic();
      while (engine.assistant.leadTarget !== -19 && ctx.clock.monotonic() - t0 < 1) await ctx.clock.sleep(0.02);
      must(engine.assistant.leadTarget === -19, "a command sent over the live connection did not reach the engine");
      must(
        (await request(log, t, "GET", "/ws", { cookie })).status === 400,
        "a plain request to the live connection address was not refused",
      );
      return "a text message arrived and a lead-target command took effect";
    });
    await W(
      "web_api",
      "Every control address answers",
      [
        "route:/api/toggle",
        "route:/api/lead_target",
        "route:/api/balance_capture",
        "route:/api/reset_notches",
        "route:/api/scene",
        "route:/api/panic",
        "route:/api/calibrate",
        "route:/api/command",
      ],
      async () => {
        const post = async (path: string, json: unknown): Promise<void> => {
          const r = await request(log, t, "POST", path, { cookie, json });
          must(r.status === 200, `${path} answered ${r.status}`);
        };
        await post("/api/toggle", { job: "clip", on: false });
        must(engine.assistant.enabled["clip"] === false, "/api/toggle did not switch the job");
        await post("/api/toggle", { job: "clip", on: true });
        await post("/api/lead_target", { db: -17 });
        must(engine.assistant.leadTarget === -17, "/api/lead_target did not set the target");
        await post("/api/balance_capture", {});
        await post("/api/reset_notches", {});
        await post("/api/scene", { index: 21 });
        await desk.expect("/-show/prepos/current", 21);
        await post("/api/panic", { on: true });
        await desk.expect(`${main}/mix/on`, 0);
        await post("/api/panic", { on: false });
        await desk.expect(`${main}/mix/on`, 1);
        await post("/api/command", { type: "fader", ch: 1, db: -9 });
        await desk.expect("/ch/01/mix/fader", dbToFader(-9));
        await post("/api/calibrate", {});
        must(engine.calibrationTask !== null, "/api/calibrate did not start a calibration");
        await engine.calibrationTask;
        must(
          engine.events.some((e) => e.kind === "calibration"),
          "calibration left no message",
        );
        must(
          (await request(log, t, "POST", "/api/nope", { cookie, json: {} })).status === 404,
          "an unknown control address did not answer 404",
        );
        return "eight control addresses answered; scene, takeover and fader were read back from the emulated console";
      },
    );
    await W("web_origin", "A request from another website is refused", ["feature:origin-guard"], async () => {
      const r = await request(log, t, "POST", "/api/toggle", { cookie, json: { job: "clip", on: false }, origin: "http://evil.example" });
      must(r.status === 403, `a cross-site request answered ${r.status}, expected 403`);
      must(engine.assistant.enabled["clip"] === true, "a cross-site request changed a job");
      return "refused with 403 and the job stayed on";
    });
  });
  await W("web_lockout", "Repeated wrong PINs lock the login", ["feature:login-lockout"], async () =>
    withServer({ engine, staticDir, pin, limiter: new LoginLimiter() }, false, null, async (t) => {
      let tries = 0;
      let status = 0;
      while (tries < 8 && status !== 429) {
        status = (await request(log, t, "POST", "/api/login", { json: { pin: "wrong-again" } })).status;
        tries += 1;
      }
      must(status === 429, `still not locked after ${tries} wrong PINs`);
      must((await request(log, t, "POST", "/api/login", { json: { pin } })).status === 429, "the right PIN was accepted during the lock");
      return `locked after ${tries - 1} wrong PINs; even the right PIN then waits`;
    }),
  );
  await W("web_open_refused", "The dashboard refuses to serve the network without a PIN", ["feature:lan-needs-pin"], async () => {
    const server = createServer({ engine, staticDir });
    try {
      await server.start(0, "0.0.0.0");
    } catch (e) {
      must(e instanceof OpenDashboardRefused, `it failed for another reason: ${errText(e)}`);
      return "refused before opening any port";
    }
    await server.stop();
    throw new VetFailure("it started on the network with no PIN");
  });
  const dir = mkdtempSync(join(tmpdir(), "trio-vet-"));
  try {
    const hosts = tlsHosts(allLanIps(null));
    await W("tls_self_signed", "HTTPS with the app's own certificate", ["feature:https"], async () => {
      const [certfile, keyfile] = ensureCert(join(dir, "plain"), hosts);
      const tls = { key: readFileSync(keyfile, "utf8"), cert: readFileSync(certfile, "utf8") };
      return withServer({ engine, staticDir, pin, tls }, true, tls.cert, async (t) => {
        const login = await request(log, t, "POST", "/api/login", { json: { pin } });
        must(login.status === 200, `sign-in over https answered ${login.status}`);
        const raw = login.headers["set-cookie"];
        must(String(Array.isArray(raw) ? raw[0] : raw).includes("Secure"), "the sign-in cookie is not marked Secure over https");
        return "a certificate was made, the dashboard answered over https with that exact certificate and the cookie is Secure";
      });
    });
    await W(
      "tls_trusted",
      "Trusted HTTPS: the local root signs a certificate that verifies against it",
      ["feature:trust", "route:/ca.pem", "route:/ca.crt"],
      async () => {
        const [certfile, keyfile, cafile] = ensureTrustedCert(join(dir, "trusted"), hosts);
        const caPem = readFileSync(cafile, "utf8");
        const tls = { key: readFileSync(keyfile, "utf8"), cert: readFileSync(certfile, "utf8") };
        return withServer({ engine, staticDir, pin, tls, caPem }, true, caPem, async (t) => {
          must((await request(log, t, "GET", "/")).status === 200, "the page was not served over trusted https");
          for (const path of ["/ca.pem", "/ca.crt"]) {
            const r = await request(log, t, "GET", path);
            must(r.status === 200 && r.body === caPem, `${path} did not serve the root certificate`);
          }
          return "the connection verified against the local root with no override, and the root is downloadable";
        });
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function emulated(ctx: Ctx): Promise<void> {
  const box: { emu: EmulatedDesk | null } = { emu: null };
  let made: Link | null = null;
  try {
    try {
      made = await link(ctx, "127.0.0.1", 0, "127.0.0.1", "emulator", async (localPort) => {
        const emu = new EmulatedDesk(ctx.io.udp, ctx.clock, { listenPort: 0, listenHost: "127.0.0.1", appPort: localPort, cfg: ctx.cfg });
        box.emu = emu;
        await emu.start();
        return { host: "127.0.0.1", port: emu.listenPort };
      });
    } catch (e) {
      ctx.rows.push({
        id: "emu_start",
        area: EMU,
        title: "The emulator starts",
        status: "fail",
        proof: "this computer",
        detail: errText(e),
        covers: [],
      });
      return;
    }
    const desk = box.emu;
    if (desk === null) return;
    await vetConsole(ctx.rows, made.desk, EMU, { channel: 2, main: true, gain: true });
    await emulatorExtras(ctx, desk);
    await vetSequence(ctx.rows, made.desk, { externalMove: (ch, db) => desk.moveFaderExternally(ch, db) });
    await dashboard(ctx, made.desk);
  } finally {
    if (made !== null) made.rx.stop();
    if (box.emu !== null) box.emu.stop();
  }
}

const REAL = "Real console";

function liveLink(ctx: Ctx, live: LiveConsole): Link {
  const target: Peer = { host: live.ip, port: live.port };
  const desk = new Desk({
    transmit: (data) => live.rx.send(data, target),
    clock: ctx.clock,
    log: ctx.log,
    proof: "real console",
    stopped: ctx.stopped,
    cfg: ctx.cfg,
  });
  live.rx.onMessage = (addr, args) => desk.receive(addr, args);
  if (ctx.hooks.control) desk.holdMain = ctx.hooks.control.takeover;
  return { desk, rx: live.rx };
}

async function realConsole(ctx: Ctx): Promise<void> {
  const { args, io } = ctx;
  const ip = args.consoleIp || ctx.cfg.CONSOLE_IP;
  const writes = [
    args.vetChannel !== null ? `channel ${args.vetChannel}` : null,
    args.vetChannel !== null && args.vetGain ? `the preamp gain of channel ${args.vetChannel}` : null,
    args.vetMain ? "the main bus and the first FX return" : null,
  ].filter((w) => w !== null);
  io.out("");
  io.out(
    writes.length
      ? `  Real console at ${ip}: this run sets values on ${writes.join(", ")}, reads each back and puts it back. Keep the PA off.`
      : `  Real console at ${ip}: read-only (no --vet-channel or --vet-main), so nothing on it is changed.`,
  );
  const live = ctx.hooks.live ?? null;
  let made: Link;
  try {
    made =
      live !== null
        ? liveLink(ctx, live)
        : await link(ctx, "0.0.0.0", ctx.hooks.localPort ?? ctx.cfg.LOCAL_PORT, isIP(ip) !== 0 ? ip : null, "real console", () =>
            Promise.resolve({ host: ip, port: ctx.cfg.CONSOLE_PORT }),
          );
  } catch (e) {
    ctx.rows.push({
      id: "con_listen",
      area: REAL,
      title: "This computer can listen for the console",
      status: "fail",
      proof: "this computer",
      detail: `could not open UDP port ${ctx.hooks.localPort ?? ctx.cfg.LOCAL_PORT} (${errText(e)}); close the app if it is running and try again`,
      covers: [],
    });
    return;
  }
  try {
    await vetConsole(ctx.rows, made.desk, REAL, { channel: args.vetChannel, main: args.vetMain, gain: args.vetGain });
  } finally {
    if (live !== null) live.rx.onMessage = null;
    else made.rx.stop();
  }
}

const SOUND = "Sound path";

async function sound(ctx: Ctx): Promise<void> {
  const spec: StepSpec = {
    id: "sound_noise",
    area: SOUND,
    title: "Test noise from the speakers reaches the measurement input",
    proof: "this computer",
    covers: ["feature:sound-path"],
  };
  const open = ctx.hooks.openSource;
  if (open === null) {
    skipRow(ctx.rows, ctx.log, spec, "needs an input: add --audio-device <number> (and --output-device for the PA)");
    return;
  }
  await step(ctx.rows, ctx.log, spec, async () => {
    if (ctx.stopped()) throw new VetSkip("stopped before this step ran");
    const seconds = ctx.cfg.calibration.durationS;
    ctx.io.out("");
    ctx.io.out(`  SOUND: pink noise plays through the output device for ${seconds} seconds.`);
    const source = open();
    try {
      source.start();
      await within(source.ready(), ctx.clock, OPEN_WAIT_S, "opening the audio device");
      const result = await within(
        measureSound(source, generatePinkNoise(seconds, new SeededRng(1), ctx.cfg.SAMPLE_RATE, ctx.cfg.calibration.noiseDbfs), seconds),
        ctx.clock,
        seconds * 2 + 20,
        "playing and recording the test noise",
      );
      const verdict = soundVerdict(result);
      const found = result.capture === null ? null : new Calibrator(new SimConsole({ cfg: ctx.cfg }), ctx.cfg).analyze(result.capture);
      const cuts = found === null ? 0 : found.corrections.length;
      return `${verdict}; the room analysis found ${cuts} band${cuts === 1 ? "" : "s"} that stand${cuts === 1 ? "s" : ""} out (nothing was applied)`;
    } finally {
      source.stop();
      await within(source.settled(), ctx.clock, 5, "closing the audio device").catch(() => undefined);
    }
  });
}

const PHONE = "Phone";

async function phone(ctx: Ctx): Promise<void> {
  const { args, io } = ctx;
  const spec: StepSpec = {
    id: "phone_login",
    area: PHONE,
    title: "A device on the network signs in",
    proof: "this computer",
    covers: ["feature:phone-login"],
  };
  if (!args.pin || !args.lan) {
    skipRow(ctx.rows, ctx.log, spec, "needs the network and a PIN: add --lan --pin <at least 6 characters> (and --https to test that too)");
    return;
  }
  await step(ctx.rows, ctx.log, spec, async () => {
    if (ctx.stopped()) throw new VetSkip("stopped before this step ran");
    const ip = await ctx.hooks.lanIp();
    must(ip !== null, "this computer has no network address a phone could reach");
    let tls: { key: string; cert: string } | null = null;
    if (args.https) {
      const [certfile, keyfile] = ensureCert(join(io.layout.appDir, ".certs"), tlsHosts(allLanIps(ip)));
      tls = { key: readFileSync(keyfile, "utf8"), cert: readFileSync(certfile, "utf8") };
    }
    let who: string | null = null;
    const engine = new Engine({ sim: true, clock: ctx.clock, cfg: ctx.cfg });
    const server = createServer({
      engine,
      staticDir: io.layout.staticDir,
      pin: args.pin,
      tls,
      onLogin: (addr) => {
        const bare = addr.replace(/^::ffff:/i, "");
        if (bare !== "127.0.0.1" && bare !== "::1") who = bare;
      },
    });
    await server.start(args.port, "0.0.0.0");
    const wait = ctx.hooks.phoneSeconds ?? PHONE_WAIT_S;
    try {
      io.out("");
      io.out(
        `  PHONE: open ${tls ? "https" : "http"}://${ip}:${args.port}/ on the phone and enter the PIN. Waiting up to ${wait} seconds.`,
      );
      if (tls) io.out("         If the phone shows a certificate warning, accept it to continue.");
      const t0 = ctx.clock.monotonic();
      while (who === null && !ctx.stopped() && ctx.clock.monotonic() - t0 < wait) await ctx.clock.sleep(0.25);
    } finally {
      await server.stop();
    }
    if (who === null && ctx.stopped()) throw new VetSkip("stopped before a phone signed in");
    must(
      who !== null,
      `no phone signed in within ${wait} seconds; check it is on the same network and that this computer's firewall allows port ${args.port}`,
    );
    return `a device at ${String(who)} signed in over ${tls ? "https" : "http"}`;
  });
}

export function inAppVet(io: Io, live: LiveConsole | null, lanIp: () => Promise<string | null>, cfg: Config): VetHostPort {
  return {
    console: live !== null,
    async run(req: VetRequest, control: VetControl): Promise<VetSummary> {
      const flags = ["--vet"];
      if (req.identify) flags.push("--vet-keep-names");
      if (live !== null) {
        flags.push("--hardware", `--console-ip=${live.ip}`);
        if (req.channel !== null) {
          flags.push(`--vet-channel=${req.channel}`);
          if (req.gain) flags.push("--vet-gain");
        }
        if (req.main) flags.push("--vet-main");
      }
      const lines: string[] = [];
      const scrub = req.identify ? (text: string): string => text : scrubberFor(io);
      const out = await runVet(
        parseCliArgs(flags),
        { ...io, out: (l) => lines.push(l.replace(/\r/g, "")) },
        { openSource: null, lanIp, live, control, cfg },
      );
      if (control.appState !== undefined) lines.push(...scrub(redact(control.appState().join("\n"), systemFacts().home)).split("\n"));
      lines.push(
        "",
        `  Checksum: SHA-256 of every line above, joined with line breaks: ${createHash("sha256").update(lines.join("\n"), "utf8").digest("hex")}`,
      );
      const count = (st: string): number => out.rows.filter((r) => r.status === st).length;
      return {
        text: lines.join("\n"),
        summary: `${count("pass")} passed${live !== null ? ` (${out.rows.filter((r) => r.status === "pass" && r.proof === "real console").length} on the real console)` : ""}, ${count("fail")} failed, ${count("skip")} skipped`,
        failed: count("fail"),
      };
    },
  };
}

export function scrubberFor(io: Io): (text: string) => string {
  const words: string[] = [];
  try {
    words.push(hostname(), userInfo().username);
  } catch {
    words.length = 0;
  }
  try {
    const cfg = readConf(join(io.layout.appDir, "show.conf"));
    for (const k of ["VENUE", "TEMPLATE"]) if (cfg[k]) words.push(cfg[k]);
  } catch {
    words.push();
  }
  let devices: string[] = [];
  try {
    devices = io.factory === null ? [] : io.factory.listDevices().map((d) => d.name ?? "");
  } catch {
    devices = [];
  }
  return makeScrubber({ devices, words });
}

const SECRET_KEY = /PIN|PASS|SECRET|TOKEN|KEY/i;

export async function setupLines(io: Io, lanIp: () => Promise<string | null>, cfg: Config): Promise<string[]> {
  const out: string[] = ["", "  Setup"];
  out.push(`    Settings folder: ${io.layout.appDir}`);
  try {
    const cfg = readConf(join(io.layout.appDir, "show.conf"));
    const keys = Object.keys(cfg);
    if (keys.length === 0) out.push("    show.conf: missing or empty");
    else {
      out.push("    show.conf (secrets shown only as set or empty):");
      for (const k of keys) out.push(`      ${k}=${SECRET_KEY.test(k) ? (cfg[k] === "" ? "(empty)" : "(set)") : cfg[k]}`);
    }
  } catch (e) {
    out.push(`    show.conf could not be read: ${errText(e)}`);
  }
  const tuned = tuningLines(cfg.TUNED);
  if (tuned.length === 0) out.push("    Tuning: all defaults");
  else {
    out.push("    Tuning changed from the defaults (the full test's job steps run with the defaults):");
    for (const l of tuned) out.push(`      ${l}`);
  }
  try {
    const names = readdirSync(io.layout.appDir);
    const logs = names.filter((n) => n.startsWith("vet-")).length;
    const rest = names.filter((n) => !n.startsWith("vet-")).sort();
    out.push(`    Files here: ${rest.join(", ") || "none"}${logs > 0 ? ` and ${logs} earlier test log${logs === 1 ? "" : "s"}` : ""}`);
  } catch (e) {
    out.push(`    Files here: could not be listed (${errText(e)})`);
  }
  let ip: string | null = null;
  try {
    ip = await lanIp();
  } catch {
    ip = null;
  }
  out.push(`    Network address of this computer: ${ip ?? "none found"}`);
  out.push("    Audio devices:");
  const devices = io.factory === null ? "the audio module was not loaded" : listAudioDevices(io.factory);
  for (const l of devices.replace(/\r/g, "").split("\n")) out.push(`      ${l}`);
  return out;
}

const stamp = (d: Date): string => {
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
};

export interface VetOutcome {
  code: number;
  rows: VetRow[];
  logPath: string | null;
}

export async function runVet(args: Args, ioIn: Io, hooks: VetHooks): Promise<VetOutcome> {
  const scrub = args.vetKeepNames ? (text: string): string => text : scrubberFor(ioIn);
  const io: Io = { ...ioIn, out: (line) => ioIn.out(scrub(line)) };
  const sys = systemFacts();
  const head = [
    "",
    "===== Trio Mix-Assistant full test =====",
    `  Run:    ${new Date(io.clock.time() * 1000).toISOString().replace(/\.\d+Z$/, "Z")} (UTC)`,
    `  App:    ${sys.app}`,
    `  System: ${sys.system}`,
  ];
  const path = join(io.layout.appDir, `vet-${stamp(new Date())}.log`);
  let logPath: string | null = path;
  let logError: string | null = null;
  const write = (lines: readonly string[], fresh: boolean = false): void => {
    if (logPath === null) return;
    const text = scrub(redact(lines.join("\n") + "\n", sys.home));
    try {
      if (fresh) writeFileSync(path, text, "utf8");
      else appendFileSync(path, text, "utf8");
    } catch (e) {
      logPath = null;
      logError = errText(e);
    }
  };
  const setup = scrub(redact((await setupLines(io, hooks.lanIp, hooks.cfg)).join("\n"), sys.home)).split("\n");
  write(
    [...head, ...setup, "", "--- every step, with the console commands sent and the replies received (meter data is not logged) ---"],
    true,
  );
  const log = new VetLog(io.clock, (line) => write([line]));
  let stop = false;
  void io.waitForStop().then(() => {
    stop = true;
    io.out("  Stopping: the value being tested is put back first.");
  });
  const holdInterrupt = (): void => undefined;
  process.on("SIGINT", holdInterrupt);
  const control = hooks.control ?? null;
  if (control !== null && control.progress !== undefined) log.onProgress = (done, title) => control.progress?.(done, title);
  const ctx: Ctx = {
    args,
    io,
    hooks,
    rows: [],
    log,
    clock: io.clock,
    stopped: () => stop || (control !== null && control.stopped()),
    cfg: copyConfig(hooks.cfg),
  };
  for (const l of head) io.out(l);
  for (const l of setup) io.out(l);
  io.out("  Testing this computer and the built-in emulator. No sound is played and no real console is touched in this part.");
  try {
    await thisComputer(ctx);
    await emulated(ctx);
    if (args.hardware && !stop) await realConsole(ctx);
    if (args.vetSound) await sound(ctx);
    if (args.vetPhone) await phone(ctx);
  } catch (e) {
    ctx.rows.push({
      id: "vet_crash",
      area: "Test run",
      title: "The test run itself",
      status: "fail",
      proof: "nothing",
      detail: `stopped on an unexpected error: ${errText(e)}`,
      covers: [],
    });
  } finally {
    process.off("SIGINT", holdInterrupt);
  }
  const pending: [boolean, string][] = [
    [
      !args.hardware,
      "A real console was not tested: add --hardware --console-ip <address>, then --vet-channel <number> to test control on one channel.",
    ],
    [!args.vetSound, "The sound path was not tested: add --vet-sound --audio-device <number> (this plays noise)."],
    [!args.vetPhone, "A phone was not tested: add --vet-phone --lan --pin <PIN>."],
  ];
  const report = [
    ...tableLines(ctx.rows),
    ...summaryLines(ctx.rows),
    ...(control !== null ? [] : pending.filter(([on]) => on).map(([, text]) => `  ${text}`)),
    ...operatorLines(),
  ];
  for (const l of report) io.out(l);
  if (control !== null) {
    const trace = traceLines(log.lines, ctx.rows);
    if (trace.length > 0) {
      io.out("");
      io.out("  What was sent to and received from the console, for the failed steps and every step on the real console:");
      for (const l of trace) io.out(redact(l, sys.home));
    }
  }
  write(["", "--- result ---", ...report]);
  io.out("");
  io.out(logPath !== null ? `  Full log: ${path}` : `  [!] The log file could not be written (${logError ?? "unknown error"}).`);
  return { code: ctx.rows.some((r) => r.status === "fail") ? 1 : 0, rows: ctx.rows, logPath };
}
