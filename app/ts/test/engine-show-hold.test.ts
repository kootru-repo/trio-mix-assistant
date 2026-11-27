import assert from "node:assert/strict";
import test from "node:test";
import { CaptureSourceBase } from "../src/core/capture.ts";
import type { Frame } from "../src/core/capture.ts";
import type { AnalysedBlock } from "../src/core/blockanalysis.ts";
import { emptyFeatures } from "../src/core/dsp.ts";
import { configWith, defaultConfig } from "../src/core/config.ts";
import type { Config } from "../src/core/config.ts";
import { SimConsole, dbToFader, faderToDb } from "../src/core/console.ts";
import { Engine } from "../src/core/engine/index.ts";
import { oscFloat, oscInt } from "../src/core/oscwire.ts";
import type { OscArg } from "../src/core/oscwire.ts";
import type { MeterReceiverPort } from "../src/core/ports.ts";
import { newShowState } from "../src/core/showclock.ts";
import type { ShowState } from "../src/core/showclock.ts";
import type { Lane } from "../src/core/writegov.ts";
import { StepClock } from "./stepclock.ts";

const GUEST = 7;
const plainCfg = defaultConfig();
const guestCfg = configWith({ GUEST_CHANNELS: [GUEST] });

interface Wire {
  lane: Lane;
  addr: string;
  args: OscArg[];
}

class LaneConsole extends SimConsole {
  readonly wires: Wire[] = [];
  protected override send(addr: string, ...args: OscArg[]): void {
    this.wires.push({ lane: this.lane, addr, args });
    super.send(addr, ...args);
  }
}

class QuietSource extends CaptureSourceBase {
  block(): Frame {
    return new Map();
  }
}

interface Rig {
  e: Engine;
  clock: StepClock;
  con: LaneConsole;
  cfg: Config;
}

const FADER = /^\/ch\/(\d\d)\/mix\/fader$/;
const GAIN = /^\/headamp\/(\d\d\d)\/gain$/;
const INVERT = /^\/ch\/(\d\d)\/preamp\/invert$/;
const SCENE = "/-action/goscene";
const MUTE = `/ch/${String(GUEST).padStart(2, "0")}/mix/on`;

const isRead = (w: Wire): boolean => w.args.length === 0 && (FADER.test(w.addr) || GAIN.test(w.addr) || INVERT.test(w.addr));

const quietReceiver = (): MeterReceiverPort => ({ start: () => Promise.resolve(), stop: () => undefined });

const makeRig = async (cfg: Config = plainCfg): Promise<Rig> => {
  const clock = new StepClock(100, 1_700_000_000);
  const con = new LaneConsole({ cfg });
  const e = new Engine({ cfg, clock, sim: false, console: con, source: new QuietSource(), tick: 0.05 });
  e.meterRx = quietReceiver();
  await e.start();
  return { e, clock, con, cfg };
};

const reply = (e: Engine, address: string): void => {
  e.consoleHeard();
  const f = FADER.exec(address);
  if (f !== null) {
    const pos = dbToFader(-10);
    e.consoleParam(address, [oscFloat(pos)]);
    e.reconcileFader(Number(f[1]), faderToDb(pos));
    return;
  }
  if (GAIN.test(address)) {
    e.consoleParam(address, [oscFloat((35 + 12) / 72)]);
    return;
  }
  if (INVERT.test(address)) e.consoleParam(address, [oscInt(0)]);
};

const answerReads = (r: Rig, from: number): number => {
  const asked = [
    ...new Set(
      r.con.wires
        .slice(from)
        .filter(isRead)
        .map((w) => w.addr),
    ),
  ];
  for (const a of asked) reply(r.e, a);
  return asked.length;
};

const drive = async (r: Rig, seconds: number, heard: boolean): Promise<void> => {
  const n = Math.round(seconds / 0.1);
  for (let i = 0; i < n; i++) {
    if (heard) r.e.consoleHeard();
    await r.clock.advance(0.1);
  }
};

