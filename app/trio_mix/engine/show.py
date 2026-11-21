"""Show flow: song changes, scene recall, venue learning, advisory notes."""

from __future__ import annotations

import contextlib
import logging

from .. import config as C
from .. import venue as venuemod
from .controls import EngineControls

_log = logging.getLogger(__name__)


class EngineShow(EngineControls):
    """Show flow: song changes, scene recall, venue learning, advisory notes."""

    def on_song_change(self, state) -> None:
        """A show clock (AbleSet or the simulator) reports the current song.
        Recall the template's scene for it and apply that song's reference levels
        — exactly once per song (section/bpm updates for the same song don't
        re-recall). Skips the recall during a takeover so we never fight the op."""
        with self._lock:
            self.show = {
                "current": state.song_name,
                "next": state.next_song,
                "section": state.section,
                "bpm": state.bpm,
                "playing": state.playing,
                "index": state.song_index,
                "scene": None,
            }
            song = self.template.song_by_name(state.song_name)
            norm = (state.song_name or "").strip().lower()
            same_song = norm == self._applied_song
            if song is not None:
                self.show["scene"] = song.scene
            if same_song:
                self._rebuild_telemetry()
                return
            self._applied_song = norm
            self._song_start_t = self.clock.monotonic()
            if song is None:
                self.assistant._emit(
                    "show",
                    f"song: {state.song_name or '-'} (no template entry — leaving mix as-is)",
                )
                self._rebuild_telemetry()
                return
            coach = self.assistant.coach_mode
            if song.scene is not None and self.status != "takeover":
                if coach:
                    self.assistant._recommend(
                        "scene",
                        None,
                        f"Song '{song.name}' → recall scene {song.scene} on the console.",
                        persist=True,
                        scene=song.scene,
                        song=song.name,
                    )
                else:
                    self._safe_recall(song.scene)
            if song.lead_target is not None:
                self.assistant.lead_target = song.lead_target
            if song.balance:
                self.assistant.balance_targets.update(dict(song.balance))
            now2 = self.clock.monotonic()
            for gch in C.GUEST_CHANNELS:
                if gch not in C.CHANNELS or self.status == "takeover":
                    continue
                want = not song.guest
                if self.muted.get(gch) == want:
                    continue
                if now2 < self.assistant.manual_hold_until.get(gch, -1e9):
                    continue
                if coach:
                    self.assistant._recommend(
                        "guest",
                        gch,
                        f"{'Mute' if want else 'Unmute'} {C.CHANNELS[gch]} for '{song.name}'.",
                        persist=True,
                        mute=want,
                    )
                else:
                    self.con.set_channel_mute(gch, want)
                self.muted[gch] = want
            bits = []
            if song.scene is not None:
                bits.append(f"scene {song.scene}")
            if song.lead_target is not None:
                bits.append(f"lead {song.lead_target:+.1f} dB")
            if song.guest:
                bits.append("guest")
            self.assistant._emit(
                "show", f"song: {song.name} -> " + (", ".join(bits) if bits else "no changes")
            )
            self._rebuild_telemetry()

    def recall_scene_manual(self, index) -> None:
        """Operator tapped a scene in the Scenes panel — recall it directly."""
        try:
            idx = int(index)
        except (TypeError, ValueError):
            return
        with self._lock:
            if self.status == "takeover":
                self.assistant._emit("show", "scene recall blocked — takeover engaged")
                self._rebuild_telemetry()
                return
            self._safe_recall(idx)
            self.show["scene"] = idx
            self.assistant._emit("show", f"scene {idx} recalled (manual)")
            self._rebuild_telemetry()

    def _safe_recall(self, idx: int) -> None:
        """Recall a scene, tolerating a console socket torn down during shutdown
        (a late show-clock straggler must never raise on a closed transport)."""
        with contextlib.suppress(OSError):
            self.con.recall_scene(idx)

    def apply_venue_model(self, model) -> None:
        """Seed the assistant's watch-list with a room's known feedback freqs so
        the (guard-railed) detector reacts a block sooner. Never applies cuts."""
        if model is None:
            return
        with self._lock:
            self.venue_model = model
            self.assistant.venue_watch_freqs = model.watch_freqs()[:12]
            self.assistant._emit(
                "system",
                f"venue model loaded: {model.shows} show(s), "
                f"{len(self.assistant.venue_watch_freqs)} known feedback "
                f"freq(s), confidence {model.confidence:.0%}",
            )
            self._rebuild_telemetry()

    def learn_venue(self) -> str | None:
        """Post-show: mine the session log and (re)write this venue's model."""
        if self.session_log is None or not self.venue or not self.venue_dir:
            return None
        try:
            self.session_log.flush()
            model = venuemod.build_model(self.session_log, self.venue, now=self.clock.time())
            path = venuemod.save_model(model, self.venue_dir)
            self.venue_model = model
            return path
        except Exception:
            _log.warning(
                "venue learning failed; this show was not added to the model", exc_info=True
            )
            return None

    def advisor_context(self) -> dict:
        """A compact snapshot for the Claude advisor. Taken under the lock, then
        the (slow) network call happens off-lock in the Advisor thread."""
        with self._lock:
            recent = [
                {"kind": e["kind"], "level": e.get("level"), "msg": e["msg"]}
                for e in list(self.events)[-25:]
            ]
            chans = []
            for ch, role in C.CHANNELS.items():
                feat = self._feat.get(ch)
                chans.append(
                    {
                        "role": role,
                        "rms_db": round(feat.rms_dbfs, 1) if feat else None,
                        "notched": bool(self.assistant.used_notch_band.get(ch)),
                    }
                )
            return {
                "mode": "simulation" if self.sim else "hardware",
                "show": dict(self.show),
                "alerts": list(self.telemetry.get("alerts", [])),
                "lead": dict(self.telemetry.get("lead", {})),
                "channels": chans,
                "recent_events": recent,
            }

    def on_advice(self, advice: dict) -> None:
        """Receive a note from the advisor: log it + surface it in telemetry. The
        advice is ADVISORY text only — no control action is taken from it."""
        with self._lock:
            prompt = str(advice.get("performer_prompt", "")).strip()[:200]
            sev = str(advice.get("severity", "info")).strip().lower()
            if sev not in ("info", "notice", "warn"):
                sev = "info"
            self.advisor_advice = {
                "prompt": prompt,
                "assessment": str(advice.get("room_assessment", "")).strip()[:240],
                "severity": sev,
                "time": self.clock.hhmmss(),
            }
            if prompt:
                self.assistant._emit("advisor", prompt)
            self._rebuild_telemetry()
