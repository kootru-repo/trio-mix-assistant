import assert from "node:assert/strict";
import test from "node:test";
import { ManualClock } from "../src/core/clock.ts";
import { defaultConfig } from "../src/core/config.ts";
import { EmulatedDesk } from "../src/core/emulator.ts";
import { Engine } from "../src/core/engine/index.ts";
import { MemNetwork } from "../src/core/memtransport.ts";
import { MeterReceiver } from "../src/core/metersrv.ts";
import { decodeMeterBlob, decodePacket, encodeMessage, oscBlob, oscFloat, oscInt, oscStr } from "../src/core/oscwire.ts";
import type { OscArg } from "../src/core/oscwire.ts";
import { AbleSetReceiver } from "../src/core/showclock.ts";
import type { ShowState } from "../src/core/showclock.ts";
import { TemplateError, fromObject } from "../src/core/template.ts";
import { checkConf } from "../src/host/launcher.ts";
import { BadMessage, decodeUtf8, strictLoads } from "../src/host/server/json.ts";
import { WS_MAX_FRAME, WsAssembler, WsParser } from "../src/host/server/ws.ts";
import { property } from "./fuzzkit.ts";
import type { Gen } from "./fuzzkit.ts";

const cfg = defaultConfig();
const asBytes = (v: unknown): Uint8Array => Uint8Array.from(Array.isArray(v) ? v.map((x) => Number(x) & 255) : []);

const ADDRS = [
  "/ch/01/mix/fader",
  "/ch/32/mix/fader",
  "/ch/00/mix/fader",
  "/ch/33/mix/fader",
  "/ch/-1/mix/fader",
  "/ch/4000/mix/fader",
  "/meters/1",
  "/xinfo",
  "/node",
  "/info",
  "/ch/05/mix/on",
  "/-snap/load",
  "/xremote",
  "/status",
  "/x",
];
const argOf = (g: Gen): OscArg => {
  const k = g.int(4);
  if (k === 0) return oscInt(g.int(2 ** 31) - 2 ** 30);
  if (k === 1) return oscFloat(g.float());
  if (k === 2) return oscStr(g.pick(["0.5", "nan", "inf", "-inf", "1e9", "abc", "", "0"]));
  return oscBlob(Uint8Array.from(g.bytes(40)));
};
const packetOf = (g: Gen): number[] =>
  g.chance(0.5)
    ? g.bytes(80)
    : Array.from(
        encodeMessage(
          g.pick(ADDRS),
          Array.from({ length: g.int(4) }, () => argOf(g)),
        ),
      );

test("OSC decoding never throws on any bytes, and meter blobs give at most what they hold", () => {
  property(
    "osc-decode",
    (g) => g.bytes(96),
    (v) => {
      const b = asBytes(v);
      for (const m of decodePacket(b)) assert.equal(typeof m.address, "string");
      assert.ok(decodeMeterBlob(b).length <= Math.max(0, Math.floor((b.length - 4) / 4)));
    },
  );
});

test("OSC messages survive an encode and decode round trip", () => {
  property(
    "osc-roundtrip",
    (g) => ({
      address: g.pick(ADDRS),
      ints: Array.from({ length: g.int(4) }, () => g.int(2 ** 31) - 2 ** 30),
      text: g.text(10).replace(/\0/g, ""),
    }),
    (v) => {
      const o = v as { address: string; ints: number[]; text: string };
      const [m] = decodePacket(encodeMessage(o.address, [...o.ints.map(oscInt), oscStr(o.text)]));
      assert.equal(m?.address, o.address);
      assert.deepEqual(
        m?.args.slice(0, -1).map((a) => a.v),
        o.ints,
      );
      assert.equal(m?.args.at(-1)?.v, o.text);
    },
  );
});

test("the meter receiver passes on only real channels and finite fader levels", () => {
  property(
    "meter-receiver",
    (g) => Array.from({ length: 1 + g.int(4) }, () => packetOf(g)),
    (v) => {
      const rx = new MeterReceiver(new MemNetwork(), { cfg });
      rx.running = true;
      const heard: [number, number][] = [];
      rx.onFader = (ch, db) => heard.push([ch, db]);
      for (const p of v as unknown[]) rx.dispatch(asBytes(p));
      for (const [ch, db] of heard) {
        assert.ok(Number.isInteger(ch) && ch >= 1 && ch <= 32, `channel ${ch}`);
        assert.ok(Number.isFinite(db), `level ${db}`);
      }
    },
  );
});

