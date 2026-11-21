import { C } from "./config.ts";
import type { ChannelMapSpec } from "./config.ts";

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

export interface Song {
  name: string;
  scene: number | null;
  leadTarget: number | null;
  balance: Map<number, number | null>;
  guest: boolean;
}

export interface ShowTemplate {
  name: string;
  songs: Song[];
  channels: ChannelMapSpec | null;
}

export function songByName(t: ShowTemplate, name: string): Song | null {
  if (!name) return null;
  const nl = name.trim().toLowerCase();
  for (const s of t.songs) if (s.name.trim().toLowerCase() === nl) return s;
  return null;
}

export const songAt = (t: ShowTemplate, index: number): Song | null =>
  index >= 0 && index < t.songs.length ? t.songs[index]! : null;

type Json = unknown;

const isObject = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

const isInt = (v: Json): v is number => typeof v === "number" && Number.isInteger(v);

const reprJson = (v: Json): string => (typeof v === "string" ? `'${v}'` : JSON.stringify(v));

function truthy(v: Json): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isObject(v)) return Object.keys(v).length > 0;
  return true;
}

function numOrNull(v: Json, ctx: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number") throw new TemplateError(`${ctx}: expected a number, got ${reprJson(v)}`);
  return v;
}

function toInt(v: Json): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v.trim());
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new TemplateError(`invalid integer ${reprJson(v)}`);
}

function parseChannels(spec: Json): ChannelMapSpec | null {
  if (spec === null || spec === undefined) return null;
  if (!isObject(spec)) throw new TemplateError("'channels' must be an object");
  const m = spec["map"];
  let nums: Set<number> | null = null;
  if (m !== null && m !== undefined) {
    if (!isObject(m) || Object.keys(m).length === 0) throw new TemplateError("channels.map must be a non-empty object");
    nums = new Set<number>();
    for (const [k, v] of Object.entries(m)) {
      if (!/^\s*[+-]?\d+\s*$/.test(k)) throw new TemplateError(`channels.map key '${k}' is not a channel number`);
      if (typeof v !== "string" || !v.trim()) throw new TemplateError(`channels.map[${k}] must be a non-empty role name`);
      nums.add(Number(k.trim()));
    }
  }
  for (const key of ["lead", "meas_mic", "stage_mic"]) {
    const v = spec[key];
    if (v !== null && v !== undefined) {
      if (!isInt(v)) throw new TemplateError(`channels.${key} must be an int`);
      if (nums !== null && !nums.has(v)) throw new TemplateError(`channels.${key}=${v} is not in channels.map`);
    }
  }
  for (const key of ["balance", "guest"]) {
    const seq = spec[key];
    if (seq !== null && seq !== undefined) {
      if (!Array.isArray(seq)) throw new TemplateError(`channels.${key} must be a list`);
      for (const x of seq) {
        if (nums !== null && !nums.has(toInt(x))) throw new TemplateError(`channels.${key} channel ${x} is not in channels.map`);
      }
    }
  }
  const links = spec["stereo_links"];
  if (links !== null && links !== undefined) {
    if (!Array.isArray(links)) throw new TemplateError("channels.stereo_links must be a list of pairs");
    for (const pair of links) {
      if (!Array.isArray(pair) || pair.length !== 2) throw new TemplateError("channels.stereo_links entries must be [a, b] pairs");
      if (nums !== null && (!nums.has(toInt(pair[0])) || !nums.has(toInt(pair[1])))) {
        throw new TemplateError(`channels.stereo_links [${pair.join(", ")}] not in channels.map`);
      }
    }
  }
  return spec as ChannelMapSpec;
}

export function fromObject(d: Json): ShowTemplate {
  if (!isObject(d)) throw new TemplateError("template must be a JSON object");
  const channels = parseChannels(d["channels"]);
  const validCh: Set<number> =
    channels && channels.map && Object.keys(channels.map).length
      ? new Set(Object.keys(channels.map).map((k) => Number(k.trim())))
      : new Set(C.CHANNELS.keys());
  const songsRaw = d["songs"] === undefined ? [] : d["songs"];
  if (!Array.isArray(songsRaw)) throw new TemplateError("'songs' must be a list");
  if (songsRaw.length > 1000) throw new TemplateError("too many songs (max 1000)");
  const songs: Song[] = [];
  const seen = new Set<string>();
  songsRaw.forEach((sd: Json, i: number) => {
    if (!isObject(sd)) throw new TemplateError(`songs[${i}] must be an object`);
    const name = sd["name"];
    if (typeof name !== "string" || !name.trim()) throw new TemplateError(`songs[${i}].name is required (non-empty string)`);
    const key = name.trim().toLowerCase();
    if (seen.has(key)) throw new TemplateError(`duplicate song name: '${name}'`);
    seen.add(key);
    const scene = sd["scene"];
    if (scene !== null && scene !== undefined && !isInt(scene)) throw new TemplateError(`songs[${i}].scene must be an int or omitted`);
    if (isInt(scene) && !(scene >= 0 && scene <= 99)) throw new TemplateError(`songs[${i}].scene ${scene} out of range (0-99)`);
    const balRaw = truthy(sd["balance"]) ? sd["balance"] : {};
    if (!isObject(balRaw)) throw new TemplateError(`songs[${i}].balance must be an object`);
    const balance = new Map<number, number | null>();
    for (const [chS, lvl] of Object.entries(balRaw)) {
      if (!/^\s*[+-]?\d+\s*$/.test(chS)) throw new TemplateError(`songs[${i}].balance key '${chS}' is not a channel number`);
      const ch = Number(chS.trim());
      if (!validCh.has(ch)) throw new TemplateError(`songs[${i}].balance: channel ${ch} is not in the channel map`);
      balance.set(ch, numOrNull(lvl, `songs[${i}].balance[${ch}]`));
    }
    songs.push({
      name: name.trim(),
      scene: isInt(scene) ? scene : null,
      leadTarget: numOrNull(sd["lead_target"], `songs[${i}].lead_target`),
      balance,
      guest: truthy(sd["guest"]),
    });
  });
  return { name: d["name"] === undefined ? "Show" : String(d["name"]), songs, channels };
}

export function defaultTemplate(): ShowTemplate {
  return fromObject({
    name: "Acoustic Trio — demo set",
    songs: [
      { name: "Gravity", scene: 1, lead_target: -6.0 },
      { name: "Bloom", scene: 2, lead_target: -7.0, balance: { "5": -21.0, "7": -26.0 } },
      { name: "Wildflower", scene: 3, lead_target: -5.0 },
      { name: "Tide", scene: 4, lead_target: -6.5, guest: true },
    ],
  });
}
