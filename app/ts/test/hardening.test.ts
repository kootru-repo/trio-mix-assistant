import { defaultConfig } from "../src/core/config.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManualClock } from "../src/core/clock.ts";
import { OscConsole } from "../src/core/console.ts";
import { Engine } from "../src/core/engine/index.ts";
import { MeterReceiver } from "../src/core/metersrv.ts";
import { decodePacket, encodeMessage, oscFloat, oscStr } from "../src/core/oscwire.ts";
import { AbleSetReceiver, MAX_SHOW_TEXT } from "../src/core/showclock.ts";
import type { DatagramHandler, Peer, UdpEndpoint, UdpFactory } from "../src/core/transport.ts";
import { parseCliArgs, UsageError } from "../src/host/args.ts";
import { buildArgv } from "../src/host/launcher.ts";
import { createServer } from "../src/host/server.ts";
import type { DashboardServer, ServerOptions } from "../src/host/server.ts";
import { AddressCounter, CommandBudget, LoginLimiter } from "../src/host/server/limiter.ts";
import { ensureCert } from "../src/host/tls.ts";

const testCfg = defaultConfig();

const staticDir = join(import.meta.dirname, "..", "..", "static");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class FakeUdp implements UdpFactory {
  handlers: DatagramHandler[] = [];

  bind(port: number, _host: string): Promise<UdpEndpoint> {
    const handlers = this.handlers;
    return Promise.resolve({
      port: port === 0 ? 50999 : port,
      send: () => undefined,
      onMessage: (h: DatagramHandler) => {
        handlers.push(h);
      },
      close: () => undefined,
    });
  }

  deliver(data: Uint8Array, from: Peer): void {
    for (const h of this.handlers) h(data, from);
  }
}

interface Rig {
  engine: Engine;
  srv: DashboardServer;
  port: number;
  close(): Promise<void>;
}

const rig = async (opts: Partial<ServerOptions> = {}): Promise<Rig> => {
  const engine = new Engine({ cfg: testCfg, clock: new ManualClock(100, 1_700_000_000), sim: true });
  const srv = createServer({ engine, staticDir, ...opts });
  const { port } = await srv.start(0, "127.0.0.1");
  return {
    engine,
    srv,
    port,
    close: async () => {
      await srv.stop();
      await engine.stop();
    },
  };
};

const post = (port: number, path: string, body: unknown): Promise<number> =>
  new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path, agent: false, headers: { "Content-Length": String(Buffer.byteLength(text)) } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(text);
  });

interface Probe {
  socket: net.Socket;
  text(): string;
  closed(): boolean;
}

const open = (port: number, payload: string | null = null): Promise<Probe> =>
  new Promise((resolve) => {
    let text = "";
    let closed = false;
    const socket = net.connect({ host: "127.0.0.1", port });
    const probe: Probe = { socket, text: () => text, closed: () => closed };
    socket.on("data", (c: Buffer) => (text += c.toString("latin1")));
    socket.on("close", () => (closed = true));
    socket.on("error", () => (closed = true));
    socket.on("connect", () => {
      if (payload !== null) socket.write(payload);
      resolve(probe);
    });
  });

const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
};

const maskedText = (payload: string): Buffer => {
  const p = Buffer.from(payload);
  const key = randomBytes(4);
  const out = Buffer.from(p);
  for (let i = 0; i < out.length; i++) out[i] = out[i]! ^ key[i % 4]!;
  return Buffer.concat([Buffer.from([0x81, 0x80 | p.length]), key, out]);
};

