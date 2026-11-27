import type { ChannelMapSpec, Config } from "./config.ts";
import { TuningError, checkedOverride } from "./tuning.ts";
import type { TuningOverride } from "./tuning.ts";
import { intOf } from "./util.ts";

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
  tuning: TuningOverride[];
}

export function songByName(t: ShowTemplate, name: string): Song | null {
  if (!name) return null;
  const nl = name.trim().toLowerCase();
  for (const s of t.songs) if (s.name.trim().toLowerCase() === nl) return s;
  return null;
}

type Json = unknown;

const isObject = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

const isInt = (v: Json): v is number => typeof v === "number" && Number.isInteger(v);

const quoteJson = (v: Json): string => (typeof v === "string" ? `'${v}'` : JSON.stringify(v));

function numOrNull(v: Json, ctx: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number") throw new TemplateError(`${ctx}: expected a number, got ${quoteJson(v)}`);
  return v;
}

function toInt(v: Json): number {
  try {
    return intOf(v);
  } catch {
    throw new TemplateError(`invalid integer ${quoteJson(v)}`);
  }
}

const inMap = (nums: Set<number> | null, ch: number): boolean => nums === null || nums.has(ch);

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
  const labels = spec["labels"];
  if (labels !== null && labels !== undefined) {
    if (!isObject(labels)) throw new TemplateError("channels.labels must be an object");
    for (const [role, text] of Object.entries(labels)) {
      if (typeof text !== "string") throw new TemplateError(`channels.labels[${role}] must be a string`);
    }
  }
  for (const key of ["balance", "guest"]) {
    const seq = spec[key];
    if (seq !== null && seq !== undefined) {
      if (!Array.isArray(seq)) throw new TemplateError(`channels.${key} must be a list`);
      for (const x of seq) {
        if (!inMap(nums, toInt(x))) throw new TemplateError(`channels.${key} channel ${x} is not in channels.map`);
      }
    }
  }
  for (const key of ["stereo_links", "phase_pairs"]) {
    const links = spec[key];
    if (links !== null && links !== undefined) {
      if (!Array.isArray(links)) throw new TemplateError(`channels.${key} must be a list of pairs`);
      for (const pair of links) {
        if (!Array.isArray(pair) || pair.length !== 2) throw new TemplateError(`channels.${key} entries must be [a, b] pairs`);
        const a = toInt(pair[0]);
        const b = toInt(pair[1]);
        if (!inMap(nums, a) || !inMap(nums, b)) throw new TemplateError(`channels.${key} [${pair.join(", ")}] not in channels.map`);
      }
    }
  }
  return spec as ChannelMapSpec;
}

function parseTuning(spec: Json, name: string): TuningOverride[] {
  if (spec === null || spec === undefined) return [];
  if (!isObject(spec)) throw new TemplateError('\'tuning\' must be an object of sections, for example {"feedback": {"ringDb": 10}}');
  const out: TuningOverride[] = [];
  for (const [section, keys] of Object.entries(spec)) {
    if (!isObject(keys)) throw new TemplateError(`tuning.${section} must be an object of settings`);
    for (const [key, value] of Object.entries(keys)) {
      if (typeof value !== "number") throw new TemplateError(`tuning.${section}.${key} must be a number, got ${quoteJson(value)}`);
      try {
        out.push(checkedOverride(`${section}.${key}`, value, `template '${name}'`));
      } catch (exc) {
        if (exc instanceof TuningError) throw new TemplateError(`tuning: ${exc.message}`);
        throw exc;
      }
    }
  }
  return out;
}

export function fromObject(d: Json, cfg: Config): ShowTemplate {
  if (!isObject(d)) throw new TemplateError("template must be a JSON object");
  const channels = parseChannels(d["channels"]);
  const validCh: Set<number> =
    channels && channels.map && Object.keys(channels.map).length
      ? new Set(Object.keys(channels.map).map((k) => Number(k.trim())))
      : new Set(cfg.CHANNELS.keys());
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
    const balRaw = sd["balance"] === null || sd["balance"] === undefined ? {} : sd["balance"];
    if (!isObject(balRaw)) throw new TemplateError(`songs[${i}].balance must be an object`);
    const balance = new Map<number, number | null>();
    for (const [chS, lvl] of Object.entries(balRaw)) {
      if (!/^\s*[+-]?\d+\s*$/.test(chS)) throw new TemplateError(`songs[${i}].balance key '${chS}' is not a channel number`);
      const ch = Number(chS.trim());
      if (!validCh.has(ch)) throw new TemplateError(`songs[${i}].balance: channel ${ch} is not in the channel map`);
      balance.set(ch, numOrNull(lvl, `songs[${i}].balance[${ch}]`));
    }
    const guest = sd["guest"];
    if (guest !== null && guest !== undefined && typeof guest !== "boolean") {
      throw new TemplateError(`songs[${i}].guest must be true or false, got ${quoteJson(guest)}`);
    }
    songs.push({
      name: name.trim(),
      scene: isInt(scene) ? scene : null,
      leadTarget: numOrNull(sd["lead_target"], `songs[${i}].lead_target`),
      balance,
      guest: guest === true,
    });
  });
  const name = d["name"] === undefined ? "Show" : String(d["name"]);
  return { name, songs, channels, tuning: parseTuning(d["tuning"], name) };
}

export function defaultTemplate(cfg: Config): ShowTemplate {
  const bloomBalance = Object.fromEntries(Object.entries({ "5": -21.0, "7": -26.0 }).filter(([ch]) => cfg.CHANNELS.has(Number(ch))));
  return fromObject(
    {
      name: "Acoustic Trio — demo set",
      songs: [
        { name: "Gravity", scene: 1, lead_target: -6.0 },
        { name: "Bloom", scene: 2, lead_target: -7.0, balance: bloomBalance },
        { name: "Wildflower", scene: 3, lead_target: -5.0 },
        { name: "Tide", scene: 4, lead_target: -6.5, guest: true },
      ],
    },
    cfg,
  );
}
