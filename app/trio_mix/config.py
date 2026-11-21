"""Rig configuration and tunable constants.

Edit these for your rig. The runtime reads CHANNELS as the single source of
truth for the channel map, so re-instrumenting the trio is a one-dict edit.
"""

CONSOLE_IP = "192.168.1.50"
CONSOLE_PORT = 10023
LOCAL_PORT = 10024
ABLESET_PORT = 39051
SAMPLE_RATE = 48000
BLOCK = 1024

X32_SERVER_VER = "V2.07"
X32_NAME = "MixAssist"
X32_MODEL = "X32"
X32_FW = "4.06-8"

CHANNELS = {
    1: "lead_vox",
    2: "harm_vox_l",
    3: "harm_vox_r",
    4: "acoustic_gtr",
    5: "bass_di",
    6: "cajon",
    7: "keys_aux",
    8: "meas_mic",
}
ROLE_LABELS = {
    "lead_vox": "Lead vocal",
    "harm_vox_l": "Harmony vox L",
    "harm_vox_r": "Harmony vox R",
    "acoustic_gtr": "Acoustic gtr",
    "bass_di": "Bass / 2nd gtr",
    "cajon": "Cajón / perc",
    "keys_aux": "Keys / aux",
    "meas_mic": "FOH meas mic",
}

LEAD_VOCAL_CH = 1
MEAS_MIC_CH = 8
MAIN_BUS = "main/st"
BALANCE_CHANNELS: tuple[int, ...] = (5, 7)

GUEST_CHANNELS: tuple[int, ...] = ()
STEREO_LINKS: tuple[tuple[int, ...], ...] = ()
STAGE_MIC_CH: int | None = None
STAGE_RISE_DB = 4.0
PHASE_PAIRS: tuple[tuple[int, ...], ...] = ()

FX_BUSES = {1: "Reverb", 2: "Delay"}
CHANNEL_EQ_BANDS = 4
EQ_DEFAULT_FREQS = (120.0, 500.0, 2000.0, 8000.0)


def apply_channel_map(spec: dict) -> None:
    """Replace the active channel map from a show template's `channels` block.
    MUST be called before constructing the Engine (every reader takes C.* at
    construction/runtime, so mutating these globals in place propagates). Lets a
    13-input AutoFOH rig and the 8-ch trio be the same code, config-only."""
    global LEAD_VOCAL_CH, MEAS_MIC_CH, BALANCE_CHANNELS
    global GUEST_CHANNELS, STEREO_LINKS, STAGE_MIC_CH, PHASE_PAIRS
    new_chans = (
        {int(k): str(v) for k, v in spec["map"].items()} if spec.get("map") else dict(CHANNELS)
    )
    labels = spec.get("labels") or {}
    new_labels = {
        r: labels.get(r, ROLE_LABELS.get(r, r.replace("_", " ").title()))
        for r in new_chans.values()
    }
    new_lead = int(spec["lead"]) if spec.get("lead") is not None else LEAD_VOCAL_CH
    new_meas = int(spec["meas_mic"]) if spec.get("meas_mic") is not None else MEAS_MIC_CH
    new_bal = (
        tuple(int(x) for x in (spec["balance"] or ())) if "balance" in spec else BALANCE_CHANNELS
    )
    new_guest = tuple(int(x) for x in (spec["guest"] or ())) if "guest" in spec else GUEST_CHANNELS
    new_links = (
        tuple(tuple(int(x) for x in pair) for pair in (spec["stereo_links"] or ()))
        if "stereo_links" in spec
        else STEREO_LINKS
    )
    new_phase = (
        tuple(tuple(int(x) for x in pair) for pair in (spec["phase_pairs"] or ()))
        if "phase_pairs" in spec
        else PHASE_PAIRS
    )
    if "stage_mic" in spec:
        sm = spec["stage_mic"]
        new_stage = int(sm) if sm is not None else None
    else:
        new_stage = STAGE_MIC_CH
    CHANNELS.clear()
    CHANNELS.update(new_chans)
    ROLE_LABELS.clear()
    ROLE_LABELS.update(new_labels)
    LEAD_VOCAL_CH, MEAS_MIC_CH, BALANCE_CHANNELS = new_lead, new_meas, new_bal
    GUEST_CHANNELS, STEREO_LINKS, STAGE_MIC_CH = new_guest, new_links, new_stage
    PHASE_PAIRS = new_phase