test("a stalled TLS handshake is dropped by the handshake timeout", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mix_hs_"));
  const [certfile, keyfile] = ensureCert(dir, ["localhost", "127.0.0.1"]);
  const r = await rig({ tls: { key: readFileSync(keyfile, "utf8"), cert: readFileSync(certfile, "utf8") } });
  try {
    const p = await open(r.port);
    const t0 = Date.now();
    assert.ok(await until(() => p.closed(), 14000), "the silent connection was never closed");
    assert.ok(Date.now() - t0 >= 5000, "closed before the handshake timeout could apply");
  } finally {
    await r.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one address cannot hold more than its share of connections", async () => {
  const r = await rig({ limitLoopback: true, maxPerAddress: 3 });
  const probes: Probe[] = [];
  try {
    for (let i = 0; i < 6; i++) probes.push(await open(r.port));
    await until(() => probes.filter((p) => p.closed()).length >= 3, 2000);
    assert.equal(probes.filter((p) => p.closed()).length, 3);
    assert.deepEqual(
      probes.slice(0, 3).map((p) => p.closed()),
      [false, false, false],
    );
    probes[0]!.socket.destroy();
    await until(() => probes[0]!.closed(), 1000);
    await sleep(50);
    const again = await open(r.port, "GET /manifest.webmanifest HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    probes.push(again);
    assert.ok(await until(() => again.text().startsWith("HTTP/1.1 200"), 2000), "a freed slot was not reusable");
  } finally {
    for (const p of probes) p.socket.destroy();
    await r.close();
  }
});

test("loopback clients are exempt from the per-address limits by default", async () => {
  const r = await rig({ maxPerAddress: 2 });
  const probes: Probe[] = [];
  try {
    for (let i = 0; i < 8; i++) probes.push(await open(r.port));
    await sleep(200);
    assert.equal(probes.filter((p) => p.closed()).length, 0);
  } finally {
    for (const p of probes) p.socket.destroy();
    await r.close();
  }
});

test("one address cannot take every live stream", async () => {
  const r = await rig({ limitLoopback: true, maxStreamsPerAddress: 2 });
  const probes: Probe[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      probes.push(await open(r.port, `GET /events HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\n\r\n`));
      await until(() => probes[i]!.text().includes("\r\n"), 2000);
    }
    assert.ok(probes[0]!.text().startsWith("HTTP/1.1 200"));
    assert.ok(probes[1]!.text().startsWith("HTTP/1.1 200"));
    assert.ok(probes[2]!.text().startsWith("HTTP/1.1 503"), probes[2]!.text().slice(0, 40));
    assert.equal(r.srv.streamsInUse, 2);
    probes[0]!.socket.destroy();
    await until(() => r.srv.streamsInUse === 1, 2000);
    const next = await open(r.port, `GET /events HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\n\r\n`);
    probes.push(next);
    assert.ok(await until(() => next.text().startsWith("HTTP/1.1 200"), 2000));
  } finally {
    for (const p of probes) p.socket.destroy();
    await r.close();
  }
});

test("the command budget refills at its rate and counts what it drops", () => {
  let now = 0;
  const b = new CommandBudget(10, 5, () => now);
  const first = Array.from({ length: 8 }, () => b.allow("a"));
  assert.deepEqual(first, [true, true, true, true, true, false, false, false]);
  assert.equal(b.dropped, 3);
  assert.ok(b.allow("b"), "another address has its own budget");
  now += 0.2;
  assert.deepEqual([b.allow("a"), b.allow("a"), b.allow("a")], [true, true, false]);
  now += 100;
  assert.equal(Array.from({ length: 9 }, () => b.allow("a")).filter(Boolean).length, 5);
});

test("the command budget keeps a bounded table", () => {
  let now = 0;
  const b = new CommandBudget(10, 5, () => now);
  for (let i = 0; i < b.maxKeys; i++) assert.ok(b.allow("k" + i));
  assert.equal(b.allow("overflow"), false);
  now += 10;
  assert.ok(b.allow("after-idle"));
});

test("commands over HTTP beyond the budget get 429 but panic always passes", async () => {
  const now = 0;
  const r = await rig({ limitLoopback: true, commandBudget: new CommandBudget(1, 2, () => now) });
  try {
    assert.equal(await post(r.port, "/api/command", { type: "fader", ch: 2, db: -3 }), 200);
    assert.equal(await post(r.port, "/api/command", { type: "fader", ch: 2, db: -4 }), 200);
    assert.equal(await post(r.port, "/api/command", { type: "fader", ch: 2, db: -5 }), 429);
    assert.equal(await post(r.port, "/api/reset_notches", {}), 429);
    assert.equal(r.engine.assistant.faderDb.get(2), -4);
    assert.equal(await post(r.port, "/api/command", { type: "panic", on: true }), 200);
    assert.equal(r.engine.status, "takeover");
    assert.equal(await post(r.port, "/api/panic", { on: false }), 200);
    assert.equal(r.engine.status, "live");
    assert.equal(await post(r.port, "/api/command", { type: "coach", on: true }), 429);
  } finally {
    await r.close();
  }
});

