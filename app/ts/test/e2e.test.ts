import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

const main = fileURLToPath(new URL("../src/host/main.ts", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

interface Running {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
  stop: () => Promise<number | null>;
}

function launch(args: string[]): Promise<Running> {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", main, ...args], {
    env: { ...process.env },
  });
  let text = "";
  const collect = (b: Buffer): void => {
    text += b.toString("utf8");
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const stop = (): Promise<number | null> =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      child.once("exit", (code) => resolve(code));
      child.kill("SIGINT");
      setTimeout(() => child.kill(), 8000).unref();
    });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("did not start:\n" + text));
    }, 30000);
    const poll = setInterval(() => {
      if (text.includes("Press Ctrl+C")) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve({ child, output: () => text, stop });
      } else if (child.exitCode !== null) {
        clearInterval(poll);
        clearTimeout(timer);
        reject(new Error("exited early:\n" + text));
      }
    }, 100);
  });
}

async function get(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const r = await fetch(base + path, init);
  return { status: r.status, body: await r.text() };
}

test("the simulation starts, serves the dashboard and state, and guards control POSTs", async () => {
  const port = await freePort();
  const app = await launch(["--port", String(port), "--session-db", "off"]);
  try {
    const base = `http://127.0.0.1:${port}`;
    const state = await get(base, "/state");
    assert.equal(state.status, 200);
    const snap = JSON.parse(state.body);
    assert.equal(snap.mode, "simulation");
    assert.ok(snap.channels.length > 0);
    const page = await get(base, "/");
    assert.equal(page.status, 200);
    assert.ok(page.body.includes("/dashboard.js"));
    assert.equal((await get(base, "/dashboard.js")).status, 200);
    const payload = JSON.stringify({ on: true });
    const cross = await get(base, "/api/panic", { method: "POST", body: payload, headers: { Origin: "https://evil.example", "Content-Type": "text/plain" } });
    assert.equal(cross.status, 403);
    const same = await get(base, "/api/panic", { method: "POST", body: payload, headers: { Origin: base, "Content-Type": "application/json" } });
    assert.equal(same.status, 200);
    assert.equal(JSON.parse(same.body).status, "takeover");
    await new Promise((r) => setTimeout(r, 1000));
    const after = JSON.parse((await get(base, "/state")).body);
    assert.deepEqual(
      after.log.filter((e: { msg: string }) => e.msg.includes("engine error")),
      [],
    );
  } finally {
    await app.stop();
  }
  assert.ok(app.output().includes("SIMULATION"));
});

test("a PIN protects the dashboard", async () => {
  const port = await freePort();
  const app = await launch(["--port", String(port), "--session-db", "off", "--pin", "4242"]);
  try {
    const base = `http://127.0.0.1:${port}`;
    const denied = await get(base, "/state");
    assert.ok(denied.status === 401 || denied.status === 403, `status ${denied.status}`);
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ pin: "4242" }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    assert.ok(cookie.length > 0);
    const ok = await get(base, "/state", { headers: { Cookie: cookie } });
    assert.equal(ok.status, 200);
  } finally {
    await app.stop();
  }
});

test("the emulated hardware stack runs end to end over real sockets", async () => {
  const port = await freePort();
  const app = await launch(["--emulate", "--port", String(port), "--session-db", "off", "--no-show-clock"]);
  try {
    const base = `http://127.0.0.1:${port}`;
    let snap: any = null;
    for (let i = 0; i < 40; i++) {
      snap = JSON.parse((await get(base, "/state")).body);
      if (snap.console.connected) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(snap.mode, "live-hardware");
    assert.equal(snap.capture.kind, "audio");
    assert.ok(snap.console.connected, "meters from the emulated desk arrived");
    assert.ok(snap.channels.length > 0);
  } finally {
    await app.stop();
  }
  assert.ok(app.output().includes("EMULATED-HARDWARE"));
});

test("bad arguments exit with a usage message", async () => {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", main, "--port", "abc"]);
  let text = "";
  child.stdout.on("data", (b: Buffer) => (text += b.toString("utf8")));
  child.stderr.on("data", (b: Buffer) => (text += b.toString("utf8")));
  const code: number | null = await new Promise((r) => child.once("exit", (c) => r(c)));
  assert.equal(code, 2);
  assert.match(text, /invalid int value/);
});
