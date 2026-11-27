import { ConsoleSync } from "../consolesync.ts";
import { LinkWatch } from "../linkwatch.ts";
import { OutsideEdits } from "../outsideedits.ts";
import type { OscArg } from "../oscwire.ts";
import { EngineBase } from "./base.ts";
import type { Alert, EngineOptions } from "./base.ts";

export type HoldReason = "unsynced" | "link" | "no-feedback" | "resume" | "write-storm" | "internal-error";

const OPERATOR_REARM: readonly HoldReason[] = ["write-storm", "internal-error"];

const HOLD_TEXT: Record<HoldReason, string> = {
  unsynced: "reading the desk's faders, preamp gains and polarity before the automatic jobs start",
  link: "the console link went quiet; the automatic jobs are paused until it is back and the desk has been read again",
  "no-feedback":
    "the console's reply port could not be opened, so the app cannot read the desk; the automatic jobs stay off (manual controls still work)",
  resume: "the computer was asleep or the app stalled; the desk is read again before the automatic jobs continue",
  "write-storm": "the app tried to send more changes to the console than it safely can; press TAKEOVER and release it to re-arm",
  "internal-error": "the app hit an unexpected error; manual controls still work; press TAKEOVER and release it to re-arm",
};

export class EngineHold extends EngineBase {
  protected holdReasons = new Set<HoldReason>();
  protected link: LinkWatch | null = null;
  protected sync: ConsoleSync | null = null;
  protected syncedOnce = false;
  protected failedAt: number | null = null;
  protected adopted = false;
  protected syncFailures = 0;
  private reflatten = new Set<number>();
  protected heldSong: string | null = null;
  protected outside = new OutsideEdits({
    echoTolDb: this.cfg.safety.echoTolDb,
    echoWindowS: this.cfg.safety.echoWindowS,
    lockMoves: this.cfg.safety.lockMoves,
    lockWindowS: this.cfg.safety.lockWindowS,
  });

  constructor(opts: EngineOptions) {
    super(opts);
    this.con.onFaderWrite = (ch, db) => this.outside.noteWrite(ch, db, this.clock.monotonic());
    this.con.onRampAbort = (ch, lastDb, startDb) => {
      if (this.assistant.faderDb.has(ch)) this.assistant.faderDb.set(ch, lastDb ?? startDb);
    };
  }

  channelLocked(ch: number): boolean {
    return this.outside.locked(ch);
  }

  protected tickSafety(now: number): void {
    this.con.pump(now);
    if (this.con.storming(now) && !this.holdReasons.has("write-storm")) {
      this.assistant.emit("system", "the console could not take changes as fast as the app sent them for 2 s");
      this.enterHold("write-storm");
    }
  }

  protected outsideMove(ch: number, now: number): void {
    this.con.cancelRamp(ch);
    if (this.outside.noteOutside(ch, now)) {
      this.assistant.emit(
        "system",
        `ch${ch} moved by hand ${this.cfg.safety.lockMoves} times in ${this.cfg.safety.lockWindowS} s: the automatic jobs leave it alone until TAKEOVER is pressed and released`,
        ch,
      );
    }
  }

  get held(): boolean {
    return this.holdReasons !== undefined && this.holdReasons.size > 0;
  }

  protected override holdSnapshot(): { held: boolean; reasons: string[] } {
    return { held: this.held, reasons: this.held ? [...this.holdReasons] : [] };
  }

  protected override lockedSnapshot(): number[] {
    return this.outside === undefined ? [] : this.outside.lockedChannels();
  }

  protected enterHold(reason: HoldReason): void {
    if (this.holdReasons.has(reason)) return;
    const was = this.held;
    this.holdReasons.add(reason);
    if (was) return;
    this.con.cancelRamps();
    for (const ch of this.assistant.duckApplied.keys()) this.reflatten.add(ch);
    this.assistant.releaseUnmask();
    this.assistant.emit("system", `automatic jobs on hold: ${HOLD_TEXT[reason]}`);
  }

  protected exitHold(reason: HoldReason): void {
    if (!this.holdReasons.delete(reason) || this.held) return;
    const locked = this.lockedSnapshot();
    this.con.withLane("auto", () => {
      for (const ch of this.reflatten) {
        if (locked.includes(ch)) continue;
        this.con.setEqBand(ch, this.cfg.unmask.band, this.cfg.unmask.freq, 0.0, this.cfg.unmask.q, true);
      }
    });
    this.reflatten.clear();
    for (const ch of this.assistant.fbStreak.keys()) this.assistant.fbStreak.set(ch, 0);
    for (const ch of this.assistant.feedback.fbLastFreq.keys()) this.assistant.feedback.fbLastFreq.set(ch, null);
    this.assistant.emit("system", "automatic jobs re-armed: the desk has been read and the console link is steady");
  }

  protected startLink(now: number): void {
    this.link = new LinkWatch({
      probeS: this.cfg.link.probeS,
      staleS: this.cfg.link.staleS,
      downS: this.cfg.link.downS,
      steadyS: this.cfg.link.steadyS,
    });
    this.sync = new ConsoleSync({
      channels: [...this.cfg.CHANNELS.keys()].sort((a, b) => a - b),
      send: (address) => this.con.query(address),
      retryS: this.cfg.link.syncRetryS,
      tries: this.cfg.link.syncTries,
    });
    this.beginSync(now);
  }