def auto_channel_map(n_inputs: int) -> dict:
    """Build + apply a channel map sized to a detected device: the last input is
    the measurement mic, the rest are generic inputs. 1 input -> meas-mic only."""
    n = max(1, int(n_inputs))
    if n == 1:
        spec = {"map": {"1": "meas_mic"}, "meas_mic": 1}
    else:
        m = {str(i): f"in_{i}" for i in range(1, n)}
        m[str(n)] = "meas_mic"
        spec = {"map": m, "meas_mic": n}
    spec.update(
        {"balance": [], "guest": [], "stereo_links": [], "stage_mic": None, "phase_pairs": []}
    )
    apply_channel_map(spec)
    return spec


def channel_map_state() -> tuple:
    """Snapshot the channel-map globals (for test isolation / restore)."""
    return (
        dict(CHANNELS),
        dict(ROLE_LABELS),
        LEAD_VOCAL_CH,
        MEAS_MIC_CH,
        BALANCE_CHANNELS,
        GUEST_CHANNELS,
        STEREO_LINKS,
        STAGE_MIC_CH,
        PHASE_PAIRS,
    )


def restore_channel_map_state(s: tuple) -> None:
    global LEAD_VOCAL_CH, MEAS_MIC_CH, BALANCE_CHANNELS
    global GUEST_CHANNELS, STEREO_LINKS, STAGE_MIC_CH, PHASE_PAIRS
    CHANNELS.clear()
    CHANNELS.update(s[0])
    ROLE_LABELS.clear()
    ROLE_LABELS.update(s[1])
    (
        LEAD_VOCAL_CH,
        MEAS_MIC_CH,
        BALANCE_CHANNELS,
        GUEST_CHANNELS,
        STEREO_LINKS,
        STAGE_MIC_CH,
        PHASE_PAIRS,
    ) = s[2:]


LEAD_TARGET_DB = -6.0
LEAD_TOLERANCE = 2.0

FADER_MIN_DB = -12.0
FADER_MAX_DB = +6.0
MAX_STEP_DB = 1.0
RAMP_MS = 350
HEADAMP_MIN_DB = -12.0
HEADAMP_MAX_DB = +60.0

FB_RING_DB = 12.0
FB_SUSTAIN_BLOCKS = 4
FB_NOTCH_GAIN_DB = -9.0
FB_NOTCH_Q = 8.0
FB_STABLE_TOL = 0.03
FB_RISE_DB = 0.3
FB_DETECT_FFT = 4096
FB_HARMONIC_SUSTAIN = 3

CLIP_PEAK_DBFS = -1.0
CLIP_TRIM_DB = -2.0
CLIP_RECOVER_S = 8.0
CLIP_RECOVER_DB = 0.5

CAL_DURATION_S = 10.0
CAL_OCTAVE_BANDS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
CAL_MAX_CUT_DB = -6.0
CAL_PEAK_THRESH = 4.0
CAL_PREDIP_DB = -3.0
CAL_N_PREDIP = 2
CAL_NOISE_DBFS = -20.0

PHASE_CORR_MIN = 0.45
PHASE_INVERT_CORR = -0.35
PHASE_COMB_LAG_MS = 0.35
PHASE_MAX_LAG_MS = 3.0
PHASE_EMA = 1 / 16
PHASE_SUSTAIN = 8
PHASE_ACT_COOLDOWN = 5.0
PHASE_WARN_INTERVAL = 20.0

UNMASK_CHANNELS: tuple[int, ...] = ()
UNMASK_BAND = 4
UNMASK_FREQ = 3000.0
UNMASK_Q = 1.2
UNMASK_DEPTH_DB = -4.0
UNMASK_VOX_GATE_DB = -38.0
UNMASK_ATTACK = 0.30
UNMASK_RELEASE = 0.04
UNMASK_WRITE_EPS = 0.3

COACH_TTL_S = 8.0

DEFAULT_ENABLED = {
    "feedback": True,
    "clip": True,
    "vocal_ride": False,
    "balance": False,
    "phase": False,
    "unmask": False,
}
