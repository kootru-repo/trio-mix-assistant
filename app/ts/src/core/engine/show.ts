import { C } from "../config.ts";
import { percent, signed } from "../numfmt.ts";
import { chan } from "../assistant/base.ts";
import type { ShowState } from "../showclock.ts";
import { songByName } from "../template.ts";
import { buildModel, watchFreqs } from "../venue.ts";
import type { VenueModel } from "../venue.ts";
import { EngineControls } from "./controls.ts";
import { intOf } from "./base.ts";

const validScene = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 99;

export class EngineShow extends EngineControls {
  onSongChange(state: ShowState): void {
    if (this.vetStatus === "running") {
      this.pendingSong = state;
      return;
    }
    this.show = {
      current: state.songName,
      next: state.nextSong,
      section: state.section,
      bpm: state.bpm,
      playing: state.playing,
      index: state.songIndex,
      scene: null,
    };
    const song = songByName(this.template, state.songName);
    const norm = (state.songName || "").trim().toLowerCase();
    const sameSong = norm === this.appliedSong;
    if (song !== null) this.show.scene = song.scene;
    if (sameSong) {
      this.rebuildTelemetry();
      return;
    }
    this.appliedSong = norm;
    this.songStartT = this.clock.monotonic();
    if (song === null) {
      this.assistant.emit("show", `song: ${state.songName || "-"} (no template entry — leaving mix as-is)`);
      this.rebuildTelemetry();
      return;
    }
    const coach = this.assistant.coachMode;
    if (song.scene !== null && this.status !== "takeover") {
      if (coach) {
        this.assistant.recommend(
          "scene",
          null,
          `Song '${song.name}' → recall scene ${song.scene} on the console.`,
          true,
          { scene: song.scene, song: song.name },
        );
      } else if (!validScene(song.scene) || !this.safeRecall(song.scene)) {
        this.show.scene = null;
      }
    }
    if (song.leadTarget !== null) this.assistant.leadTarget = song.leadTarget;
    if (song.balance.size) {
      for (const [ch, v] of song.balance) if (v !== null) this.assistant.balanceTargets.set(ch, v);
    }
    const now2 = this.clock.monotonic();
    for (const gch of C.GUEST_CHANNELS) {
      if (!C.CHANNELS.has(gch) || this.status === "takeover") continue;
      const want = !song.guest;
      if (this.muted.get(gch) === want) continue;
      if (now2 < (this.assistant.manualHoldUntil.get(gch) ?? -1e9)) continue;
      if (coach) {
        this.assistant.recommend("guest", gch, `${want ? "Mute" : "Unmute"} ${chan(gch)} for '${song.name}'.`, true, { mute: want });
      } else {
        this.con.setChannelMute(gch, want);
        this.muted.set(gch, want);
      }
    }
    const bits: string[] = [];
    if (song.scene !== null) bits.push(`scene ${song.scene}`);
    if (song.leadTarget !== null) bits.push(`lead ${signed(song.leadTarget, 1)} dB`);
    if (song.guest) bits.push("guest");
    this.assistant.emit("show", `song: ${song.name} -> ` + (bits.length ? bits.join(", ") : "no changes"));
    this.rebuildTelemetry();
  }

  recallSceneManual(index: unknown): void {
    if (this.vetBusy("scene recall")) return;
    let idx: number;
    try {
      idx = intOf(index);
    } catch {
      return;
    }
    if (this.status === "takeover") {
      this.assistant.emit("show", "scene recall blocked — takeover engaged");
      this.rebuildTelemetry();
      return;
    }
    if (!validScene(idx)) return;
    if (!this.safeRecall(idx)) {
      this.assistant.emit("show", `scene ${idx} recall failed`);
      this.rebuildTelemetry();
      return;
    }
    this.show.scene = idx;
    this.assistant.emit("show", `scene ${idx} recalled (manual)`);
    this.rebuildTelemetry();
  }

  protected safeRecall(idx: number): boolean {
    try {
      this.con.recallScene(idx);
      this.beginSync(this.clock.monotonic());
      return true;
    } catch {
      return false;
    }
  }

  applyVenueModel(model: VenueModel | null): void {
    if (model === null) return;
    this.venueModel = model;
    this.assistant.venueWatchFreqs = watchFreqs(model).slice(0, 12);
    this.assistant.emit(
      "system",
      `venue model loaded: ${model.shows} show(s), ${this.assistant.venueWatchFreqs.length} known feedback ` +
        `freq(s), confidence ${percent(model.confidence, 0)}`,
    );
    this.rebuildTelemetry();
  }

  async learnVenue(): Promise<string | null> {
    if (this.sessionLog === null || !this.venue || this.venueStore === null) return null;
    try {
      await this.sessionLog.flush();
      const model = buildModel(this.sessionLog, this.venue, this.clock.time());
      const path = this.venueStore.save(model);
      this.venueModel = model;
      return path;
    } catch (exc) {
      const reason = exc instanceof Error ? exc.message : String(exc);
      this.assistant.emit("system", `venue model could not be saved: ${reason}`);
      return null;
    }
  }

}
