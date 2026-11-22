import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK = join(tmpdir(), "trio-emulator-ports.lock");
const STALE_MS = 180000;
const WAIT_MS = 150000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function take(): boolean {
  try {
    mkdirSync(LOCK);
    return true;
  } catch {
    try {
      if (Date.now() - statSync(LOCK).mtimeMs > STALE_MS) rmSync(LOCK, { recursive: true, force: true });
    } catch {
      return false;
    }
    return false;
  }
}

export async function withEmulatorPorts<T>(body: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  while (!take()) {
    if (Date.now() > deadline) throw new Error("another test held the emulator's ports for too long");
    await sleep(200);
  }
  try {
    return await body();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}
