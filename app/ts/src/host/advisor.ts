import type { AdvisorPort } from "../core/ports.ts";

export const SYSTEM_PROMPT =
  "You are the slow advisory layer of an automatic live-sound assistant for an " +
  "acoustic trio (lead vocal, harmonies, acoustic guitar, bass, cajon, keys). A " +
  "separate deterministic system already handles ALL real-time safety — feedback " +
  "notching, clip protection, vocal-level riding, room calibration. You do NOT " +
  "control anything and must NEVER instruct fader/gain/EQ/mute/scene changes. " +
  "Read the recent event context and produce a SHORT, plain-language note for the " +
  "musicians or the front-of-house operator. Reply with STRICT JSON ONLY, no prose:\n" +
  '{"performer_prompt": "<=120 chars, empty string if nothing needs attention>", ' +
  '"room_assessment": "<=160 chars on the room/feedback trend>", ' +
  '"severity": "info|notice|warn"}';

export const API_URL = "https://api.anthropic.com/v1/messages";
export const API_VERSION = "2023-06-01";
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
export const REQUEST_TIMEOUT_MS = 20000;
export const CONTEXT_CAP = 6000;
export const MAX_TOKENS = 300;

export type AdvisorAdvice = {
  performer_prompt: string;
  room_assessment: string;
  severity: string;
};

export type AdvisorContext = Record<string, unknown>;
export type AdvisorCaller = (ctx: AdvisorContext) => unknown;
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface AdvisorOptions {
  getContext: () => AdvisorContext | Promise<AdvisorContext>;
  onAdvice: (advice: AdvisorAdvice) => void;
  apiKey?: string | null;
  model?: string;
  interval?: number;
  caller?: AdvisorCaller | null;
  fetch?: FetchFn;
  env?: Record<string, string | undefined>;
}

function strOf(v: unknown): string {
  if (v === null) return "";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function clip(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.length > n ? cps.slice(0, n).join("") : s;
}

function jsonString(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

export function jsonDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (!Number.isFinite(v)) return v < 0 ? "-Infinity" : "Infinity";
    return String(v);
  }
  if (typeof v === "string") return jsonString(v);
  if (Array.isArray(v)) return "[" + v.map(jsonDumps).join(", ") + "]";
  if (typeof v === "object") {
    const parts: string[] = [];
    for (const [k, x] of Object.entries(v)) parts.push(jsonString(k) + ": " + jsonDumps(x));
    return "{" + parts.join(", ") + "}";
  }
  return "null";
}

function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return `Error: ${String(e)}`;
}

export class Advisor implements AdvisorPort {
  readonly getContext: AdvisorOptions["getContext"];
  readonly onAdvice: AdvisorOptions["onAdvice"];
  apiKey: string | null;
  readonly model: string;
  readonly interval: number;
  readonly caller: AdvisorCaller;
  available: boolean;
  lastError: string | null = null;
  calls = 0;
  private readonly injected: boolean;
  private readonly fetchFn: FetchFn;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(opts: AdvisorOptions) {
    this.getContext = opts.getContext;
    this.onAdvice = opts.onAdvice;
    const env = opts.env ?? process.env;
    this.apiKey = opts.apiKey || env["ANTHROPIC_API_KEY"] || null;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.interval = opts.interval ?? 30;
    this.injected = opts.caller !== undefined && opts.caller !== null;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.caller = opts.caller ?? ((ctx) => this.httpCall(ctx));
    this.available = this.injected || Boolean(this.apiKey);
  }

  start(): boolean {
    if (!this.available || this.running) return false;
    this.running = true;
    this.arm();
    return true;
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<AdvisorAdvice | null> {
    try {
      const ctx = await this.getContext();
      const advice = await this.caller(ctx);
      this.calls += 1;
      if (typeof advice === "object" && advice !== null && !Array.isArray(advice)) {
        this.onAdvice(advice as AdvisorAdvice);
        return advice as AdvisorAdvice;
      }
    } catch (e) {
      this.lastError = describeError(e);
    }
    return null;
  }

  async httpCall(ctx: AdvisorContext): Promise<AdvisorAdvice | null> {
    const body = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: clip(jsonDumps(ctx), CONTEXT_CAP) }],
    };
    const res = await this.fetchFn(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey || "",
        "anthropic-version": API_VERSION,
      },
      body: jsonDumps(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
    const resp: unknown = await res.json();
    if (typeof resp !== "object" || resp === null || Array.isArray(resp)) throw new TypeError("bad response");
    const content = (resp as Record<string, unknown>)["content"] ?? [];
    if (!Array.isArray(content)) throw new TypeError("bad content");
    let text = "";
    for (const b of content) {
      if (typeof b !== "object" || b === null) throw new TypeError("bad block");
      const blk = b as Record<string, unknown>;
      if (blk["type"] === "text") text += strOf("text" in blk ? blk["text"] : "");
    }
    return Advisor.parse(text);
  }

  static parse(text: string): AdvisorAdvice | null {
    if (!text) return null;
    const t = clip(text, 8000);
    const m = /\{.*\}/s.exec(t);
    if (!m) return null;
    let d: unknown;
    try {
      d = JSON.parse(m[0]);
    } catch {
      return null;
    }
    if (typeof d !== "object" || d === null || Array.isArray(d)) return null;
    const o = d as Record<string, unknown>;
    let sev = strOf("severity" in o ? o["severity"] : "info").trim().toLowerCase();
    if (sev !== "info" && sev !== "notice" && sev !== "warn") sev = "info";
    return {
      performer_prompt: clip(strOf("performer_prompt" in o ? o["performer_prompt"] : "").trim(), 200),
      room_assessment: clip(strOf("room_assessment" in o ? o["room_assessment"] : "").trim(), 240),
      severity: sev,
    };
  }

  private arm(): void {
    const timer = setTimeout(() => {
      void this.cycle();
    }, this.interval * 1000);
    timer.unref();
    this.timer = timer;
  }

  private async cycle(): Promise<void> {
    this.timer = null;
    await this.tick();
    if (this.running) this.arm();
  }
}
