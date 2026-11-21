import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { C } from "../src/core/config.ts";
import { dbToFader, OscConsole } from "../src/core/console.ts";
import { EmulatedDesk } from "../src/core/emulator.ts";
import { MemNetwork } from "../src/core/memtransport.ts";
import { MeterReceiver } from "../src/core/metersrv.ts";
import { decodeMessage, decodeMeterBlob, encodeMessage, oscFloat, oscInt, oscStr } from "../src/core/oscwire.ts";
import type { OscArg, OscMessage } from "../src/core/oscwire.ts";
import type { Peer, UdpEndpoint, UdpFactory } from "../src/core/transport.ts";
import { SystemClock } from "../src/host/clock.ts";
import { NodeUdpFactory } from "../src/host/udp.ts";
import { fixture } from "./helpers.ts";
import { StepClock } from "./stepclock.ts";

const scn = readFileSync(fileURLToPath(new URL("../../x32_default_nodes.scn", import.meta.url)), "utf8");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const LOCAL: Peer = { host: "127.0.0.1", port: 0 };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function decodeReply(b: Uint8Array): OscMessage {
  const copy = b.slice();
  if (copy.length >= 8 && hex(copy.subarray(0, 4)) === "6e6f6465") {
    const fixed = new Uint8Array(copy.length);
    fixed.set([0x2f], 0);
    fixed.set(copy.subarray(0, 4), 1);
    fixed.set(copy.subarray(8), 8);
    const m = decodeMessage(fixed);
    assert.ok(m);
    return { address: "node", args: m.args };
  }
  const m = decodeMessage(copy);
  assert.ok(m, `undecodable packet ${hex(copy)}`);
  return m;
}

function strs(m: OscMessage): string[] {
  return m.args.map((a) => String(a.v));
}

class Peerbox {
  readonly inbox: OscMessage[] = [];
  readonly raw: string[] = [];
  readonly ep: UdpEndpoint;
  target: Peer = LOCAL;

  constructor(ep: UdpEndpoint) {
    this.ep = ep;
    ep.onMessage((data) => {
      this.raw.push(hex(data));
      this.inbox.push(decodeReply(data));
    });
  }

  send(addr: string, ...args: OscArg[]): void {
    this.ep.send(encodeMessage(addr, args), this.target);
  }