test("AbleSet input never leaves a song index or tempo that is not a finite number", () => {
  const SHOW = [
    "/setlist/activeSongName",
    "/setlist/activeSongIndex",
    "/setlist/nextSongName",
    "/song/sectionName",
    "/playback/isPlaying",
    "/song/beatsPerMinute",
  ];
  property(
    "ableset",
    (g) => Array.from({ length: 1 + g.int(6) }, () => [g.pick(SHOW), g.float(), g.text(8)]),
    (v) => {
      const r = new AbleSetReceiver(new MemNetwork(), cfg);
      Reflect.set(r, "running", true);
      const finite = (): void => {
        const s = Reflect.get(r, "cur") as ShowState;
        for (const n of [s.songIndex, s.bpm]) assert.ok(n === null || Number.isFinite(n), `got ${n}`);
      };
      for (const step of v as [string, number, string][]) {
        r.handle(step[0], [oscFloat(Number(step[1])), oscStr(String(step[2]))]);
        finite();
        r.handle(step[0], [oscStr(String(step[2]))]);
        finite();
      }
    },
  );
});

test("the emulator answers any request without throwing", () => {
  property(
    "emulator",
    (g) => Array.from({ length: 1 + g.int(5) }, () => ({ addr: g.pick(ADDRS), args: Array.from({ length: g.int(3) }, () => argOf(g)) })),
    (v) => {
      const desk = new EmulatedDesk(new MemNetwork(), new ManualClock(0, 1_700_000_000), { cfg, listenPort: 0 });
      for (const m of v as { addr: string; args: OscArg[] }[]) {
        const args = m.args.map((a) => (a.t === "b" && !(a.v instanceof Uint8Array) ? oscBlob(asBytes(Object.values(a.v))) : a));
        desk.handleAny({ host: "127.0.0.1", port: 10024 }, m.addr, args);
      }
    },
  );
});

test("engine commands from the dashboard never throw, whatever they hold", () => {
  const TYPES = [
    "balance_capture",
    "calibrate",
    "coach",
    "diagnose",
    "eq",
    "eq_reset",
    "fader",
    "fx",
    "lead_target",
    "master",
    "mute",
    "panic",
    "reset_notches",
    "scene",
    "send",
    "toggle",
    "vet",
    "nope",
  ];
  const engine = new Engine({ sim: true, clock: new ManualClock(100, 1_700_000_000), cfg: defaultConfig() });
  property(
    "engine-command",
    (g) => {
      const o = g.json(2);
      const extra = typeof o === "object" && o !== null && !Array.isArray(o) ? o : {};
      return {
        ...extra,
        type: g.pick(TYPES),
        ch: g.chance(0.5) ? g.int(40) - 4 : g.float(),
        db: g.float(),
        index: g.int(200) - 20,
        job: g.text(6),
        value: g.json(1),
      };
    },
    (v) => {
      engine.command(v);
    },
  );
});

test("WebSocket frames: any bytes give a frame, a close code or a wait, and memory stays bounded", () => {
  property(
    "websocket",
    (g) =>
      Array.from({ length: 1 + g.int(4) }, () =>
        g.chance(0.3)
          ? [g.pick([0x81, 0x82, 0x01, 0x80, 0x88, 0x89, 0x8a, 0x8f]), 0x80 | g.pick([0, 5, 125, 126, 127]), ...g.bytes(20)]
          : g.bytes(30),
      ),
    (v) => {
      const p = new WsParser();
      const a = new WsAssembler();
      for (const chunk of v as unknown[]) {
        p.push(Buffer.from(asBytes(chunk)));
        for (let n = 0; n < 50; n++) {
          const f = p.next();
          if (f === null || "close" in f) break;
          assert.ok(f.payload.length <= WS_MAX_FRAME);
          const m = a.accept(f);
          if (m !== null && "close" in m) break;
        }
      }
    },
  );
});

test("the dashboard's JSON and text decoding refuse bad input with BadMessage only", () => {
  property(
    "json-text",
    (g) => (g.chance(0.5) ? g.text(40) : JSON.stringify(g.json(3)).slice(0, g.int(60))),
    (v) => {
      try {
        strictLoads(String(v));
        decodeUtf8(Buffer.from(String(v), "latin1"));
      } catch (e) {
        if (!(e instanceof BadMessage)) throw e;
      }
    },
  );
});

test("templates: any JSON is loaded or refused with a TemplateError, never anything else", () => {
  property(
    "template",
    (g) =>
      g.chance(0.5)
        ? g.json(4)
        : {
            name: g.text(6),
            songs: [g.json(2), { name: g.text(5), balance: g.json(1), scene: g.json(0) }],
            channels: g.json(2),
            tuning: g.json(2),
            version: g.json(0),
          },
    (v) => {
      try {
        const t = fromObject(v, defaultConfig());
        for (const s of t.songs) for (const ch of s.balance.keys()) assert.ok(ch >= 1 && ch <= 32, `balance channel ${ch}`);
      } catch (e) {
        if (!(e instanceof TemplateError)) throw e;
      }
    },
  );
});

test("show.conf: any text is read without throwing, and every key read is upper case", () => {
  property(
    "show-conf",
    (g) => g.text(120),
    (v) => {
      const r = checkConf(String(v));
      for (const k of Object.keys(r.conf)) assert.equal(k, k.toUpperCase());
      assert.ok(r.version >= 1);
    },
  );
});
