import type { Recorded } from "./console.ts";

export interface RunChanges {
  faders: Record<string, number>;
  gains: Record<string, number>;
  mutes: Record<string, boolean>;
  polarity: Record<string, boolean>;
  notches: number;
  eqBands: number;
  sends: number;
  scene: number | null;
  mainMuted: boolean | null;
  master: number | null;
}

export interface RunRecord {
  started: string;
  pid: number;
  clean: boolean;
  changes: RunChanges;
}

const emptyChanges = (): RunChanges => ({
  faders: {},
  gains: {},
  mutes: {},
  polarity: {},
  notches: 0,
  eqBands: 0,
  sends: 0,
  scene: null,
  mainMuted: null,
  master: null,
});

export class RunLedger {
  private readonly started: string;
  private readonly pid: number;
  private readonly changes = emptyChanges();
  private readonly notchKeys = new Set<string>();
  private readonly eqKeys = new Set<string>();
  private readonly sendKeys = new Set<string>();
  private any = false;
  dirty = false;

  constructor(started: string, pid: number) {
    this.started = started;
    this.pid = pid;
  }

  note(e: Recorded): void {
    const c = this.changes;
    switch (e.kind) {
      case "fader":
        c.faders[String(e.ch)] = e.db;
        break;
      case "gain":
        c.gains[String(e.ch)] = e.db;
        break;
      case "notch":
        this.notchKeys.add(`${e.ch}/${e.band}`);
        c.notches = this.notchKeys.size;
        break;
      case "eq_band":
      case "bus_eq":
        this.eqKeys.add(e.kind === "eq_band" ? `${e.ch}/${e.band}` : `bus/${e.band}`);
        c.eqBands = this.eqKeys.size;
        break;
      case "eq_clear":
        this.eqKeys.add(`${e.ch}/clear`);
        c.eqBands = this.eqKeys.size;
        break;
      case "send":
        this.sendKeys.add(`${e.ch}/${e.bus}`);
        c.sends = this.sendKeys.size;
        break;
      case "fx_return":
        this.sendKeys.add(`fx/${e.fx}`);
        c.sends = this.sendKeys.size;
        break;
      case "scene":
        c.scene = e.index;
        break;
      case "main_mute":
        c.mainMuted = e.muted;
        break;
      case "ch_mute":
        c.mutes[String(e.ch)] = e.muted;
        break;
      case "polarity":
        c.polarity[String(e.ch)] = e.inverted;
        break;
      case "master":
        c.master = e.db;
        break;
    }
    this.any = true;
    this.dirty = true;
  }

  changed(): boolean {
    return this.any;
  }

  snapshot(clean: boolean): RunRecord {
    return { started: this.started, pid: this.pid, clean, changes: JSON.parse(JSON.stringify(this.changes)) as RunChanges };
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseRunRecord(text: string): RunRecord | null {
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !isObj(d) ||
    typeof d["started"] !== "string" ||
    typeof d["pid"] !== "number" ||
    typeof d["clean"] !== "boolean" ||
    !isObj(d["changes"])
  )
    return null;
  const c = d["changes"];
  const nums = (v: unknown): Record<string, number> =>
    isObj(v)
      ? Object.fromEntries(Object.entries(v).filter((x): x is [string, number] => typeof x[1] === "number" && Number.isFinite(x[1])))
      : {};
  const bools = (v: unknown): Record<string, boolean> =>
    isObj(v) ? Object.fromEntries(Object.entries(v).filter((x): x is [string, boolean] => typeof x[1] === "boolean")) : {};
  const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);
  const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    started: d["started"],
    pid: d["pid"],
    clean: d["clean"],
    changes: {
      faders: nums(c["faders"]),
      gains: nums(c["gains"]),
      mutes: bools(c["mutes"]),
      polarity: bools(c["polarity"]),
      notches: count(c["notches"]),
      eqBands: count(c["eqBands"]),
      sends: count(c["sends"]),
      scene: numOrNull(c["scene"]),
      mainMuted: typeof c["mainMuted"] === "boolean" ? c["mainMuted"] : null,
      master: numOrNull(c["master"]),
    },
  };
}

const MAX_LISTED = 12;

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function uncleanBanner(r: RunRecord): string[] {
  if (r.clean) return [];
  const c = r.changes;
  const items: string[] = [];
  if (c.mainMuted === true) items.push("main output MUTED");
  if (c.scene !== null) items.push(`scene ${c.scene} recalled`);
  for (const [ch, db] of Object.entries(c.faders)) items.push(`ch${ch} fader ${fmt(db)} dB`);
  for (const [ch, db] of Object.entries(c.gains)) items.push(`ch${ch} preamp ${fmt(db)} dB`);
  for (const [ch, m] of Object.entries(c.mutes)) items.push(`ch${ch} ${m ? "muted" : "unmuted"}`);
  for (const [ch, inv] of Object.entries(c.polarity)) items.push(`ch${ch} polarity ${inv ? "inverted" : "normal"}`);
  if (c.notches) items.push(`${c.notches} EQ notch${c.notches === 1 ? "" : "es"}`);
  if (c.eqBands) items.push(`${c.eqBands} EQ band change${c.eqBands === 1 ? "" : "s"}`);
  if (c.sends) items.push(`${c.sends} send or FX level${c.sends === 1 ? "" : "s"}`);
  if (c.master !== null) items.push(`master ${fmt(c.master)} dB`);
  const head = `  [!] The last run (started ${r.started}) did not stop cleanly`;
  if (!items.length) return [`${head}, but it changed nothing on the console.`];
  const shown = items.slice(0, MAX_LISTED);
  const more = items.length > shown.length ? `, and ${items.length - shown.length} more` : "";
  return [
    `${head}. The console keeps what it set: ${shown.join(", ")}${more}.`,
    "      Check the console before the show; recall your scene if those values are not wanted.",
  ];
}