test("commands over the WebSocket beyond the budget are dropped but panic always passes", async () => {
  const now = 0;
  const r = await rig({ limitLoopback: true, commandBudget: new CommandBudget(1, 2, () => now) });
  const key = randomBytes(16).toString("base64");
  const p = await open(
    r.port,
    `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${r.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  try {
    assert.ok(await until(() => p.text().startsWith("HTTP/1.1 101"), 2000));
    for (const db of [-1, -2, -3, -4, -5]) p.socket.write(maskedText(JSON.stringify({ type: "fader", ch: 3, db })));
    await until(() => r.srv.commandBudget.dropped === 3, 2000);
    assert.equal(r.srv.commandBudget.dropped, 3);
    assert.equal(r.engine.assistant.faderDb.get(3), -2);
    p.socket.write(maskedText(JSON.stringify({ type: "panic", on: true })));
    assert.ok(await until(() => r.engine.status === "takeover", 2000));
    assert.equal(p.closed(), false);
  } finally {
    p.socket.destroy();
    await r.close();
  }
});

test("each lockout of the same address lasts twice as long, up to a ceiling", () => {
  let now = 0;
  const lim = new LoginLimiter(() => now);
  const lockLength = (): number => {
    for (let i = 0; i < lim.maxFails; i++) assert.ok(lim.admit("10.9.9.9"));
    const start = now;
    while (lim.locked("10.9.9.9")) now += 1;
    return now - start;
  };
  const lengths = [lockLength(), lockLength(), lockLength()];
  assert.deepEqual(lengths, [lim.lockS, lim.lockS * 2, lim.lockS * 4]);
  for (let i = 0; i < 12; i++) {
    now += 120;
    assert.ok(lockLength() <= lim.maxLockS);
  }
  now += 120;
  assert.equal(lockLength(), lim.maxLockS);
});

test("an address that has signed in before is not shut out by a flood of guesses from others", () => {
  let now = 0;
  const lim = new LoginLimiter(() => now);
  assert.ok(lim.admit("10.0.0.5"));
  lim.success("10.0.0.5");
  for (let i = 0; i < lim.globalFreshAttempts + 20; i++) lim.admit("10.7." + (i >> 8) + "." + (i & 255));
  assert.equal(lim.admit("10.0.0.99"), false, "a never-seen address is held back during the flood");
  assert.ok(lim.admit("10.0.0.5"), "the operator's known address still gets in");
  lim.success("10.0.0.5");
  for (let i = 0; i < lim.maxFails; i++) lim.admit("10.0.0.5");
  assert.ok(lim.locked("10.0.0.5"), "a known address is still locked out by its own wrong guesses");
  now += 1;
  assert.ok(lim.globalFreshAttempts <= 30);
});

test("the address counter releases exactly what it took", () => {
  const c = new AddressCounter(2);
  assert.deepEqual([c.take("a"), c.take("a"), c.take("a"), c.take("b")], [true, true, false, true]);
  c.release("a");
  assert.ok(c.take("a"));
  c.release("a");
  c.release("a");
  c.release("a");
  c.release("b");
  assert.equal(c.size, 0);
});

const song = (name: string): Uint8Array => encodeMessage("/setlist/activeSongName", [oscStr(name)]);

test("AbleSet text is cut to a fixed length", async () => {
  const udp = new FakeUdp();
  const seen: string[] = [];
  const rx = new AbleSetReceiver(udp, testCfg, (s) => seen.push(s.songName + "|" + s.section + "|" + s.nextSong), "0.0.0.0", 39051);
  await rx.start();
  const from = { host: "10.0.0.7", port: 5000 };
  udp.deliver(encodeMessage("/setlist/nextSongName", [oscStr("N".repeat(60000))]), from);
  udp.deliver(encodeMessage("/song/sectionName", [oscStr("S".repeat(60000))]), from);
  udp.deliver(song("A".repeat(60000)), from);
  assert.equal(seen.length, 1);
  const [name, section, next] = seen[0]!.split("|");
  assert.equal(name!.length, MAX_SHOW_TEXT);
  assert.equal(section!.length, MAX_SHOW_TEXT);
  assert.equal(next!.length, MAX_SHOW_TEXT);
  rx.stop();
});

test("AbleSet locks onto the first sender and ignores every other address", async () => {
  const udp = new FakeUdp();
  const seen: string[] = [];
  const rx = new AbleSetReceiver(udp, testCfg, (s) => seen.push(s.songName), "0.0.0.0", 39051);
  await rx.start();
  udp.deliver(encodeMessage("/xremote", []), { host: "10.0.0.66", port: 1 });
  assert.equal(rx.acceptedSender, null, "an unrelated packet must not claim the lock");
  udp.deliver(song("One"), { host: "::ffff:10.0.0.7", port: 5000 });
  assert.equal(rx.acceptedSender, "10.0.0.7");
  udp.deliver(song("Spoofed"), { host: "10.0.0.66", port: 5000 });
  udp.deliver(song("Two"), { host: "10.0.0.7", port: 6123 });
  assert.deepEqual(seen, ["One", "Two"]);
  assert.equal(rx.rejected, 1);
  rx.stop();
});

test("AbleSet with a set sender address refuses everyone else from the start", async () => {
  const udp = new FakeUdp();
  const seen: string[] = [];
  const rx = new AbleSetReceiver(udp, testCfg, (s) => seen.push(s.songName), "0.0.0.0", 39051, "10.0.0.7");
  await rx.start();
  udp.deliver(song("First but wrong"), { host: "10.0.0.66", port: 5000 });
  udp.deliver(song("Right"), { host: "10.0.0.7", port: 5000 });
  assert.deepEqual(seen, ["Right"]);
  assert.equal(rx.rejected, 1);
  rx.stop();
});

test("the meter receiver takes fader moves only from the console's address", async () => {
  const udp = new FakeUdp();
  const faders: [number, number][] = [];
  const rx = new MeterReceiver(udp, { cfg: testCfg, onFader: (ch, db) => faders.push([ch, db]), port: 10024, allowFrom: "192.168.1.50" });
  await rx.start();
  const move = encodeMessage("/ch/01/mix/fader", [oscFloat(1.0)]);
  udp.deliver(move, { host: "192.168.1.66", port: 10023 });
  assert.equal(faders.length, 0);
  assert.equal(rx.rejected, 1);
  udp.deliver(move, { host: "::ffff:192.168.1.50", port: 10023 });
  assert.equal(faders.length, 1);
  rx.stop();
  const open2 = new MeterReceiver(udp, { cfg: testCfg, onFader: (ch, db) => faders.push([ch, db]), port: 10025 });
  await open2.start();
  udp.deliver(move, { host: "192.168.1.66", port: 10023 });
  assert.equal(faders.length, 2, "with no address set, any sender is accepted");
  open2.stop();
});

test("panic mutes the main before it writes anything else", () => {
  const clock = new ManualClock(100, 1_700_000_000);
  const sent: string[] = [];
  const sink = {
    send: (data: Uint8Array): void => {
      for (const m of decodePacket(data)) sent.push(`${m.address} ${m.args.map((a) => String(a.v)).join(",")}`);
    },
    close: (): void => undefined,
  };
  const e = new Engine({ cfg: testCfg, clock, console: new OscConsole(sink, { cfg: testCfg, clock }) });
  const instruments = [...testCfg.CHANNELS.keys()].filter((ch) => ch !== testCfg.LEAD_VOCAL_CH).slice(0, 3);
  for (const ch of instruments) e.assistant.duckApplied.set(ch, -3);
  sent.length = 0;
  e.panic(true);
  assert.equal(sent[0], "/main/st/mix/on 0");
  assert.ok(sent.length > 1, "the unmask release should still be written after the mute");
  assert.equal(sent.filter((s) => s.startsWith("/main/st/mix/on")).length, 1);
});

test("--ableset-from takes an IP address and nothing else", () => {
  assert.equal(parseCliArgs(["--hardware", "--ableset-port", "39051", "--ableset-from", "10.0.0.7"]).ablesetFrom, "10.0.0.7");
  assert.equal(parseCliArgs(["--hardware"]).ablesetFrom, null);
  assert.throws(() => parseCliArgs(["--ableset-from", "ableset.local"]), UsageError);
  assert.throws(() => parseCliArgs(["--ableset-from", "10.0.0"]), UsageError);
});

test("ABLESET_FROM in show.conf is passed to the app in hardware mode", () => {
  const { argv } = buildArgv(
    { MODE: "hardware", CONSOLE_IP: "10.0.0.9", ABLESET_PORT: "39051", ABLESET_FROM: "10.0.0.7", PIN: "246810" },
    join(import.meta.dirname, "..", ".."),
    false,
    () => undefined,
  );
  assert.ok(argv.includes("--ableset-from=10.0.0.7"));
});
