import assert from "node:assert/strict";
import test from "node:test";
import { dbToFader, OscConsole } from "../src/core/console.ts";
import { EmulatedDesk } from "../src/core/emulator.ts";
import { SystemClock } from "../src/host/clock.ts";
import { animate, oneShot, waveDb } from "../src/host/oscdemo.ts";
import { UdpSink } from "../src/host/udpsink.ts";
import { NodeUdpFactory } from "../src/host/udp.ts";
import type { NodeUdpEndpoint } from "../src/host/udp.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function withDesk(run: (con: OscConsole, desk: EmulatedDesk) => Promise<void>): Promise<void> {
  const clock = new SystemClock();
  const desk = new EmulatedDesk(new NodeUdpFactory(), clock, { listenPort: 0, listenHost: "127.0.0.1", appIp: "127.0.0.1", appPort: 9 });
  await desk.start();
  const con = new OscConsole(new UdpSink("127.0.0.1", desk.listenPort), { clock });
  try {
    await run(con, desk);
  } finally {
    con.close();
    desk.stop();
  }
}

test("the one-shot moves reach the desk over the socket", async () => {
  await withDesk(async (con, desk) => {
    const lines: string[] = [];
    oneShot(con, (l) => lines.push(l));
    await sleep(300);
    assert.ok(desk.fader.has(1));
    assert.equal(desk.fader.get(4), dbToFader(-20));
    assert.equal(desk.fader.get(5), dbToFader(-40));
    assert.equal(desk.mute.get(6), true);
    assert.equal(desk.mute.get(7), false);
    assert.ok(desk.params.has("/ch/08/eq/1/f"));
    assert.ok(desk.recvCount > 0);
    assert.equal(lines[0], "Pushing a known set — read these back off your mixer app:");
    assert.ok(lines.includes("  ch2 fader -> +5.0 dB"));
    assert.ok(lines.includes("  ch5 fader -> -40.0 dB"));
  });
});

test("one animation pass sends every channel in range", async () => {
  await withDesk(async (con, desk) => {
    for (let ch = 1; ch <= 8; ch++) {
      const db = waveDb(0.3, ch);
      assert.ok(db >= -8.0 && db <= 3.0);
      con.setFaderDb(ch, db);
    }
    await sleep(250);
    assert.ok(desk.fader.size >= 8);
  });
});

test("animate keeps sending until it is told to stop", async () => {
  await withDesk(async (con, desk) => {
    const signal = { aborted: false };
    const lines: string[] = [];
    const run = animate(con, new SystemClock(), 4, signal, (l) => lines.push(l));
    await sleep(300);
    signal.aborted = true;
    await run;
    assert.ok(desk.fader.size >= 4);
    assert.ok(desk.recvCount > 4);
    assert.match(lines[0]!, /Animating 4 faders/);
  });
});

test("a handler that throws does not escape into the socket event", async () => {
  const udp = new NodeUdpFactory();
  const rx = (await udp.bind(0, "127.0.0.1")) as NodeUdpEndpoint;
  const tx = await udp.bind(0, "127.0.0.1");
  try {
    rx.onMessage(() => {
      throw new Error("handler blew up");
    });
    tx.send(Uint8Array.of(1, 2, 3), { host: "127.0.0.1", port: rx.port });
    for (let i = 0; i < 100 && rx.failures === 0; i++) await sleep(10);
    assert.equal(rx.failures, 1);
    assert.match(String((rx.lastError as Error).message), /handler blew up/);
  } finally {
    rx.close();
    tx.close();
  }
});

test("a failed send is recorded on the endpoint and does not throw", async () => {
  const ep = (await new NodeUdpFactory().bind(0, "127.0.0.1")) as NodeUdpEndpoint;
  try {
    assert.equal(ep.failures, 0);
    assert.doesNotThrow(() => ep.send(new Uint8Array(70000), { host: "127.0.0.1", port: 9 }));
    for (let i = 0; i < 100 && ep.failures === 0; i++) await sleep(10);
    assert.ok(ep.failures >= 1);
    assert.ok(ep.lastError instanceof Error);
  } finally {
    ep.close();
  }
});

test("a failed sink send is recorded and does not throw", async () => {
  const sink = new UdpSink("127.0.0.1", 9);
  try {
    assert.equal(sink.failures, 0);
    assert.doesNotThrow(() => sink.send(new Uint8Array(70000)));
    for (let i = 0; i < 100 && sink.failures === 0; i++) await sleep(10);
    assert.ok(sink.failures >= 1);
    assert.ok(sink.lastError instanceof Error);
  } finally {
    sink.close();
  }
});

test("the demo command rejects a channel count outside 1 to 32", async () => {
  const { main } = await import("../src/host/oscdemo-cli.ts");
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    errors.push(a);
  };
  try {
    for (const bad of ["0", "33", "abc", "1.5", "-2", ""]) {
      assert.equal(await main(["--animate", `--channels=${bad}`]), 2, bad);
    }
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 6);
});
