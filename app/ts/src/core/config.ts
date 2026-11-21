export interface ChannelMapSpec {
  map?: Record<string, string> | null;
  labels?: Record<string, string> | null;
  lead?: number | null;
  meas_mic?: number | null;
  balance?: readonly number[] | null;
  guest?: readonly number[] | null;
  stereo_links?: readonly (readonly number[])[] | null;
  stage_mic?: number | null;
  phase_pairs?: readonly (readonly number[])[] | null;
}

export interface Config {
  CONSOLE_IP: string;
  CONSOLE_PORT: number;
  LOCAL_PORT: number;
  ABLESET_PORT: number;
  SAMPLE_RATE: number;
  BLOCK: number;
  X32_SERVER_VER: string;
  X32_NAME: string;
  X32_MODEL: string;
  X32_FW: string;
  CHANNELS: Map<number, string>;
  ROLE_LABELS: Map<string, string>;
  LEAD_VOCAL_CH: number;
  MEAS_MIC_CH: number;
  MAIN_BUS: string;
  BALANCE_CHANNELS: readonly number[];
  GUEST_CHANNELS: readonly number[];
  STEREO_LINKS: readonly (readonly number[])[];
  STAGE_MIC_CH: number | null;
  STAGE_RISE_DB: number;
  PHASE_PAIRS: readonly (readonly number[])[];
  FX_BUSES: Map<number, string>;
  CHANNEL_EQ_BANDS: number;
  EQ_DEFAULT_FREQS: readonly number[];
  LEAD_TARGET_DB: number;
  LEAD_TOLERANCE: number;
  FADER_MIN_DB: number;
  FADER_MAX_DB: number;
  MAX_STEP_DB: number;
  RAMP_MS: number;
  HEADAMP_MIN_DB: number;
  HEADAMP_MAX_DB: number;
  FB_RING_DB: number;
  FB_SUSTAIN_BLOCKS: number;
  FB_NOTCH_GAIN_DB: number;
  FB_NOTCH_Q: number;
  FB_STABLE_TOL: number;
  FB_RISE_DB: number;
  FB_DETECT_FFT: number;
  FB_HARMONIC_SUSTAIN: number;
  CLIP_PEAK_DBFS: number;
  CLIP_TRIM_DB: number;
  CLIP_RECOVER_S: number;
  CLIP_RECOVER_DB: number;
  CAL_DURATION_S: number;
  CAL_OCTAVE_BANDS: readonly number[];
  CAL_MAX_CUT_DB: number;
  CAL_PEAK_THRESH: number;
  CAL_PREDIP_DB: number;
  CAL_N_PREDIP: number;
  CAL_NOISE_DBFS: number;
  PHASE_CORR_MIN: number;
  PHASE_INVERT_CORR: number;
  PHASE_COMB_LAG_MS: number;
  PHASE_MAX_LAG_MS: number;
  PHASE_EMA: number;
  PHASE_SUSTAIN: number;
  PHASE_ACT_COOLDOWN: number;
  PHASE_WARN_INTERVAL: number;
  UNMASK_CHANNELS: readonly number[];
  UNMASK_BAND: number;
  UNMASK_FREQ: number;
  UNMASK_Q: number;
  UNMASK_DEPTH_DB: number;
  UNMASK_VOX_GATE_DB: number;
  UNMASK_ATTACK: number;
  UNMASK_RELEASE: number;
  UNMASK_WRITE_EPS: number;
  COACH_TTL_S: number;
  DEFAULT_ENABLED: Record<string, boolean>;
}

