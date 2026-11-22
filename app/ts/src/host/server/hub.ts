import { jsonText } from "./json.ts";
import { wsFrame } from "./ws.ts";

export interface Sink {
  readonly kind: "sse" | "ws";
  write(bytes: Buffer): void;
  destroy(): void;
}

interface Payload {
  sse: Buffer;
  ws: Buffer;
}

export class Hub {
  private readonly sinks = new Set<Sink>();
  private readonly source: () => unknown;
  private readonly intervalMs: number;
  private readonly keepaliveTicks: number;
  private readonly onError: (e: unknown) => void;
  private timer: NodeJS.Timeout | null = null;
  private last: unknown = undefined;
  private payload: Payload | null = null;
  private idle = 0;

  constructor(source: () => unknown, intervalMs: number, keepaliveTicks: number, onError: (e: unknown) => void) {
    this.source = source;
    this.intervalMs = intervalMs;
    this.keepaliveTicks = keepaliveTicks;
    this.onError = onError;
  }

  get size(): number {
    return this.sinks.size;
  }

  add(sink: Sink): () => void {
    this.sinks.add(sink);
    try {
      this.refresh();
    } catch (e) {
      this.onError(e);
    }
    if (this.payload !== null) this.deliver(sink, this.payload);
    if (this.timer === null && this.sinks.has(sink)) {
      this.timer = setInterval(() => this.tick(), this.intervalMs);
    }
    return () => this.remove(sink);
  }

  remove(sink: Sink): void {
    this.sinks.delete(sink);
    if (this.sinks.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.sinks.clear();
  }

  private refresh(): boolean {
    const snap = this.source();
    if (snap === this.last && this.payload !== null) return false;
    const text = jsonText(snap);
    this.payload = { sse: Buffer.from(`data: ${text}\n\n`, "utf8"), ws: wsFrame(text) };
    this.last = snap;
    return true;
  }

  private deliver(sink: Sink, payload: Payload): void {
    try {
      sink.write(sink.kind === "sse" ? payload.sse : payload.ws);
    } catch {
      this.sinks.delete(sink);
      try {
        sink.destroy();
      } catch {
        return;
      }
    }
  }

  private tick(): void {
    let changed: boolean;
    try {
      changed = this.refresh();
    } catch (e) {
      this.onError(e);
      return;
    }
    this.idle = changed ? 0 : this.idle + 1;
    if (!changed && this.idle < this.keepaliveTicks) return;
    this.idle = 0;
    const payload = this.payload;
    if (payload === null) return;
    for (const sink of [...this.sinks]) this.deliver(sink, payload);
    if (this.sinks.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
