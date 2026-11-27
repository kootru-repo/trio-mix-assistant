import { fixed, signed } from "../numfmt.ts";
import { clamp } from "../util.ts";
import { asBool, numOf } from "./base.ts";
import { EngineHold } from "./hold.ts";

export class EngineControls extends EngineHold {
  setEnabled(job: string, on: boolean): void {
    if (this.vetBusy("job switch")) return;
    if (!Object.hasOwn(this.assistant.enabled, job)) return;
    if (this.status === "takeover") {
      if (this.enabledBackup !== null) this.enabledBackup[job] = Boolean(on);
      this.assistant.emit("system", on ? `${job} will enable when takeover is released` : `${job} disabled`);
      this.rebuildTelemetry();
      return;
    }
    this.assistant.enabled[job] = Boolean(on);
    if (job === "balance" && on) this.assistant.captureBalance(this.outputLevels());
    if (job === "unmask" && !on) this.assistant.releaseUnmask();
    this.assistant.emit("system", `${job} ${on ? "ENABLED" : "disabled"}`);
    this.rebuildTelemetry();
  }

  setCoachMode(on: boolean): void {
    if (this.vetBusy("coach switch")) return;
    this.assistant.setCoachMode(Boolean(on));
    this.rebuildTelemetry();
  }

  setLeadTarget(db: unknown): void {
    if (this.vetBusy("lead target")) return;
    let v: number;
    try {
      v = numOf(db);
    } catch {
      return;
    }
    v = clamp(v, this.cfg.ride.leadTargetMinDb, this.cfg.ride.leadTargetMaxDb);
    this.assistant.leadTarget = v;
    this.assistant.emit("system", `lead target set to ${signed(v, 1)} dB`);
    this.rebuildTelemetry();
  }

  setFader(ch: number, db: unknown): void {
    if (this.vetBusy("fader move")) return;
    if (!this.cfg.CHANNELS.has(ch)) return;
    let v: number;
    try {
      v = numOf(db);
    } catch {
      return;
    }
    const now = this.clock.monotonic();
    v = this.con.setFaderRaw(ch, v);
    this.assistant.faderDb.set(ch, v);
    this.assistant.noteManual(ch, now);
    this.assistant.lastMoveT.set(ch, now);
    this.assistant.emit("manual", `${this.chan(ch)} fader → ${signed(v, 1)} dB`, ch);
    const partner = this.linkedPartner(ch);
    if (partner !== null) {
      const pdb = this.con.setFaderRaw(partner, v);
      this.assistant.faderDb.set(partner, pdb);
      this.assistant.noteManual(partner, now);
      this.assistant.lastMoveT.set(partner, now);
      this.assistant.emit("manual", `${this.chan(partner)} linked → ${signed(pdb, 1)} dB`, partner);
    }
    this.rebuildTelemetry();
  }

  linkedPartner(ch: number): number | null {
    for (const pair of this.cfg.STEREO_LINKS) {
      if (pair.includes(ch)) {
        for (const other of pair) if (other !== ch && this.cfg.CHANNELS.has(other)) return other;
      }
    }
    return null;
  }

  setEq(ch: number, band: number, hz: unknown = null, gain: unknown = null, q: unknown = null, on: unknown = null): void {
    if (this.vetBusy("EQ change")) return;
    const bands = this.eq.get(ch);
    if (!bands) return;
    const b = bands.get(Math.trunc(band));
    if (b === undefined) return;
    let nh = b.hz;
    let ng = b.gain;
    let nq = b.q;
    let non = b.on;
    try {
      if (hz !== null && hz !== undefined) nh = clamp(numOf(hz), 20.0, 20000.0);
      if (gain !== null && gain !== undefined) ng = clamp(numOf(gain), -15.0, 15.0);
      if (q !== null && q !== undefined) nq = clamp(numOf(q), 0.3, 10.0);
      if (on !== null && on !== undefined) non = asBool(on);
    } catch {
      return;
    }
    this.con.setEqBand(ch, Math.trunc(band), nh, ng, nq, non);
    b.hz = nh;
    b.gain = ng;
    b.q = nq;
    b.on = non;
    this.assistant.emit(
      "manual",
      `${this.chan(ch)} EQ b${band}: ${fixed(b.hz, 0)} Hz ${signed(b.gain, 1)} dB Q${fixed(b.q, 1)} ${b.on ? "on" : "off"}`,
      ch,
    );
    this.rebuildTelemetry();
  }