  async next(timeoutMs = 1000): Promise<OscMessage | null> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const m = this.inbox.shift();
      if (m) return m;
      await sleep(5);
    }
    return null;
  }

  async ask(addr: string, ...args: OscArg[]): Promise<OscMessage | null> {
    this.send(addr, ...args);
    return this.next();
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

async function memRig(opts: { meterHz?: number; externalMoves?: boolean } = {}) {
  const net = new MemNetwork();
  const clock = new StepClock();
  const app = new Peerbox(await net.bind(0, "127.0.0.1"));
  const ed = new Peerbox(await net.bind(0, "127.0.0.1"));
  const desk = new EmulatedDesk(net, clock, {
    listenPort: 0,
    appIp: "127.0.0.1",
    appPort: app.ep.port,
    localIp: "10.0.0.5",
    nodeScn: scn,
    ...opts,
  });
  await desk.start();
  ed.target = { host: "127.0.0.1", port: desk.listenPort };
  const stop = (): void => {
    desk.stop();
    ed.ep.close();
    app.ep.close();
  };
  return { net, clock, app, ed, desk, stop };
}

class FakeApp {
  sent: [string, OscArg[]][] = [];
  readonly fn = (addr: string, args: OscArg[]): void => {
    this.sent.push([addr, args]);
  };
}

function bareDesk(opts: { meterHz?: number } = {}) {
  const net = new MemNetwork();
  const clock = new StepClock();
  const desk = new EmulatedDesk(net, clock, opts);
  const fake = new FakeApp();
  desk.setAppSender(fake.fn);
  return { net, clock, desk, fake };
}

test("fixture replay: every reply to the recorded request script is byte-exact", async () => {
  const fx = fixture("emulator");
  const r = await memRig();
  try {
    for (const [i, entry] of fx.script.entries()) {
      const st = entry.step;
      r.ed.raw.length = 0;
      r.app.raw.length = 0;
      if (st.op === "send") {
        const args: OscArg[] = st.args.map((a: { t: string; v: number | string }) =>
          a.t === "i" ? oscInt(a.v as number) : a.t === "f" ? oscFloat(a.v as number) : oscStr(a.v as string),
        );
        r.ed.send(st.addr, ...args);
      } else if (st.op === "external") {
        r.desk.moveFaderExternally(st.ch, st.db);
      } else if (st.op === "scene_names") {
        r.desk.sceneNames = new Map(Object.entries(st.names).map(([k, v]) => [Number(k), v as string]));
      }
      await r.net.settle();
      const what = `step ${i} ${st.addr ?? st.op}`;
      assert.deepEqual(r.ed.raw, entry.editor, `${what}: editor replies`);
      assert.deepEqual(r.app.raw, entry.app, `${what}: app datagrams`);
    }
    const s = fx.state;
    assert.deepEqual(Object.fromEntries([...r.desk.fader].map(([k, v]) => [String(k), v])), s.fader);
    assert.deepEqual(Object.fromEntries([...r.desk.mute].map(([k, v]) => [String(k), v])), s.mute);
    assert.equal(r.desk.scene, s.scene);
    assert.equal(r.desk.subscribed, s.subscribed);
    assert.equal(r.desk.recvCount, s.recv_count);
    assert.equal(r.desk.echoCount, s.echo_count);
    assert.deepEqual(r.desk.reqLog, s.req_log);
  } finally {
    r.stop();
  }
});

test("fixture: first meter packet per subscription matches the python stream", async () => {
  const fx = fixture("emulator");
  const cases: [string, string, OscArg[]][] = [
    ["meters2", "/meters", [oscStr("/meters/2"), oscInt(2)]],
    ["batch0", "/batchsubscribe", [oscStr("meters/0"), oscStr("/meters/0"), oscInt(0), oscInt(0), oscInt(2)]],
    ["meters99", "/meters", [oscStr("/meters/99"), oscInt(2)]],
  ];
  for (const [name, addr, args] of cases) {
    const r = await memRig();
    try {
      r.ed.send(addr, ...args);
      await r.net.settle();
      await r.clock.advance(0.1);
      await r.net.settle();
      const want = fx.meters[name];
      const m = r.ed.inbox.find((x) => x.address === want.addr);
      assert.ok(m, `${name}: no stream packet`);
      const blob = m.args[0];
      assert.ok(blob && blob.t === "b");
      const vals = decodeMeterBlob(blob.v);
      assert.equal(vals.length, want.values.length, name);
      vals.forEach((v, i) => assert.ok(Math.abs(v - want.values[i]) < 1e-6, `${name}[${i}]`));
      assert.equal(blob.v.length, 4 + want.values.length * 4);
    } finally {
      r.stop();
    }
  }
});

test("discovery handshake answers /info /xinfo /status", async () => {
  const r = await memRig();
  try {
    r.ed.send("/info");
    await r.net.settle();
    const info = r.ed.inbox.shift()!;
    assert.equal(info.address, "/info");
    assert.equal(info.args.length, 4);
    assert.deepEqual(strs(info), [C.X32_SERVER_VER, C.X32_NAME, C.X32_MODEL, C.X32_FW]);
    r.ed.send("/xinfo");
    r.ed.send("/status");
    await r.net.settle();
    assert.deepEqual(strs(r.ed.inbox.shift()!), ["10.0.0.5", C.X32_NAME, C.X32_MODEL, C.X32_FW]);
    const status = r.ed.inbox.shift()!;
    assert.equal(status.address, "/status");
    assert.equal(status.args[0]!.v, "active");
  } finally {
    r.stop();
  }
});

test("param GET reads the seeded model", async () => {
  const r = await memRig();
  try {
    r.ed.send("/ch/01/config/name");
    r.ed.send("/ch/01/mix/fader");
    await r.net.settle();
    const name = r.ed.inbox.shift()!;
    assert.equal(name.address, "/ch/01/config/name");
    assert.equal(name.args[0]!.t, "s");
    const fader = r.ed.inbox.shift()!;
    assert.equal(fader.args[0]!.t, "f");
    assert.ok(Math.abs((fader.args[0]!.v as number) - 0.75) < 1e-6);
  } finally {
    r.stop();
  }
});

test("/node returns a node reply with a trailing newline", async () => {
  const r = await memRig();
  try {
    r.ed.send("/node", oscStr("ch/01/config/name"));
    await r.net.settle();
    const m = r.ed.inbox.shift()!;
    assert.equal(m.address, "node");
    assert.ok(String(m.args[0]!.v).includes("/ch/01/config/name"));
    assert.ok(String(m.args[0]!.v).endsWith("\n"));
  } finally {
    r.stop();
  }
});

test("/xremote subscribes the editor and pushes desk moves", async () => {
  const r = await memRig();
  try {
    r.ed.send("/xremote");
    await r.net.settle();
    assert.ok([...r.desk.remotes.values()].some((p) => p.port === r.ed.ep.port));
    r.desk.moveFaderExternally(2, -6.0);
    await r.net.settle();
    assert.equal(r.ed.inbox.shift()?.address, "/ch/02/mix/fader");
    assert.equal(r.app.inbox.shift()?.address, "/ch/02/mix/fader");
  } finally {
    r.stop();
  }
});

test("an editor fader move forwards to the app and updates the model", async () => {
  const r = await memRig();
  try {
    r.ed.send("/xremote");
    r.ed.send("/ch/03/mix/fader", oscFloat(0.5));
    await r.net.settle();
    const fwd = r.app.inbox.shift()!;
    assert.equal(fwd.address, "/ch/03/mix/fader");
    assert.deepEqual(fwd.args, [oscFloat(0.5)]);
    r.ed.send("/ch/03/mix/fader");
    await r.net.settle();
    assert.equal(r.ed.inbox.shift()!.args[0]!.v, 0.5);
  } finally {
    r.stop();
  }
});

test("a second editor sees pushes but the sender does not get its own move", async () => {
  const r = await memRig();
  const other = new Peerbox(await r.net.bind(0, "127.0.0.1"));
  other.target = r.ed.target;
  try {
    r.ed.send("/xremote");
    other.send("/xremote");
    await r.net.settle();
    r.ed.send("/ch/05/mix/fader", oscFloat(0.25));
    r.ed.send("/ch/05/mix/on", oscInt(0));
    await r.net.settle();
    assert.equal(r.ed.inbox.length, 0);
    assert.deepEqual(
      other.inbox.map((m) => m.address),
      ["/ch/05/mix/fader", "/ch/05/mix/on"],
    );
    assert.equal(r.desk.mute.get(5), true);
  } finally {
    other.ep.close();
    r.stop();
  }
});

test("unknown requests are logged once for fidelity work", async () => {
  const r = await memRig();
  try {
    r.ed.send("/showdata/blah");
    r.ed.send("/showdata/blah");
    await r.net.settle();
    assert.deepEqual(r.desk.reqLog, ["/showdata/blah"]);
    const lines: string[] = [];
    r.desk.onTrace = (l) => lines.push(l);
    r.ed.send("/node", oscStr("ch/01"));
    r.ed.send("/node", oscStr("ch/01"));
    await r.net.settle();
    assert.deepEqual(lines, ["  [emu] editor asked: /node ch/01"]);
  } finally {
    r.stop();
  }
});

test("unknown GET is answered with a typed default and stays consistent", async () => {
  const r = await memRig();
  try {
    const ask = async (addr: string): Promise<OscMessage> => {
      r.ed.send(addr);
      await r.net.settle();
      return r.ed.inbox.shift()!;
    };
    assert.deepEqual((await ask("/headamp/053/phantom")).args, [oscInt(0)]);
    assert.deepEqual((await ask("/-usb/dir/046/name")).args, [oscStr("")]);
    const g = await ask("/headamp/053/gain");
    assert.deepEqual(g.args, [oscFloat(0)]);
    assert.deepEqual((await ask("/headamp/053/gain")).args, g.args);
  } finally {
    r.stop();
  }
});

test("node containers answer in desk format with minimum token counts", async () => {
  const r = await memRig();
  try {
    const cases: [string, number][] = [
      ["fxrtn/01/mix/13", 3],
      ["fxrtn/01/mix/14", 3],
      ["outputs/rec/01", 3],
      ["outputs/aes/02", 4],
      ["outputs/main/03/delay", 3],
      ["ch/27/eq/3", 5],
      ["auxin/04/eq/1", 5],
      ["ch/10/dyn", 10],
      ["ch/10/gate", 5],
      ["ch/27/dyn/filter", 4],
      ["ch/01/insert", 4],
      ["bus/05/mix/01", 3],
      ["headamp/000", 3],
      ["-libs/ch/100", 6],
      ["-libs/fx/001", 6],
      ["-libs/r/050", 6],
    ];
    for (const [path, min] of cases) {
      r.ed.send("/node", oscStr(path));
      await r.net.settle();
      const m = r.ed.inbox.shift();
      assert.ok(m, `no reply for ${path}`);
      assert.equal(m.address, "node");
      const body = String(m.args[0]!.v);
      assert.ok(body.endsWith("\n"), `${path}: missing newline`);
      const toks = body.split(/\s+/).filter((t) => t.length > 0);
      assert.equal(toks[0], "/" + path);
      assert.ok(toks.length >= min, `${path}: ${JSON.stringify(body)}`);
    }
  } finally {
    r.stop();
  }
});

test("node mix and config reflect live desk state", async () => {
  const r = await memRig();
  try {
    r.ed.send("/ch/03/mix/fader", oscFloat(0.5));
    r.ed.send("/node", oscStr("ch/03/mix"));
    r.ed.send("/node", oscStr("ch/01/config"));
    await r.net.settle();
    assert.ok(String(r.ed.inbox.shift()!.args[0]!.v).includes("-10.0"));
    assert.match(String(r.ed.inbox.shift()!.args[0]!.v), /^\/ch\/01\/config "[^"]*" 1 \w+ 1\n$/);
  } finally {
    r.stop();
  }
});

test("showdump, show-file slots and setlist scene names", async () => {
  const r = await memRig();
  try {
    const ask = async (addr: string, ...args: OscArg[]): Promise<string> => {
      r.ed.send(addr, ...args);
      await r.net.settle();
      return String(r.ed.inbox.shift()!.args[0]!.v);
    };
    assert.ok((await ask("/showdump")).startsWith("/-show/showfile/show "));
    assert.equal(await ask("/node", oscStr("-show/showfile/cue/494")), '/-show/showfile/cue/494 0 "" 0 0 0 0 0 0 0\n');
    assert.equal(
      await ask("/node", oscStr("-show/showfile/scene/099")),
      '/-show/showfile/scene/099 "" "" %000000000 0\n',
    );
    assert.equal(await ask("/node", oscStr("-show/showfile/snippet/000")), '/-show/showfile/snippet/000 "" 0 0 0 0 0\n');
    assert.ok((await ask("/node", oscStr("-show/showfile/show"))).startsWith("/-show/showfile/show "));
    r.desk.sceneNames = new Map([[2, "Bloom"]]);
    assert.equal(
      await ask("/node", oscStr("-show/showfile/scene/002")),
      '/-show/showfile/scene/002 "Bloom" "" %111111111 1\n',
    );
  } finally {
    r.stop();
  }
});

test("without a node table the bare-path and rule fallbacks still answer", async () => {
  const r = await memRig();
  try {
    r.desk.setNodeScn(null);
    r.ed.send("/node", oscStr("ch/27/eq/3"));
    r.ed.send("/node", oscStr("bus/05/mix/01"));
    await r.net.settle();
    assert.equal(r.ed.inbox.shift()!.args[0]!.v, "/ch/27/eq/3\n");
    assert.equal(r.ed.inbox.shift()!.args[0]!.v, "/bus/05/mix/01 ON -oo +0 POST 0\n");
  } finally {
    r.stop();
  }
});

test("editor meter streams: expiry after 10 s, renew keeps alive, unsubscribe", async () => {
  const r = await memRig();
  try {
    r.ed.send("/meters", oscStr("/meters/2"), oscInt(2));
    await r.net.settle();
    await r.clock.advance(0.1);
    await r.net.settle();
    const first = r.ed.inbox.find((m) => m.address === "/meters/2");
    assert.ok(first);
    const blob = first.args[0]!;
    assert.ok(blob.t === "b");
    assert.equal(blob.v.length, 4 + 49 * 4);
    await r.clock.advance(5);
    r.ed.send("/renew");
    await r.net.settle();
    await r.clock.advance(7);
    await r.net.settle();
    assert.equal(r.desk.meterSubs.size, 1);
    await r.clock.advance(5);
    await r.net.settle();
    assert.equal(r.desk.meterSubs.size, 0);
    r.ed.inbox.length = 0;
    await r.clock.advance(1);
    await r.net.settle();
    assert.equal(r.ed.inbox.length, 0);
    r.ed.send("/batchsubscribe", oscStr("meters/0"), oscStr("/meters/0"), oscInt(0), oscInt(0), oscInt(2));
    await r.net.settle();
    assert.equal(r.desk.meterSubs.size, 1);
    r.ed.send("/unsubscribe");
    await r.net.settle();
    assert.equal(r.desk.meterSubs.size, 0);
  } finally {
    r.stop();
  }
});

test("subscribe starts the meter task once and streams n_meters values to the app", async () => {
  const { clock, desk, fake } = bareDesk({ meterHz: 80 });
  assert.equal(desk.meterTaskStarted, false);
  desk.handleSubscribe("/batchsubscribe");
  assert.equal(desk.meterTaskStarted, true);
  desk.handleSubscribe("/batchsubscribe");
  await clock.advance(0.5);
  assert.equal(desk.metersSent, 40);
  const first = fake.sent.find(([a]) => a === "/meters/1");
  assert.ok(first);
  const blob = first[1][0]!;
  assert.ok(blob.t === "b");
  assert.equal(decodeMeterBlob(blob.v).length, 16);
  desk.stop();
  const sent = desk.metersSent;
  await clock.advance(1);
  assert.equal(desk.metersSent, sent);
});

test("handler: fader updates and echoes when subscribed", () => {
  const { desk, fake } = bareDesk();
  desk.subscribed = true;
  desk.handleFader("/ch/04/mix/fader", [oscFloat(0.6)]);
  assert.ok(Math.abs(desk.fader.get(4)! - 0.6) < 1e-9);
  assert.deepEqual(fake.sent.at(-1), ["/ch/04/mix/fader", [oscFloat(0.6)]]);
  assert.equal(desk.echoCount, 1);
});

test("handler: no echo when not subscribed; bad arg and address ignored", () => {
  const { desk, fake } = bareDesk();
  desk.handleFader("/ch/04/mix/fader", [oscFloat(0.6)]);
  assert.deepEqual(fake.sent, []);
  assert.equal(desk.fader.size, 1);
  const other = bareDesk().desk;
  other.handleFader("/ch/04/mix/fader", [oscStr("loud")]);
  other.handleFader("/ch/zz/mix/fader", [oscFloat(0.5)]);
  assert.equal(other.fader.size, 0);
});

test("handler: mute, scene, xremote and default counters", () => {
  const { desk } = bareDesk();
  desk.handleMute("/ch/02/mix/on", [oscInt(0)]);
  assert.equal(desk.mute.get(2), true);
  desk.handleMute("/ch/02/mix/on", [oscInt(1)]);
  assert.equal(desk.mute.get(2), false);
  desk.handleScene("/-action/goscene", [oscInt(5)]);
  assert.equal(desk.scene, 5);
  desk.handleScene("/-action/goscene", [oscStr("x")]);
  assert.equal(desk.scene, 5);
  desk.handleXremote("/xremote");
  assert.equal(desk.subscribed, true);
  const before = desk.recvCount;
  desk.handleDefault("/whatever", [oscInt(1)]);
  assert.equal(desk.recvCount, before + 1);
});

test("extPick skips the measurement mic and handles a meas-only map", () => {
  const savedChannels = C.CHANNELS;
  const savedMeas = C.MEAS_MIC_CH;
  try {
    C.CHANNELS = new Map([[1, "meas_mic"]]);
    C.MEAS_MIC_CH = 1;
    assert.equal(EmulatedDesk.extPick(0), null);
    C.CHANNELS = new Map([
      [1, "meas_mic"],
      [2, "kick"],
      [3, "snare"],
    ]);
    assert.equal(EmulatedDesk.extPick(0), 2);
    assert.equal(EmulatedDesk.extPick(1), 3);
    assert.equal(EmulatedDesk.extPick(2), 2);
  } finally {
    C.CHANNELS = savedChannels;
    C.MEAS_MIC_CH = savedMeas;
  }
  assert.notEqual(EmulatedDesk.extPick(0), null);
});

test("handler: moveFaderExternally updates the model and tells the app", () => {
  const { desk, fake } = bareDesk();
  desk.moveFaderExternally(2, -6.0);
  assert.equal(fake.sent.at(-1)![0], "/ch/02/mix/fader");
  assert.ok(Math.abs(desk.fader.get(2)! - dbToFader(-6.0)) < 1e-12);
});

test("external moves nudge a channel every 12 seconds once subscribed", async () => {
  const r = await memRig({ externalMoves: true });
  try {
    await r.clock.advance(13);
    r.ed.inbox.length = 0;
    r.app.inbox.length = 0;
    r.ed.send("/xremote");
    await r.net.settle();
    await r.clock.advance(12);
    await r.net.settle();
    assert.equal(r.app.inbox.length, 1);
    assert.equal(r.ed.inbox.length, 1);
    assert.equal(r.app.inbox[0]!.address, r.ed.inbox[0]!.address);
    await r.clock.advance(12);
    await r.net.settle();
    assert.equal(r.app.inbox.length, 2);
  } finally {
    r.stop();
  }
});

test("stop closes the socket and halts the loops", async () => {
  const r = await memRig({ externalMoves: true });
  r.ed.send("/batchsubscribe", oscStr("meters/1"), oscStr("/meters/1"), oscInt(0), oscInt(0), oscInt(10));
  await r.net.settle();
  r.desk.stop();
  const port = r.desk.listenPort;
  r.ed.inbox.length = 0;
  await r.clock.advance(30);
  await r.net.settle();
  assert.equal(r.ed.inbox.length, 0);
  assert.equal(r.clock.waiting, 0);
  const again = await r.net.bind(port, "127.0.0.1");
  again.close();
  r.ed.ep.close();
  r.app.ep.close();
});

async function udpRig() {
  const udp: UdpFactory = new NodeUdpFactory();
  const faders: [number, number][] = [];
  const meters: number[][] = [];
  const rx = new MeterReceiver(udp, {
    ip: "127.0.0.1",
    port: 0,
    onFader: (ch, db) => faders.push([ch, db]),
    onMeters: (v) => meters.push(v),
  });
  await rx.start();
  const desk = new EmulatedDesk(udp, new SystemClock(), {
    listenPort: 0,
    listenHost: "127.0.0.1",
    appIp: "127.0.0.1",
    appPort: rx.port,
    meterHz: 40,
    nodeScn: scn,
  });
  await desk.start();
  const peer = { host: "127.0.0.1", port: desk.listenPort };
  const consoleEp = await udp.bind(0, "127.0.0.1");
  const con = new OscConsole({
    send: (d) => consoleEp.send(d, peer),
    close: () => consoleEp.close(),
  });
  const editor = new Peerbox(await udp.bind(0, "127.0.0.1"));
  editor.target = peer;
  const stop = (): void => {
    rx.stop();
    desk.stop();
    con.close();
    editor.ep.close();
  };
  return { faders, meters, rx, desk, con, editor, stop };
}

test("udp: a console command reaches the desk and echoes back to the receiver", async () => {
  const r = await udpRig();
  try {
    r.con.subscribeMeters();
    assert.ok(await waitFor(() => r.desk.subscribed));
    r.con.setFaderRaw(4, -5.0);
    assert.ok(await waitFor(() => r.desk.fader.has(4)));
    assert.ok(Math.abs(r.desk.fader.get(4)! - dbToFader(-5.0)) < 1e-5);
    assert.ok(await waitFor(() => r.faders.some(([ch]) => ch === 4)));
  } finally {
    r.stop();
  }
});

test("udp: the meter stream is decoded by the receiver", async () => {
  const r = await udpRig();
  try {
    r.con.subscribeMeters();
    assert.ok(await waitFor(() => r.meters.length >= 2));
    assert.ok(r.meters.every((v) => v.length === 16));
  } finally {
    r.stop();
  }
});

test("udp: an external move is reconciled", async () => {
  const r = await udpRig();
  try {
    r.con.subscribeMeters();
    assert.ok(await waitFor(() => r.desk.subscribed));
    r.desk.moveFaderExternally(2, -6.0);
    assert.ok(await waitFor(() => r.faders.some(([ch]) => ch === 2)));
    const db = r.faders.filter(([ch]) => ch === 2).at(-1)![1];
    assert.ok(Math.abs(db - -6.0) < 0.3);
  } finally {
    r.stop();
  }
});

test("udp: scene recall round trip", async () => {
  const r = await udpRig();
  try {
    r.con.recallScene(7);
    assert.ok(await waitFor(() => r.desk.scene === 7));
  } finally {
    r.stop();
  }
});

test("udp: an editor discovers, syncs and receives a meter stream", async () => {
  const r = await udpRig();
  try {
    const info = await r.editor.ask("/info");
    assert.equal(info?.address, "/info");
    assert.equal(info?.args.length, 4);
    const node = await r.editor.ask("/node", oscStr("ch/01/config/name"));
    assert.equal(node?.address, "node");
    r.editor.send("/meters", oscStr("/meters/2"), oscInt(2));
    assert.ok(await waitFor(() => r.editor.inbox.some((m) => m.address === "/meters/2")));
    const m = r.editor.inbox.find((x) => x.address === "/meters/2")!;
    assert.ok(m.args[0]!.t === "b" && m.args[0]!.v.length === 4 + 49 * 4);
  } finally {
    r.stop();
  }
});

test("udp: console moves reach the desk model and a subscribed editor", async () => {
  const r = await udpRig();
  try {
    r.editor.send("/xremote");
    assert.ok(await waitFor(() => r.desk.remotes.size === 1));
    r.con.setFaderDb(1, -3.0);
    r.con.setChannelMute(6, true);
    r.con.setChannelMute(7, false);
    assert.ok(await waitFor(() => r.desk.fader.has(1) && r.desk.mute.get(6) === true && r.desk.mute.get(7) === false));
    assert.ok(await waitFor(() => r.editor.inbox.length >= 3));
    assert.ok(r.desk.recvCount > 0);
  } finally {
    r.stop();
  }
});