export const C: Config = {
  CONSOLE_IP: "192.168.1.50",
  CONSOLE_PORT: 10023,
  LOCAL_PORT: 10024,
  ABLESET_PORT: 39051,
  SAMPLE_RATE: 48000,
  BLOCK: 1024,
  X32_SERVER_VER: "V2.07",
  X32_NAME: "MixAssist",
  X32_MODEL: "X32",
  X32_FW: "4.06-8",
  CHANNELS: new Map([
    [1, "lead_vox"],
    [2, "harm_vox_l"],
    [3, "harm_vox_r"],
    [4, "acoustic_gtr"],
    [5, "bass_di"],
    [6, "cajon"],
    [7, "keys_aux"],
    [8, "meas_mic"],
  ]),
  ROLE_LABELS: new Map([
    ["lead_vox", "Lead vocal"],
    ["harm_vox_l", "Harmony vox L"],
    ["harm_vox_r", "Harmony vox R"],
    ["acoustic_gtr", "Acoustic gtr"],
    ["bass_di", "Bass / 2nd gtr"],
    ["cajon", "Cajón / perc"],
    ["keys_aux", "Keys / aux"],
    ["meas_mic", "FOH meas mic"],
  ]),
  LEAD_VOCAL_CH: 1,
  MEAS_MIC_CH: 8,
  MAIN_BUS: "main/st",
  BALANCE_CHANNELS: [5, 7],
  GUEST_CHANNELS: [],
  STEREO_LINKS: [],
  STAGE_MIC_CH: null,
  STAGE_RISE_DB: 4.0,
  PHASE_PAIRS: [],
  FX_BUSES: new Map([
    [1, "Reverb"],
    [2, "Delay"],
  ]),
  CHANNEL_EQ_BANDS: 4,
  EQ_DEFAULT_FREQS: [120.0, 500.0, 2000.0, 8000.0],
  LEAD_TARGET_DB: -6.0,
  LEAD_TOLERANCE: 2.0,
  FADER_MIN_DB: -12.0,
  FADER_MAX_DB: 6.0,
  MAX_STEP_DB: 1.0,
  RAMP_MS: 350,
  HEADAMP_MIN_DB: -12.0,
  HEADAMP_MAX_DB: 60.0,
  FB_RING_DB: 12.0,
  FB_SUSTAIN_BLOCKS: 4,
  FB_NOTCH_GAIN_DB: -9.0,
  FB_NOTCH_Q: 8.0,
  FB_STABLE_TOL: 0.03,
  FB_RISE_DB: 0.3,
  FB_DETECT_FFT: 4096,
  FB_HARMONIC_SUSTAIN: 3,
  CLIP_PEAK_DBFS: -1.0,
  CLIP_TRIM_DB: -2.0,
  CLIP_RECOVER_S: 8.0,
  CLIP_RECOVER_DB: 0.5,
  CAL_DURATION_S: 10.0,
  CAL_OCTAVE_BANDS: [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
  CAL_MAX_CUT_DB: -6.0,
  CAL_PEAK_THRESH: 4.0,
  CAL_PREDIP_DB: -3.0,
  CAL_N_PREDIP: 2,
  CAL_NOISE_DBFS: -20.0,
  PHASE_CORR_MIN: 0.45,
  PHASE_INVERT_CORR: -0.35,
  PHASE_COMB_LAG_MS: 0.35,
  PHASE_MAX_LAG_MS: 3.0,
  PHASE_EMA: 1 / 16,
  PHASE_SUSTAIN: 8,
  PHASE_ACT_COOLDOWN: 5.0,
  PHASE_WARN_INTERVAL: 20.0,
  UNMASK_CHANNELS: [],
  UNMASK_BAND: 4,
  UNMASK_FREQ: 3000.0,
  UNMASK_Q: 1.2,
  UNMASK_DEPTH_DB: -4.0,
  UNMASK_VOX_GATE_DB: -38.0,
  UNMASK_ATTACK: 0.3,
  UNMASK_RELEASE: 0.04,
  UNMASK_WRITE_EPS: 0.3,
  COACH_TTL_S: 8.0,
  DEFAULT_ENABLED: {
    feedback: true,
    clip: true,
    vocal_ride: false,
    balance: false,
    phase: false,
    unmask: false,
  },
};

const titleCase = (s: string): string =>
  s
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/(^|[^a-z0-9])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());

const ints = (xs: readonly number[]): number[] => xs.map((x) => Math.trunc(Number(x)));
const pairs = (xs: readonly (readonly number[])[]): number[][] => xs.map((p) => ints(p));

