import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slug } from "../core/venue.ts";
import type { FeedbackFreq, VenueModel, VenueStore as VenueStorePort } from "../core/venue.ts";

const FLOAT_MARK = "__pyfloat__";

function asciiEscape(s: string): string {
  return s.replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

function floatText(x: number): string {
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return x.toFixed(1);
  return String(x);
}

export function serializeModel(model: VenueModel): string {
  const text = JSON.stringify(
    {
      venue: model.venue,
      shows: model.shows,
      feedback_freqs: model.feedback_freqs,
      confidence: FLOAT_MARK + floatText(model.confidence),
      updated: FLOAT_MARK + floatText(model.updated),
    },
    null,
    2,
  );
  return asciiEscape(text.replace(new RegExp(`"${FLOAT_MARK}([^"]*)"`, "g"), "$1"));
}

function argInt(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError("not finite");
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    if (!/^\s*[+-]?\d+\s*$/.test(v)) throw new TypeError("bad int");
    return Number(v.trim());
  }
  throw new TypeError("bad int");
}

function argFloat(v: unknown): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "" || Number.isNaN(Number(t))) throw new TypeError("bad float");
    return Number(t);
  }
  throw new TypeError("bad float");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function modelPath(venueDir: string, venue: string): string {
  return join(venueDir, slug(venue) + ".json");
}

export class VenueStore implements VenueStorePort {
  readonly dir: string;
  lastProblem: string | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  save(model: VenueModel): string {
    mkdirSync(this.dir, { recursive: true });
    const path = modelPath(this.dir, model.venue);
    const tmp = path + ".tmp";
    writeFileSync(tmp, serializeModel(model), "utf8");
    renameSync(tmp, path);
    return path;
  }

  load(venue: string): VenueModel | null {
    const path = modelPath(this.dir, venue);
    if (!existsSync(path)) return null;
    try {
      const d: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isRecord(d)) return this.setAside(path);
      const freqs = "feedback_freqs" in d ? d["feedback_freqs"] : [];
      if (!Array.isArray(freqs)) return this.setAside(path);
      const entries: FeedbackFreq[] = [];
      for (const f of freqs) {
        if (!isRecord(f)) return this.setAside(path);
        const hz = f["hz"];
        const count = f["count"];
        if (typeof hz !== "number" || typeof count !== "number" || !Number.isFinite(hz) || !Number.isFinite(count)) return this.setAside(path);
        entries.push({ hz, count });
      }
      const named = "venue" in d ? d["venue"] : venue;
      return {
        venue: typeof named === "string" ? named : venue,
        shows: argInt("shows" in d ? d["shows"] : 0),
        feedback_freqs: entries,
        confidence: argFloat("confidence" in d ? d["confidence"] : 0),
        updated: argFloat("updated" in d ? d["updated"] : 0),
      };
    } catch {
      return this.setAside(path);
    }
  }

  private setAside(path: string): null {
    const bad = path + ".bad";
    try {
      renameSync(path, bad);
      this.lastProblem = `the saved venue model could not be read; it was set aside as ${bad}`;
    } catch {
      this.lastProblem = "the saved venue model could not be read";
    }
    return null;
  }
}