  protected beginSync(now: number): void {
    if (this.sync === null) return;
    this.enterHold("unsynced");
    this.failedAt = null;
    this.adopted = false;
    this.sync.begin(now);
  }

  consoleHeard(): void {
    const now = this.clock.monotonic();
    this.lastRxT = now;
    if (this.link !== null) this.link.heard(now);
  }

  consoleParam(address: string, args: readonly OscArg[]): void {
    if (this.sync === null || !this.sync.active) return;
    if (this.sync.handle(address, args) && !this.sync.active && !this.adopted) this.adoptDesk();
  }

  protected get syncing(): boolean {
    return this.sync !== null && this.sync.active;
  }

  protected replaySong(_name: string): void {}

  protected tickHold(now: number): void {
    if (this.vetStatus === "running") return;
    if (!this.held && this.heldSong !== null) {
      const name = this.heldSong;
      this.heldSong = null;
      this.replaySong(name);
    }
    if (this.link === null || this.sync === null) return;
    const t = this.link.tick(now);
    if (t.probe) this.con.query("/xinfo");
    if (t.changed && (t.state === "stale" || t.state === "down")) {
      this.enterHold("link");
      if (t.state === "down") this.assistant.emit("system", "console link lost — check the network and the console");
    }
    if (t.recovered) {
      this.assistant.emit("system", "console link back — reading the desk again");
      this.beginSync(now);
    }
    const status = this.sync.poll(now);
    if (status === "done" && !this.adopted) this.adoptDesk();
    else if (status === "failed" && this.holdReasons.has("unsynced")) {
      if (this.failedAt === null) {
        this.failedAt = now;
        this.syncFailures += 1;
        this.assistant.emit(
          "system",
          `could not read the desk (${this.sync.missing().length} value(s) unanswered) — trying again in ${this.cfg.link.resyncS} s`,
        );
      } else if (now - this.failedAt >= this.cfg.link.resyncS) {
        this.failedAt = null;
        this.sync.begin(now);
      }
    }
    if (this.link.state === "up") {
      if (this.adopted) {
        this.exitHold("unsynced");
        this.exitHold("resume");
      }
      if (!this.holdReasons.has("unsynced")) this.exitHold("link");
    }
  }

  private adoptDesk(): void {
    if (this.sync === null) return;
    const a = this.assistant;
    for (const [ch, v] of this.sync.result()) {
      if (v.faderDb !== null) a.faderDb.set(ch, v.faderDb);
      if (v.gainDb !== null) {
        a.gainDb.set(ch, v.gainDb);
        if (!this.syncedOnce) a.nominalGain.set(ch, v.gainDb);
      }
      if (v.inverted !== null) a.polarity.set(ch, v.inverted);
    }
    this.syncedOnce = true;
    this.adopted = true;
    this.con.clearRepeats();
    this.syncFailures = 0;
    this.assistant.emit("system", "read the desk: faders, preamp gains and polarity adopted");
  }

  protected onResume(now: number, gapS: number): void {
    this.assistant.emit(
      "system",
      gapS < 0
        ? `the computer clock jumped back by about ${Math.round(-gapS)} s`
        : `the engine was paused for about ${Math.round(gapS)} s (computer asleep or stalled)`,
    );
    if (this.link === null || this.sync === null) return;
    this.enterHold("resume");
    this.link.reset();
    this.con.subscribeMeters();
    this.beginSync(now);
    this.rebuildTelemetry();
  }

  fault(detail: string): void {
    this.assistant.emit("system", `unexpected error: ${detail}`);
    this.enterHold("internal-error");
    this.rebuildTelemetry();
  }

  protected clearOperatorHolds(): void {
    for (const r of OPERATOR_REARM) this.exitHold(r);
    const locked = this.outside.lockedChannels();
    for (const ch of locked) this.outside.unlock(ch);
    if (locked.length) this.assistant.emit("system", `automatic jobs may move ch${locked.join(", ch")} again`);
  }

  protected override alertsAndMode(now: number, connected: boolean): [Alert[], string] {
    const [base, mode] = super.alertsAndMode(now, connected);
    const locked = this.outside === undefined ? [] : this.outside.lockedChannels();
    const alerts: Alert[] = locked.length
      ? [
          {
            level: "warn",
            msg: `automatic jobs leave ch${locked.join(", ch")} alone after repeated hand moves; press TAKEOVER and release it to hand ${locked.length === 1 ? "it" : "them"} back`,
          },
          ...base,
        ]
      : base;
    if (!this.held) return [alerts, mode];
    const critical = (r: HoldReason): boolean => r === "no-feedback" || OPERATOR_REARM.includes(r);
    const hold: Alert[] = [...this.holdReasons].map((r) => ({
      level: critical(r) ? "critical" : "warn",
      msg: `jobs on hold — ${HOLD_TEXT[r]}`,
    }));
    return [[...hold, ...alerts], mode === "auto" || mode === "coach" ? "alert" : mode];
  }
}
