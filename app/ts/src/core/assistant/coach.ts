import type { CalibrationStep } from "../calibration.ts";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import { fixed, roundTo, signed } from "../numfmt.ts";
import type { CoachRec } from "./base.ts";
import { coachKey, roleOf } from "./context.ts";

export class Coach {
  readonly cfg: Config;
  readonly clock: Clock;
  private readonly emit: (kind: string, msg: string, ch: number | null) => void;
  coachMode = false;
  coachRecs = new Map<string, CoachRec>();
  coachLastText = new Map<string, string>();
  private coachSeq = 0;

  constructor(cfg: Config, clock: Clock, emit: (kind: string, msg: string, ch: number | null) => void) {
    this.cfg = cfg;
    this.clock = clock;
    this.emit = emit;
  }

  recommend(kind: string, ch: number | null, text: string, persist: boolean = false, meta: Record<string, unknown> = {}, key: string = coachKey(kind, ch)): void {
    this.coachSeq += 1;
    this.coachRecs.set(key, {
      ...meta,
      seq: this.coachSeq,
      mono: this.clock.monotonic(),
      persist,
      time: this.clock.hhmmss(),
      kind,
      ch,
      role: roleOf(this.cfg, ch),
      text,
    });
    if (this.coachLastText.get(key) !== text) {
      this.coachLastText.set(key, text);
      this.emit("coach", text, ch);
    }
  }

  forget(key: string): void {
    this.coachRecs.delete(key);
    this.coachLastText.delete(key);
  }

  clear(): void {
    this.coachRecs.clear();
    this.coachLastText.clear();
  }

  snapshot(now: number | null = null): CoachRec[] {
    const t = now ?? this.clock.monotonic();
    const live: CoachRec[] = [];
    for (const key of [...this.coachRecs.keys()]) {
      const rec = this.coachRecs.get(key)!;
      if (!rec.persist && t - rec.mono > this.cfg.coach.ttlS) {
        this.coachRecs.delete(key);
        this.coachLastText.delete(key);
      } else {
        live.push(rec);
      }
    }
    live.sort((a, b) => b.seq - a.seq);
    return live;
  }

  calibration(steps: CalibrationStep[]): void {
    if (!steps.length) {
      this.recommend("calibration", null, "Room measured — no problem peaks; leave the main bus flat.", true, { steps: [] });
      return;
    }
    const parts = steps.map(
      (s) => `band ${s.band} ${fixed(s.hz, 0)} Hz ${signed(s.gain, 1)} dB (Q ${fixed(s.q, 0)})` + (s.kind === "room" ? "" : " pre-dip"),
    );
    const text = "Room calibration → set MAIN-BUS PEQ: " + parts.join("; ") + ".";
    this.recommend("calibration", null, text, true, {
      steps: steps.map((s) => ({ band: s.band, hz: roundTo(s.hz, 1), gain: s.gain, q: s.q, kind: s.kind })),
    });
  }
}
