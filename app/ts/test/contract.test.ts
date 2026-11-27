import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "../src/core/config.ts";
import { DOC_ADDRESS, RecordingUdpFactory, buildFixture, compareShapes, parseFixture, toOscArgs } from "../src/core/contract.ts";
import { MemNetwork } from "../src/core/memtransport.ts";
import { MeterReceiver } from "../src/core/metersrv.ts";
import { decodePacket, decodeReply, encodeMessage, oscFloat, oscStr } from "../src/core/oscwire.ts";
import { PROBE_STEP, emulatorFixture } from "./contractrig.ts";

const DIR = join(import.meta.dirname, "..", "fixtures", "contract");
const fixtures = (): string[] => readdirSync(DIR).filter((f) => f.endsWith(".json"));

test("the recorder keeps what was sent and heard, per step, and caps the meter stream", async () => {
  const net = new MemNetwork();
  const rec = new RecordingUdpFactory(net);
  const a = await rec.bind(0, "127.0.0.1");
  const b = await net.bind(0, "127.0.0.1");
  a.onMessage(() => undefined);
  rec.step = "one";
  a.send(encodeMessage("/info", []), { host: "127.0.0.1", port: b.port });
  rec.step = "two";
  for (let i = 0; i < 20; i++) b.send(encodeMessage("/meters/1", [oscStr("x")]), { host: "127.0.0.1", port: a.port });
  await net.settle();
  assert.deepEqual(
    rec.exchanges.map((x) => `${x.step} ${x.dir}`),
    ["one out", ...Array.from({ length: 5 }, () => "two in")],
  );
  a.close();
  b.close();
});

test("the fixture scrubber hides addresses and names and keeps the model and firmware", () => {
  const reply = (address: string, ...s: string[]): Uint8Array => encodeMessage(address, s.map(oscStr));
  const f = buildFixture(
    [
      { step: "s", dir: "in", bytes: reply("/info", "V2.07", "Sunday Desk", "X32C", "4.06-8") },
      { step: "s", dir: "in", bytes: reply("/xinfo", "192.168.1.62", "Sunday Desk", "X32C", "4.06-8") },
      { step: "s", dir: "in", bytes: reply("/status", "active", "192.168.1.62", "Sunday Desk") },
      { step: "s", dir: "in", bytes: reply("/ch/01/config/name", "Pastor Mic") },
      { step: "s", dir: "in", bytes: reply("node", '/-show/showfile/show "Easter 2026" 0 0 "4.06-8"\n') },
    ],
    "console",
  );
  assert.equal(f.model, "X32C");
  assert.equal(f.firmware, "4.06-8");
  const text = JSON.stringify(f);
  for (const gone of ["Sunday Desk", "192.168.1.62", "Pastor Mic", "Easter 2026"]) assert.ok(!text.includes(gone), `${gone} survived`);
  assert.ok(text.includes(DOC_ADDRESS));
});

test("the committed synthetic fixture matches what the emulator answers now, step for step", async () => {
  const names = fixtures();
  assert.ok(names.includes("emulator-synthetic.json"), "the recorder's own fixture is committed");
  const now = await emulatorFixture();
  const saved = parseFixture(readFileSync(join(DIR, "emulator-synthetic.json"), "utf8"));
  assert.deepEqual(compareShapes(saved, now, PROBE_STEP), []);
  assert.ok(
    saved.steps.some((s) => s.messages.some((m) => m.dir === "in" && m.address === "/info")),
    "the console answered /info",
  );
});

test("every recorded fixture: the emulator gives the same kinds of answer, apart from the listed known differences", async () => {
  const now = await emulatorFixture();
  for (const n of fixtures()) {
    const f = parseFixture(readFileSync(join(DIR, n), "utf8"));
    const step = f.steps.find((s) => s.step === PROBE_STEP);
    if (step === undefined) continue;
    assert.deepEqual(compareShapes(f, now, PROBE_STEP), [], `${n} (${f.source} ${f.model} ${f.firmware})`);
  }
});

test("every recorded answer is one the app can read: replies decode, fader replies give a finite level", () => {
  for (const n of fixtures()) {
    const f = parseFixture(readFileSync(join(DIR, n), "utf8"));
    const rx = new MeterReceiver(new MemNetwork(), { cfg: defaultConfig() });
    rx.running = true;
    const levels: number[] = [];
    rx.onFader = (_ch, db) => levels.push(db);
    for (const s of f.steps)
      for (const m of s.messages.filter((x) => x.dir === "in")) {
        const bytes = encodeMessage(m.address, toOscArgs(m.args));
        const back = decodeReply(bytes) ?? decodePacket(bytes)[0] ?? null;
        assert.ok(back !== null, `${n}: ${m.address} does not decode`);
        rx.dispatch(bytes);
      }
    assert.ok(
      levels.every((x) => Number.isFinite(x)),
      `${n}: ${levels.join(", ")}`,
    );
  }
  assert.ok(decodeReply(encodeMessage("/ch/01/mix/fader", [oscFloat(0.75)])) !== null);
});