export function applyChannelMap(spec: ChannelMapSpec): void {
  const newChans = spec.map
    ? new Map(Object.entries(spec.map).map(([k, v]) => [Math.trunc(Number(k)), String(v)] as [number, string]))
    : new Map(C.CHANNELS);
  const labels = spec.labels ?? {};
  const newLabels = new Map<string, string>();
  for (const role of newChans.values()) {
    newLabels.set(role, labels[role] ?? C.ROLE_LABELS.get(role) ?? titleCase(role));
  }
  const newLead = spec.lead != null ? Math.trunc(Number(spec.lead)) : C.LEAD_VOCAL_CH;
  const newMeas = spec.meas_mic != null ? Math.trunc(Number(spec.meas_mic)) : C.MEAS_MIC_CH;
  const newBal = "balance" in spec ? ints(spec.balance ?? []) : C.BALANCE_CHANNELS;
  const newGuest = "guest" in spec ? ints(spec.guest ?? []) : C.GUEST_CHANNELS;
  const newLinks = "stereo_links" in spec ? pairs(spec.stereo_links ?? []) : C.STEREO_LINKS;
  const newPhase = "phase_pairs" in spec ? pairs(spec.phase_pairs ?? []) : C.PHASE_PAIRS;
  let newStage: number | null;
  if ("stage_mic" in spec) {
    newStage = spec.stage_mic != null ? Math.trunc(Number(spec.stage_mic)) : null;
  } else {
    newStage = C.STAGE_MIC_CH;
  }
  C.CHANNELS = newChans;
  C.ROLE_LABELS = newLabels;
  C.LEAD_VOCAL_CH = newLead;
  C.MEAS_MIC_CH = newMeas;
  C.BALANCE_CHANNELS = newBal;
  C.GUEST_CHANNELS = newGuest;
  C.STEREO_LINKS = newLinks;
  C.STAGE_MIC_CH = newStage;
  C.PHASE_PAIRS = newPhase;
}

export function autoChannelMap(nInputs: number): ChannelMapSpec {
  const n = Math.max(1, Math.trunc(nInputs));
  let spec: ChannelMapSpec;
  if (n === 1) {
    spec = { map: { "1": "meas_mic" }, meas_mic: 1 };
  } else {
    const m: Record<string, string> = {};
    for (let i = 1; i < n; i++) m[String(i)] = `in_${i}`;
    m[String(n)] = "meas_mic";
    spec = { map: m, meas_mic: n };
  }
  spec = { ...spec, balance: [], guest: [], stereo_links: [], stage_mic: null, phase_pairs: [] };
  applyChannelMap(spec);
  return spec;
}

export interface ChannelMapState {
  channels: Map<number, string>;
  roleLabels: Map<string, string>;
  lead: number;
  meas: number;
  balance: readonly number[];
  guest: readonly number[];
  stereoLinks: readonly (readonly number[])[];
  stage: number | null;
  phasePairs: readonly (readonly number[])[];
}

export function channelMapState(): ChannelMapState {
  return {
    channels: new Map(C.CHANNELS),
    roleLabels: new Map(C.ROLE_LABELS),
    lead: C.LEAD_VOCAL_CH,
    meas: C.MEAS_MIC_CH,
    balance: C.BALANCE_CHANNELS,
    guest: C.GUEST_CHANNELS,
    stereoLinks: C.STEREO_LINKS,
    stage: C.STAGE_MIC_CH,
    phasePairs: C.PHASE_PAIRS,
  };
}

export function restoreChannelMapState(s: ChannelMapState): void {
  C.CHANNELS = new Map(s.channels);
  C.ROLE_LABELS = new Map(s.roleLabels);
  C.LEAD_VOCAL_CH = s.lead;
  C.MEAS_MIC_CH = s.meas;
  C.BALANCE_CHANNELS = s.balance;
  C.GUEST_CHANNELS = s.guest;
  C.STEREO_LINKS = s.stereoLinks;
  C.STAGE_MIC_CH = s.stage;
  C.PHASE_PAIRS = s.phasePairs;
}
