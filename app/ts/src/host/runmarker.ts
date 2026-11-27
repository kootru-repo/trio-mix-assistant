import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Clock } from "../core/clock.ts";
import type { ConsoleBase } from "../core/console.ts";
import { RunLedger, parseRunRecord, uncleanBanner } from "../core/runledger.ts";

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
}

export class RunMarker {
  private readonly path: string;
  private readonly ledger: RunLedger;
  private readonly alive: (pid: number) => boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  lastError: unknown = null;

  constructor(path: string, clock: Clock, pid: number = process.pid, alive: (pid: number) => boolean = pidAlive) {
    this.path = path;
    this.alive = alive;
    this.ledger = new RunLedger(new Date(clock.time() * 1000).toISOString().replace(/\.\d+Z$/, "Z"), pid);
  }

  previousBanner(): string[] {
    if (!existsSync(this.path)) return [];
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const prev = parseRunRecord(text);
    if (prev === null || prev.clean || this.alive(prev.pid)) return [];
    return uncleanBanner(prev);
  }

  begin(con: ConsoleBase, everyS: number = 2): void {
    const before = con.onRecorded;
    con.onRecorded = (e) => {
      if (before !== null) before(e);
      this.ledger.note(e);
    };
    this.write(false);
    this.timer = setInterval(() => {
      if (this.ledger.dirty) this.flush();
    }, everyS * 1000);
    this.timer.unref();
  }

  flush(): void {
    this.write(false);
  }

  end(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.write(true);
  }

  private write(clean: boolean): void {
    this.ledger.dirty = false;
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.ledger.snapshot(clean)) + "\n");
      renameSync(tmp, this.path);
    } catch (e) {
      this.lastError = e;
    }
  }
}