const rearms = (e: Engine): number => e.events.filter((ev) => ev.msg.startsWith("automatic jobs re-armed")).length;

const rearm = async (r: Rig, from: number): Promise<void> => {
  const before = rearms(r.e);
  await drive(r, 1.3, true);
  answerReads(r, from);
  await drive(r, 0.2, true);
  assert.equal(rearms(r.e), before + 1);
};

const armedRig = async (cfg: Config = plainCfg): Promise<Rig> => {
  const r = await makeRig(cfg);
  assert.ok(answerReads(r, 0) > 0);
  await drive(r, 1.3, true);
  assert.equal(r.e.held, false);
  return r;
};

const song = (name: string): ShowState => ({ ...newShowState(), songName: name, playing: true });

const sent = (r: Rig, addr: string, from = 0): Wire[] => r.con.wires.slice(from).filter((w) => w.addr === addr && w.args.length > 0);

const sceneArgs = (r: Rig, from = 0): number[] =>
  sent(r, SCENE, from).map((w) => {
    const a = w.args[0];
    assert.ok(a !== undefined && a.t === "i");
    return a.v;
  });

const msgs = (e: Engine): string[] => e.events.map((ev) => ev.msg);

const noErrors = (e: Engine): void => {
  assert.deepEqual(
    msgs(e).filter((m) => m.startsWith("engine error")),
    [],
  );
};