  resetChannelEq(ch: number): void {
    if (this.vetBusy("EQ reset")) return;
    const bands = this.eq.get(ch);
    if (!bands) return;
    for (const [bnum, band] of bands) {
      band.gain = 0;
      band.on = false;
      this.con.setEqBand(ch, bnum, band.hz, 0.0, band.q, false);
    }
    this.con.clearChannelEq(ch);
    if (this.assistant.usedNotchBand.has(ch)) {
      this.assistant.usedNotchBand.set(ch, 0);
      this.assistant.fbStreak.set(ch, 0);
    }
    this.assistant.emit("manual", `${this.chan(ch)} EQ reset to flat`, ch);
    this.rebuildTelemetry();
  }

  setSend(ch: number, fx: number, db: unknown): void {
    if (this.vetBusy("send change")) return;
    const sends = this.sends.get(ch);
    if (!sends || !this.cfg.FX_BUSES.has(Math.trunc(fx))) return;
    let v: number;
    try {
      v = clamp(numOf(db), -90.0, 10.0);
    } catch {
      return;
    }
    sends.set(Math.trunc(fx), v);
    this.con.setSend(ch, Math.trunc(fx), v);
    this.assistant.emit("manual", `${this.chan(ch)} → ${this.cfg.FX_BUSES.get(Math.trunc(fx))} ${signed(v, 0)} dB`, ch);
    this.rebuildTelemetry();
  }

  setFxWet(fx: number, db: unknown): void {
    if (this.vetBusy("FX return change")) return;
    const k = Math.trunc(fx);
    if (!this.cfg.FX_BUSES.has(k)) return;
    let v: number;
    try {
      v = clamp(numOf(db), -90.0, 10.0);
    } catch {
      return;
    }
    this.fxWet.set(k, v);
    this.con.setFxReturn(k, v);
    this.assistant.emit("manual", `${this.cfg.FX_BUSES.get(k)} return ${signed(v, 0)} dB`);
    this.rebuildTelemetry();
  }

  setMute(ch: number, on: boolean): void {
    if (this.vetBusy("mute")) return;
    if (!this.cfg.CHANNELS.has(ch)) return;
    this.con.setChannelMute(ch, Boolean(on));
    this.muted.set(ch, Boolean(on));
    this.assistant.noteManual(ch, this.clock.monotonic());
    this.assistant.emit("manual", `${this.chan(ch)} ${on ? "MUTED" : "unmuted"}`, ch);
    this.rebuildTelemetry();
  }

  setMaster(db: unknown): void {
    if (this.vetBusy("master fader move")) return;
    let v: number;
    try {
      v = numOf(db);
    } catch {
      return;
    }
    this.masterDb = this.con.setMainFader(v);
    this.assistant.emit("manual", `master fader → ${signed(this.masterDb, 1)} dB`);
    this.rebuildTelemetry();
  }

  captureBalanceNow(): void {
    if (this.vetBusy("balance capture")) return;
    this.assistant.captureBalance(this.outputLevels());
    this.rebuildTelemetry();
  }

  reconcileFader(ch: number, db: number): void {
    if (this.vetStatus === "running") return;
    if (!this.cfg.CHANNELS.has(ch) || !Number.isFinite(db)) return;
    const now = this.clock.monotonic();
    this.lastRxT = now;
    if (this.syncing) return;
    if (this.outside.classify(ch, db, now) === "echo") return;
    if (Math.abs(db - (this.assistant.faderDb.get(ch) ?? 0)) < this.cfg.manual.minDb) return;
    this.outsideMove(ch, now);
    this.assistant.faderDb.set(ch, db);
    this.assistant.noteManual(ch, now);
    if (now - (this.lastReconcileLog.get(ch) ?? -1e9) > this.cfg.manual.logIntervalS) {
      this.lastReconcileLog.set(ch, now);
      this.assistant.emit("manual", `${this.chan(ch)} moved on console → ${signed(db, 1)} dB`, ch);
    }
    this.rebuildTelemetry();
  }

  resetNotches(): void {
    if (this.vetBusy("notch reset")) return;
    this.assistant.resetNotches();
    this.rebuildTelemetry();
  }

  panic(on: boolean): void {
    if (on && this.vetStatus === "running") this.vetAbort = true;
    if (on && this.status !== "takeover") {
      this.con.cancelRamps();
      this.con.setMainMute(true);
      this.enabledBackup = { ...this.assistant.enabled };
      for (const k of Object.keys(this.assistant.enabled)) this.assistant.enabled[k] = false;
      this.assistant.releaseUnmask();
      this.status = "takeover";
      this.takeoverEpoch += 1;
      this.assistant.emit("panic", "TAKEOVER — main muted, all jobs held");
    } else if (!on && this.status === "takeover") {
      this.con.setMainMute(false);
      if (this.enabledBackup !== null) Object.assign(this.assistant.enabled, this.enabledBackup);
      this.status = "live";
      this.takeoverEpoch += 1;
      this.assistant.emit("panic", "takeover released — back to live");
      this.clearOperatorHolds();
    }
    this.rebuildTelemetry();
  }
}
