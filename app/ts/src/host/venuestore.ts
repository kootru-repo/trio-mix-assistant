import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  constructor(dir: string) {
    this.dir = dir;
  }

  save(model: VenueModel): string {
    mkdirSync(this.dir, { recursive: true });
    const path = modelPath(this.dir, model.venue);
    writeFileSync(path, serializeModel(model), "utf8");
    return path;
  }

  load(venue: string): VenueModel | null {
    const path = modelPath(this.dir, venue);
    if (!existsSync(path)) return null;
    try {
      const d: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isRecord(d)) return null;
      const freqs = "feedback_freqs" in d ? d["feedback_freqs"] : [];
      if (!Array.isArray(freqs)) return null;
      return {
        venue: "venue" in d ? (d["venue"] as string) : venue,
        shows: argInt("shows" in d ? d["shows"] : 0),
        feedback_freqs: [...freqs] as FeedbackFreq[],
        confidence: argFloat("confidence" in d ? d["confidence"] : 0),
        updated: argFloat("updated" in d ? d["updated"] : 0),
      };
    } catch {
      return null;
    }
  }
}
