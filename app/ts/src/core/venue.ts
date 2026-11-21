import { roundHalfEven, roundTo } from "./numfmt.ts";

export interface FeedbackFreq {
  hz: number;
  count: number;
}

export interface VenueModel {
  venue: string;
  shows: number;
  feedback_freqs: FeedbackFreq[];
  confidence: number;
  updated: number;
}

export interface VenueLogSource {
  venueFeedback(venue: string): string[];
  venueShows(venue: string): number;
}

export interface VenueStore {
  save(model: VenueModel): string;
  load(venue: string): VenueModel | null;
}

export function slug(venue: string): string {
  const s = (venue || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "venue";
}

export function watchFreqs(model: VenueModel, minCount: number = 2): number[] {
  return model.feedback_freqs.filter((f) => f.count >= minCount).map((f) => f.hz);
}

export function buildModel(log: VenueLogSource, venue: string, now: number | null = null): VenueModel {
  const msgs = log.venueFeedback(venue);
  const shows = log.venueShows(venue);
  const bins = new Map<number, number>();
  const members = new Map<number, number[]>();
  for (const m of msgs) {
    const mm = /(\d+)\s*Hz/.exec(m || "");
    if (!mm || mm[1]!.length > 6) continue;
    const hz = Number(mm[1]);
    if (hz < 20 || hz > 24000) continue;
    const b = roundHalfEven(Math.log2(hz) * 6);
    bins.set(b, (bins.get(b) ?? 0) + 1);
    const list = members.get(b);
    if (list) list.push(hz);
    else members.set(b, [hz]);
  }
  const ranked = [...bins.entries()].sort((a, b) => b[1] - a[1]);
  const feedback_freqs: FeedbackFreq[] = ranked.slice(0, 8).map(([b, count]) => {
    const hzs = [...members.get(b)!].sort((x, y) => x - y);
    return { hz: hzs[Math.floor(hzs.length / 2)]!, count };
  });
  const confidence = roundTo(Math.min(1, shows / 3), 2);
  return { venue, shows, feedback_freqs, confidence, updated: now || 0 };
}
