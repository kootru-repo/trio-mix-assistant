import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import type { AssistantEvent } from "../core/assistant/index.ts";
import { pyRoundTo } from "../core/pyfmt.ts";
import type { SessionLogPort } from "../core/ports.ts";

export interface EventRow {
  t: number | null;
  kind: string | null;
  level: string | null;
  ch: number | null;
  role: string | null;
  msg: string | null;
}

export interface VenueHistoryEntry {
  session_id: number;
  started: number;
  counts: Record<string, number>;
}

export interface SessionLogOptions {
  monotonic?: () => number;
  now?: () => number;
  warn?: (message: string, error: unknown) => void;
}

type QueuedEvent = [number, number, string | null, string | null, number | null, string | null, string | null];

const QUEUE_MAX = 4096;
const BATCH_MAX = 256;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started REAL, venue TEXT, template TEXT, mode TEXT);
  CREATE TABLE IF NOT EXISTS events(
      session_id INTEGER, t REAL, kind TEXT, level TEXT,
      ch INTEGER, role TEXT, msg TEXT);
  CREATE INDEX IF NOT EXISTS ix_events_session ON events(session_id);
`;

const defaultWarn = (message: string, error: unknown): void => {
  console.warn(message, error);
};

const orNull = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);

function countsOf(rows: Record<string, unknown>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r["kind"])] = Number(r["n"]);
  return out;
}

export class SessionLog implements SessionLogPort {
  readonly dbPath: string;
  sessionId: number | null = null;
  dropped = 0;
  private db: DatabaseSync | null;
  private readonly monotonic: () => number;
  private readonly now: () => number;
  private readonly warn: (message: string, error: unknown) => void;
  private readonly t0: number;
  private queue: QueuedEvent[] = [];
  private scheduled = false;
  private writeFailed = false;
  private waiters: (() => void)[] = [];
  private insertEvent: StatementSync;

  constructor(dbPath: string = ":memory:", opts: SessionLogOptions = {}) {
    this.dbPath = dbPath;
    this.monotonic = opts.monotonic ?? ((): number => performance.now() / 1000);
    this.now = opts.now ?? ((): number => Date.now() / 1000);
    this.warn = opts.warn ?? defaultWarn;
    const db = new DatabaseSync(dbPath);
    this.db = db;
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(SCHEMA);
    this.insertEvent = db.prepare(
      "INSERT INTO events(session_id,t,kind,level,ch,role,msg) VALUES (?,?,?,?,?,?,?)",
    );
    this.t0 = this.monotonic();
  }

  startSession(venue: string = "", template: string = "", mode: string = ""): number {
    const res = this.conn().prepare("INSERT INTO sessions(started, venue, template, mode) VALUES (?,?,?,?)").run(
      this.now(),
      venue,
      template,
      mode,
    );
    this.sessionId = Number(res.lastInsertRowid);
    return this.sessionId;
  }

  logEvent(ev: AssistantEvent): void {
    if (this.sessionId === null || this.db === null) return;
    if (this.queue.length >= QUEUE_MAX) {
      this.dropped += 1;
      return;
    }
    this.queue.push([
      this.sessionId,
      pyRoundTo(this.monotonic() - this.t0, 2),
      orNull(ev.kind),
      orNull(ev.level),
      orNull(ev.ch),
      orNull(ev.role),
      orNull(ev.msg),
    ]);
    this.schedule();
  }

  summary(sessionId: number | null = null): Record<string, number> {
    const sid = sessionId ?? this.sessionId;
    if (sid === null) return {};
    return countsOf(
      this.conn().prepare("SELECT kind, COUNT(*) AS n FROM events WHERE session_id=? GROUP BY kind").all(sid),
    );
  }

  recent(n: number = 20, sessionId: number | null = null): EventRow[] {
    const sid = sessionId ?? this.sessionId;
    if (sid === null) return [];
    const rows = this.conn()
      .prepare(
        "SELECT t, kind, level, ch, role, msg FROM events WHERE session_id=? ORDER BY rowid DESC LIMIT ?",
      )
      .all(sid, Math.trunc(n));
    return rows.reverse().map((r) => ({
      t: r["t"] as number | null,
      kind: r["kind"] as string | null,
      level: r["level"] as string | null,
      ch: r["ch"] as number | null,
      role: r["role"] as string | null,
      msg: r["msg"] as string | null,
    }));
  }

  venueFeedback(venue: string, limitSessions: number = 20): string[] {
    const db = this.conn();
    const sids = db
      .prepare("SELECT id FROM sessions WHERE venue=? ORDER BY id DESC LIMIT ?")
      .all(venue, Math.trunc(limitSessions))
      .map((r) => r["id"] as number);
    if (sids.length === 0) return [];
    const ph = sids.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT msg FROM events WHERE kind='feedback' AND session_id IN (${ph})`)
      .all(...sids);
    return rows.map((r) => r["msg"] as string | null).filter((m): m is string => typeof m === "string" && m !== "");
  }

  venueShows(venue: string): number {
    const row = this.conn().prepare("SELECT COUNT(*) AS n FROM sessions WHERE venue=?").get(venue);
    return Number(row?.["n"] ?? 0);
  }

  venueHistory(venue: string, limit: number = 10): VenueHistoryEntry[] {
    const db = this.conn();
    const sess = db
      .prepare("SELECT id, started FROM sessions WHERE venue=? ORDER BY id DESC LIMIT ?")
      .all(venue, Math.trunc(limit));
    const counts = db.prepare("SELECT kind, COUNT(*) AS n FROM events WHERE session_id=? GROUP BY kind");
    return sess.map((s) => ({
      session_id: s["id"] as number,
      started: s["started"] as number,
      counts: countsOf(counts.all(s["id"] as number)),
    }));
  }

  flush(): Promise<void> {
    if (this.queue.length === 0 && !this.scheduled) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close(): void {
    if (this.db === null) return;
    while (this.queue.length > 0) this.writeBatch();
    this.settle();
    try {
      this.db.close();
    } catch {
      this.db = null;
    }
    this.db = null;
  }

  private conn(): DatabaseSync {
    if (this.db === null) throw new Error("session log is closed");
    return this.db;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.db === null) {
      this.queue = [];
      this.settle();
      return;
    }
    this.writeBatch();
    if (this.queue.length > 0) this.schedule();
    else this.settle();
  }

  private writeBatch(): void {
    const batch = this.queue.splice(0, BATCH_MAX);
    if (batch.length === 0 || this.db === null) return;
    try {
      this.db.exec("BEGIN");
      try {
        for (const row of batch) this.insertEvent.run(...row);
        this.db.exec("COMMIT");
      } catch (e) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          void 0;
        }
        throw e;
      }
    } catch (e) {
      if (!this.writeFailed) {
        this.writeFailed = true;
        this.warn("session log write failed; later events may be lost", e);
      }
    }
  }

  private settle(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
}