test("a song change while held for unsynced sends no scene recall, and the scene is recalled once after the jobs re-arm", async () => {
  const r = await makeRig();
  try {
    assert.deepEqual(r.e.snapshot()["hold"], { held: true, reasons: ["unsynced"] });
    r.e.onSongChange(song("Gravity"));
    assert.deepEqual(sceneArgs(r), []);
    assert.equal(r.e.show.current, "Gravity");
    assert.equal(r.e.show.scene, null);
    assert.ok(msgs(r.e).some((m) => m.startsWith("song: Gravity") && m.includes("held back")));
    assert.equal(r.e.assistant.leadTarget, -6.0);
    r.e.onSongChange({ ...song("Gravity"), section: "Chorus" });
    assert.equal(r.e.show.scene, null);
    await rearm(r, 0);
    assert.deepEqual(sceneArgs(r), [1]);
    const recall = r.con.wires.findIndex((w) => w.addr === SCENE);
    assert.equal(r.con.wires[recall]?.lane, "manual");
    assert.equal(r.e.show.scene, 1);
    assert.deepEqual(r.e.snapshot()["hold"], { held: true, reasons: ["unsynced"] });
    assert.ok(r.con.wires.slice(recall).some(isRead));
    await rearm(r, recall);
    await drive(r, 1.0, true);
    assert.deepEqual(sceneArgs(r), [1]);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("a song change while held for link sends no scene recall, and only the current song's scene is recalled on re-arm", async () => {
  const r = await armedRig();
  try {
    await drive(r, 1.7, false);
    assert.ok((r.e.snapshot()["hold"] as { reasons: string[] }).reasons.includes("link"));
    const from = r.con.wires.length;
    r.e.onSongChange(song("Gravity"));
    r.e.onSongChange(song("Bloom"));
    assert.deepEqual(sceneArgs(r, from), []);
    await rearm(r, from);
    assert.deepEqual(sceneArgs(r, from), [2]);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("guest mutes wait while held and go out after the scene recall on re-arm, before the desk is read", async () => {
  const r = await makeRig(guestCfg);
  try {
    r.e.onSongChange(song("Gravity"));
    assert.deepEqual(sent(r, MUTE), []);
    assert.equal(r.e.muted.get(GUEST), false);
    await rearm(r, 0);
    const recall = r.con.wires.findIndex((w) => w.addr === SCENE);
    const mute = r.con.wires.findIndex((w) => w.addr === MUTE && w.args.length > 0);
    const read = r.con.wires.findIndex((w, i) => i > recall && isRead(w));
    assert.ok(recall >= 0 && mute > recall && read > mute, `recall ${recall}, mute ${mute}, read ${read}`);
    assert.equal(r.e.muted.get(GUEST), true);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("an armed song change recalls the scene, then mutes the guest, then reads the desk", async () => {
  const r = await armedRig(guestCfg);
  try {
    const from = r.con.wires.length;
    r.e.onSongChange(song("Gravity"));
    const ws = r.con.wires.slice(from);
    const recall = ws.findIndex((w) => w.addr === SCENE);
    const mute = ws.findIndex((w) => w.addr === MUTE && w.args.length > 0);
    const read = ws.findIndex(isRead);
    assert.ok(recall >= 0 && mute > recall && read > mute, `recall ${recall}, mute ${mute}, read ${read}`);
    assert.deepEqual(r.e.snapshot()["hold"], { held: true, reasons: ["unsynced"] });
    assert.equal(r.e.show.scene, 1);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("TAKEOVER pressed while a song is held back drops it, so re-arming recalls nothing", async () => {
  const r = await makeRig(guestCfg);
  try {
    r.e.onSongChange(song("Gravity"));
    r.e.panic(true);
    r.e.panic(false);
    await rearm(r, 0);
    await drive(r, 1.0, true);
    assert.deepEqual(sceneArgs(r), []);
    assert.deepEqual(sent(r, MUTE), []);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("a song that is no longer current is not recalled on re-arm", async () => {
  const r = await makeRig();
  try {
    r.e.onSongChange(song("Gravity"));
    r.e.onSongChange(song("Not In The Template"));
    await rearm(r, 0);
    await drive(r, 1.0, true);
    assert.deepEqual(sceneArgs(r), []);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

test("an operator scene recall while held goes out at once, starts a desk read, and replaces the held-back song", async () => {
  const r = await makeRig();
  try {
    r.e.onSongChange(song("Gravity"));
    const from = r.con.wires.length;
    r.e.recallSceneManual(3);
    assert.deepEqual(sceneArgs(r, from), [3]);
    assert.ok(r.con.wires.slice(from).some(isRead));
    assert.equal(r.e.show.scene, 3);
    await rearm(r, from);
    await drive(r, 1.0, true);
    assert.deepEqual(sceneArgs(r), [3]);
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});

const loudLead = (): AnalysedBlock => ({
  feats: new Map([[1, { ...emptyFeatures(), rmsDbfs: -10, peakDbfs: -8 }]]),
  phases: [],
});

test("the re-arm EQ flatten skips a channel locked by hand moves and still flattens the others on the auto lane", async () => {
  const r = await armedRig();
  try {
    r.e.setEnabled("unmask", true);
    for (let i = 0; i < 10; i++) r.e.onPushedBlock(loudLead(), 0);
    assert.ok(r.e.assistant.duckApplied.has(2) && r.e.assistant.duckApplied.has(3));
    for (let i = 0; i < plainCfg.safety.lockMoves; i++) {
      r.e.consoleHeard();
      r.e.reconcileFader(2, -20 - 3 * i);
    }
    assert.ok(r.e.channelLocked(2));
    await drive(r, 1.7, false);
    assert.equal(r.e.held, true);
    const from = r.con.wires.length;
    await rearm(r, from);
    const eq = (ch: number): Wire[] => r.con.wires.slice(from).filter((w) => w.addr.startsWith(`/ch/0${ch}/eq/`) && w.args.length > 0);
    assert.deepEqual(eq(2), []);
    const flat = eq(3);
    assert.ok(flat.length > 0, "ch3 was not flattened");
    assert.ok(flat.every((w) => w.lane === "auto"));
    noErrors(r.e);
  } finally {
    await r.e.stop();
  }
});
