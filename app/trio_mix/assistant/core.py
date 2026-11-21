"""The decision brain: four guard-railed jobs + a typed decision log.

Tiers (by reaction time):
  * reflex  — feedback notch, clip trim         (act within a few blocks)
  * advisory— lead-vocal ride, balance hold      (act over ~0.5 s windows)

Every move goes through the console's guardrail clamps; sizes are additionally
limited here (MAX_STEP). Every decision is logged and reversible.
"""

from __future__ import annotations

from .. import config as C
from .clarity import ClarityJobs


class MixAssistant(ClarityJobs):
    def on_features(self, ch: int, feat, now: float) -> None:
        if ch == C.MEAS_MIC_CH:
            self._update_room(feat, now)
            self.handle_feedback(ch, feat)
            return
        if C.STAGE_MIC_CH is not None and ch == C.STAGE_MIC_CH:
            self.handle_stage_volume(feat, now)
            return
        self.handle_feedback(ch, feat)
        self.handle_clip(ch, feat, now)
        if ch == C.LEAD_VOCAL_CH:
            self.handle_vocal_ride(feat, now)
            self.handle_unmask(feat, now)
        if ch in C.BALANCE_CHANNELS:
            self.handle_balance(ch, feat, now)
