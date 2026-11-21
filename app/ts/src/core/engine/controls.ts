import { C } from "../config.ts";
import { fixed, signed } from "../numfmt.ts";
import { chan } from "../assistant/base.ts";
import { clampf, EngineBase, numOf, truthy } from "./base.ts";

export class EngineControls extends EngineBase {
  setEnabled(job: string, on: boolean): void {
    if (!(job in this.assistant.enabled)) return;
    this.assistant.enabled[job] = Boolean(on);
    if (job === "balance" && on) this.assistant.captureBalance(this.outputLevels());
    if (job === "unmask" && !on) this.assistant.releaseUnmask();
    this.assistant.emit("system", `${job} ${on ? "ENABLED" : "disabled"}`);
    this.rebuildTelemetry();
  }

  setCoachMode(on: boolean): void {
    this.assistant.setCoachMode(Boolean(on));
    this.rebuildTelemetry();
  }

  setLeadTarget(db: unknown): void {
    let v: number;
    try {
      v = numOf(db);
    } catch {
      return;
    }
    this.assistant.leadTarget = v;
    this.assistant.emit("system", `lead target set to ${signed(v, 1)} dB`);
    this.rebuildTelemetry();
  }

  setFader(ch: number, db: unknown): void {
    if (!C.CHANNELS.has(ch)) return;
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
    this.assistant.emit("manual", `${chan(ch)} fader → ${signed(v, 1)} dB`, ch);
    const partner = EngineControls.linkedPartner(ch);
    if (partner !== null) {
      const pdb = this.con.setFaderRaw(partner, v);
      this.assistant.faderDb.set(partner, pdb);
      this.assistant.noteManual(partner, now);
      this.assistant.lastMoveT.set(partner, now);
      this.assistant.emit("manual", `${chan(partner)} linked → ${signed(pdb, 1)} dB`, partner);
    }
    this.rebuildTelemetry();
  }

  static linkedPartner(ch: number): number | null {
    for (const pair of C.STEREO_LINKS) {
      if (pair.includes(ch)) {
        for (const other of pair) if (other !== ch && C.CHANNELS.has(other)) return other;
      }
    }
    return null;
  }

  setEq(ch: number, band: number, hz: unknown = null, gain: unknown = null, q: unknown = null, on: unknown = null): void {
    const bands = this.eq.get(ch);
    if (!bands) return;
    const b = bands.get(Math.trunc(band));
    if (b === undefined) return;
    try {
      if (hz !== null && hz !== undefined) b.hz = clampf(numOf(hz), 20.0, 20000.0);
      if (gain !== null && gain !== undefined) b.gain = clampf(numOf(gain), -15.0, 15.0);
      if (q !== null && q !== undefined) b.q = clampf(numOf(q), 0.3, 10.0);
      if (on !== null && on !== undefined) b.on = truthy(on);
    } catch {
      return;
    }
    this.con.setEqBand(ch, Math.trunc(band), b.hz, b.gain, b.q, Boolean(b.on));
    this.assistant.emit(
      "manual",
      `${chan(ch)} EQ b${band}: ${fixed(b.hz, 0)} Hz ${signed(b.gain, 1)} dB Q${fixed(b.q, 1)} ${b.on ? "on" : "off"}`,
      ch,
    );
    this.rebuildTelemetry();
  }

  resetChannelEq(ch: number): void {
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
    this.assistant.emit("manual", `${chan(ch)} EQ reset to flat`, ch);
    this.rebuildTelemetry();
  }

  setSend(ch: number, fx: number, db: unknown): void {
    const sends = this.sends.get(ch);
    if (!sends || !C.FX_BUSES.has(Math.trunc(fx))) return;
    let v: number;
    try {
      v = clampf(numOf(db), -90.0, 10.0);
    } catch {
      return;
    }
    sends.set(Math.trunc(fx), v);
    this.con.setSend(ch, Math.trunc(fx), v);
    this.assistant.emit("manual", `${chan(ch)} → ${C.FX_BUSES.get(Math.trunc(fx))} ${signed(v, 0)} dB`, ch);
    this.rebuildTelemetry();
  }

  setFxWet(fx: number, db: unknown): void {
    const k = Math.trunc(fx);
    if (!C.FX_BUSES.has(k)) return;
    let v: number;
    try {
      v = clampf(numOf(db), -90.0, 10.0);
    } catch {
      return;
    }
    this.fxWet.set(k, v);
    this.con.setFxReturn(k, v);
    this.assistant.emit("manual", `${C.FX_BUSES.get(k)} return ${signed(v, 0)} dB`);
    this.rebuildTelemetry();
  }

  setMute(ch: number, on: boolean): void {
    if (!C.CHANNELS.has(ch)) return;
    this.con.setChannelMute(ch, Boolean(on));
    this.muted.set(ch, Boolean(on));
    this.assistant.noteManual(ch, this.clock.monotonic());
    this.assistant.emit("manual", `${chan(ch)} ${on ? "MUTED" : "unmuted"}`, ch);
    this.rebuildTelemetry();
  }

  setMaster(db: unknown): void {
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
    this.assistant.captureBalance(this.outputLevels());
    this.rebuildTelemetry();
  }

  reconcileFader(ch: number, db: number): void {
    if (!C.CHANNELS.has(ch)) return;
    const now = this.clock.monotonic();
    this.lastRxT = now;
    if (now - (this.assistant.lastMoveT.get(ch) ?? -1e9) < 0.8) return;
    if (Math.abs(db - (this.assistant.faderDb.get(ch) ?? 0)) < 0.5) return;
    this.assistant.faderDb.set(ch, db);
    this.assistant.noteManual(ch, now);
    if (now - (this.lastReconcileLog.get(ch) ?? -1e9) > 0.5) {
      this.lastReconcileLog.set(ch, now);
      this.assistant.emit("manual", `${chan(ch)} moved on console → ${signed(db, 1)} dB`, ch);
    }
    this.rebuildTelemetry();
  }

  resetNotches(): void {
    this.assistant.resetNotches();
    this.rebuildTelemetry();
  }

  panic(on: boolean): void {
    if (on && this.status !== "takeover") {
      this.enabledBackup = { ...this.assistant.enabled };
      for (const k of Object.keys(this.assistant.enabled)) this.assistant.enabled[k] = false;
      this.assistant.releaseUnmask();
      this.con.setMainMute(true);
      this.status = "takeover";
      this.assistant.emit("panic", "TAKEOVER — main muted, all jobs held");
    } else if (!on && this.status === "takeover") {
      this.con.setMainMute(false);
      if (this.enabledBackup !== null) Object.assign(this.assistant.enabled, this.enabledBackup);
      this.status = "live";
      this.assistant.emit("panic", "takeover released — back to live");
    }
    this.rebuildTelemetry();
  }
}
