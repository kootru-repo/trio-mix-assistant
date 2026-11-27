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

export interface TuningOverride {
  path: string;
  value: number;
  source: string;
}

export type RideConfig = {
  leadTargetDb: number;
  toleranceDb: number;
  leadTargetMinDb: number;
  leadTargetMaxDb: number;
  maxStepDb: number;
  rampMs: number;
  ema: number;
  minMoveDb: number;
  vocalIntervalS: number;
  balanceIntervalS: number;
};

export type LimitsConfig = {
  faderMinDb: number;
  faderMaxDb: number;
  headampMinDb: number;
  headampMaxDb: number;
};

export type ManualConfig = {
  holdS: number;
  echoS: number;
  minDb: number;
  logIntervalS: number;
};

export type StageConfig = {
  riseDb: number;
  baselineEma: number;
  warnIntervalS: number;
};

export type FeedbackConfig = {
  ringDb: number;
  sustainBlocks: number;
  notchGainDb: number;
  notchQ: number;
  stableTol: number;
  riseDb: number;
  detectFft: number;
  harmonicSustain: number;
  watchTol: number;
  lowConf: number;
  confFloor: number;
  buildingStreak: number;
  notchRecentS: number;
};

export type RoomConfig = {
  ema: number;
  quietDb: number;
  loudDb: number;
  loudMin: number;
  flatMin: number;
  lowConf: number;
  lowConfWarnS: number;
};

export type ClipConfig = {
  peakDbfs: number;
  trimDb: number;
  trimCooldownS: number;
  recoverS: number;
  recoverDb: number;
  recoverMarginDb: number;
  recentS: number;
};

export type CalibrationConfig = {
  durationS: number;
  octaveBands: readonly number[];
  maxCutDb: number;
  peakThreshDb: number;
  predipDb: number;
  predipCount: number;
  noiseDbfs: number;
  settleS: number;
  minLevelDbfs: number;
  roomBands: number;
  roomQ: number;
  predipQ: number;
};

export type PhaseConfig = {
  corrMin: number;
  invertCorr: number;
  combLagMs: number;
  maxLagMs: number;
  ema: number;
  sustain: number;
  actCooldownS: number;
  warnIntervalS: number;
};

export type UnmaskConfig = {
  band: number;
  freq: number;
  q: number;
  depthDb: number;
  voxGateDb: number;
  attack: number;
  release: number;
  writeEpsDb: number;
  voxEma: number;
  logDb: number;
  logIntervalS: number;
};

export type CoachConfig = {
  ttlS: number;
};

export type ShowConfig = {
  openingBars: number;
  openingFallbackS: number;
};

export type EngineConfig = {
  deadCriticalS: number;
  latencyEma: number;
  perfEma: number;
  perfMaxDecay: number;
};

export type LinkConfig = {
  probeS: number;
  staleS: number;
  downS: number;
  steadyS: number;
  syncRetryS: number;
  syncTries: number;
  resyncS: number;
};

export type SafetyConfig = {
  manualPerS: number;
  manualBurst: number;
  autoPerS: number;
  autoBurst: number;
  totalPerS: number;
  repeatS: number;
  stormS: number;
  echoTolDb: number;
  echoWindowS: number;
  lockMoves: number;
  lockWindowS: number;
  maxLagS: number;
  wallJumpS: number;
  rampLateS: number;
  rampOverrunS: number;
  commandPerS: number;
  commandBurst: number;
};

export type Tuning = {
  ride: Readonly<RideConfig>;
  limits: Readonly<LimitsConfig>;
  manual: Readonly<ManualConfig>;
  stage: Readonly<StageConfig>;
  feedback: Readonly<FeedbackConfig>;
  room: Readonly<RoomConfig>;
  clip: Readonly<ClipConfig>;
  calibration: Readonly<CalibrationConfig>;
  phase: Readonly<PhaseConfig>;
  unmask: Readonly<UnmaskConfig>;
  coach: Readonly<CoachConfig>;
  show: Readonly<ShowConfig>;
  engine: Readonly<EngineConfig>;
  link: Readonly<LinkConfig>;
  safety: Readonly<SafetyConfig>;
};

export interface Config extends Tuning {
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
  PHASE_PAIRS: readonly (readonly number[])[];
  UNMASK_CHANNELS: readonly number[];
  FX_BUSES: Map<number, string>;
  CHANNEL_EQ_BANDS: number;
  BUS_EQ_BANDS: number;
  EQ_DEFAULT_FREQS: readonly number[];
  EQ_FLAT_FREQ: number;
  EQ_FLAT_Q: number;
  DEFAULT_ENABLED: Record<string, boolean>;
  TUNED: readonly TuningOverride[];
}

export function defaultTuning(): Tuning {
  return {
    ride: Object.freeze({
      leadTargetDb: -6.0,
      toleranceDb: 2.0,
      leadTargetMinDb: -40.0,
      leadTargetMaxDb: 10.0,
      maxStepDb: 1.0,
      rampMs: 350,
      ema: 1 / 24,
      minMoveDb: 0.05,
      vocalIntervalS: 0.25,
      balanceIntervalS: 1.0,
    }),
    limits: Object.freeze({
      faderMinDb: -12.0,
      faderMaxDb: 6.0,
      headampMinDb: -12.0,
      headampMaxDb: 60.0,
    }),
    manual: Object.freeze({
      holdS: 5.0,
      echoS: 0.8,
      minDb: 0.5,
      logIntervalS: 0.5,
    }),
    stage: Object.freeze({
      riseDb: 4.0,
      baselineEma: 0.001,
      warnIntervalS: 30.0,
    }),
    feedback: Object.freeze({
      ringDb: 12.0,
      sustainBlocks: 4,
      notchGainDb: -9.0,
      notchQ: 8.0,
      stableTol: 0.03,
      riseDb: 0.3,
      detectFft: 4096,
      harmonicSustain: 3,
      watchTol: 0.06,
      lowConf: 0.7,
      confFloor: 0.3,
      buildingStreak: 2,
      notchRecentS: 2.0,
    }),
    room: Object.freeze({
      ema: 1 / 12,
      quietDb: -45.0,
      loudDb: -15.0,
      loudMin: 0.3,
      flatMin: 0.5,
      lowConf: 0.5,
      lowConfWarnS: 30.0,
    }),
    clip: Object.freeze({
      peakDbfs: -1.0,
      trimDb: -2.0,
      trimCooldownS: 0.25,
      recoverS: 8.0,
      recoverDb: 0.5,
      recoverMarginDb: 6.0,
      recentS: 1.5,
    }),
    calibration: Object.freeze({
      durationS: 10.0,
      octaveBands: Object.freeze([31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]),
      maxCutDb: -6.0,
      peakThreshDb: 4.0,
      predipDb: -3.0,
      predipCount: 2,
      noiseDbfs: -20.0,
      settleS: 1.2,
      minLevelDbfs: -50.0,
      roomBands: 4,
      roomQ: 3.0,
      predipQ: 6.0,
    }),
    phase: Object.freeze({
      corrMin: 0.45,
      invertCorr: -0.35,
      combLagMs: 0.35,
      maxLagMs: 3.0,
      ema: 1 / 16,
      sustain: 8,
      actCooldownS: 5.0,
      warnIntervalS: 20.0,
    }),
    unmask: Object.freeze({
      band: 4,
      freq: 3000.0,
      q: 1.2,
      depthDb: -4.0,
      voxGateDb: -38.0,
      attack: 0.3,
      release: 0.04,
      writeEpsDb: 0.3,
      voxEma: 1 / 6,
      logDb: -1.0,
      logIntervalS: 10.0,
    }),
    coach: Object.freeze({
      ttlS: 8.0,
    }),
    show: Object.freeze({
      openingBars: 8,
      openingFallbackS: 16.0,
    }),
    engine: Object.freeze({
      deadCriticalS: 1.5,
      latencyEma: 0.2,
      perfEma: 0.1,
      perfMaxDecay: 0.999,
    }),
    link: Object.freeze({
      probeS: 0.75,
      staleS: 1.5,
      downS: 5.0,
      steadyS: 1.0,
      syncRetryS: 0.5,
      syncTries: 3,
      resyncS: 5.0,
    }),
    safety: Object.freeze({
      manualPerS: 100,
      manualBurst: 50,
      autoPerS: 150,
      autoBurst: 75,
      totalPerS: 250,
      repeatS: 1.0,
      stormS: 2.0,
      echoTolDb: 0.3,
      echoWindowS: 2.0,
      lockMoves: 3,
      lockWindowS: 60.0,
      maxLagS: 1.0,
      wallJumpS: 2.0,
      rampLateS: 0.5,
      rampOverrunS: 0.25,
      commandPerS: 100,
      commandBurst: 200,
    }),
  };
}

export function defaultConfig(): Config {
  return {
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
    PHASE_PAIRS: [],
    UNMASK_CHANNELS: [],
    FX_BUSES: new Map([
      [1, "Reverb"],
      [2, "Delay"],
    ]),
    CHANNEL_EQ_BANDS: 4,
    BUS_EQ_BANDS: 6,
    EQ_DEFAULT_FREQS: [120.0, 500.0, 2000.0, 8000.0],
    EQ_FLAT_FREQ: 1000.0,
    EQ_FLAT_Q: 2.0,
    DEFAULT_ENABLED: {
      feedback: true,
      clip: true,
      vocal_ride: false,
      balance: false,
      phase: false,
      unmask: false,
    },
    TUNED: [],
    ...defaultTuning(),
  };
}

export function configWith(over: Partial<Config> = {}): Config {
  return { ...defaultConfig(), ...over };
}

export function copyConfig(cfg: Config): Config {
  return {
    ...cfg,
    CHANNELS: new Map(cfg.CHANNELS),
    ROLE_LABELS: new Map(cfg.ROLE_LABELS),
    FX_BUSES: new Map(cfg.FX_BUSES),
    BALANCE_CHANNELS: [...cfg.BALANCE_CHANNELS],
    GUEST_CHANNELS: [...cfg.GUEST_CHANNELS],
    STEREO_LINKS: cfg.STEREO_LINKS.map((p) => [...p]),
    PHASE_PAIRS: cfg.PHASE_PAIRS.map((p) => [...p]),
    UNMASK_CHANNELS: [...cfg.UNMASK_CHANNELS],
    EQ_DEFAULT_FREQS: [...cfg.EQ_DEFAULT_FREQS],
    DEFAULT_ENABLED: { ...cfg.DEFAULT_ENABLED },
    TUNED: cfg.TUNED.map((o) => ({ ...o })),
  };
}

const titleCase = (s: string): string =>
  s
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/(^|[^a-z0-9])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());

const ints = (xs: readonly number[]): number[] => xs.map((x) => Math.trunc(Number(x)));
const pairs = (xs: readonly (readonly number[])[]): number[][] => xs.map((p) => ints(p));

export function applyChannelMap(spec: ChannelMapSpec, target: Config): void {
  const cfg = target;
  const newChans = spec.map
    ? new Map(Object.entries(spec.map).map(([k, v]) => [Math.trunc(Number(k)), String(v)] as [number, string]))
    : new Map(cfg.CHANNELS);
  const labels = spec.labels ?? {};
  const newLabels = new Map<string, string>();
  for (const role of newChans.values()) {
    newLabels.set(role, labels[role] ?? cfg.ROLE_LABELS.get(role) ?? titleCase(role));
  }
  const keys = [...newChans.keys()];
  if (!keys.length) throw new Error("the channel map has no channels");
  const wantLead = spec.lead != null ? Math.trunc(Number(spec.lead)) : cfg.LEAD_VOCAL_CH;
  const wantMeas = spec.meas_mic != null ? Math.trunc(Number(spec.meas_mic)) : cfg.MEAS_MIC_CH;
  const newLead = newChans.has(wantLead) ? wantLead : Math.min(...keys);
  const newMeas = newChans.has(wantMeas) ? wantMeas : Math.max(...keys);
  const newBal = "balance" in spec ? ints(spec.balance ?? []) : cfg.BALANCE_CHANNELS;
  const newGuest = "guest" in spec ? ints(spec.guest ?? []) : cfg.GUEST_CHANNELS;
  const newLinks = "stereo_links" in spec ? pairs(spec.stereo_links ?? []) : cfg.STEREO_LINKS;
  const newPhase = "phase_pairs" in spec ? pairs(spec.phase_pairs ?? []) : cfg.PHASE_PAIRS;
  let newStage: number | null;
  if ("stage_mic" in spec) {
    newStage = spec.stage_mic != null ? Math.trunc(Number(spec.stage_mic)) : null;
  } else {
    newStage = cfg.STAGE_MIC_CH;
  }
  cfg.CHANNELS = newChans;
  cfg.ROLE_LABELS = newLabels;
  cfg.LEAD_VOCAL_CH = newLead;
  cfg.MEAS_MIC_CH = newMeas;
  cfg.BALANCE_CHANNELS = newBal;
  cfg.GUEST_CHANNELS = newGuest;
  cfg.STEREO_LINKS = newLinks;
  cfg.STAGE_MIC_CH = newStage;
  cfg.PHASE_PAIRS = newPhase;
}

export function autoChannelMap(nInputs: number, target: Config): ChannelMapSpec {
  const n = Math.max(1, Math.trunc(nInputs));
  let spec: ChannelMapSpec;
  if (n === 1) {
    spec = { map: { "1": "meas_mic" }, lead: 1, meas_mic: 1 };
  } else {
    const m: Record<string, string> = {};
    for (let i = 1; i < n; i++) m[String(i)] = `in_${i}`;
    m[String(n)] = "meas_mic";
    spec = { map: m, lead: 1, meas_mic: n };
  }
  spec = { ...spec, balance: [], guest: [], stereo_links: [], stage_mic: null, phase_pairs: [] };
  applyChannelMap(spec, target);
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

export function channelMapState(source: Config): ChannelMapState {
  const cfg = source;
  return {
    channels: new Map(cfg.CHANNELS),
    roleLabels: new Map(cfg.ROLE_LABELS),
    lead: cfg.LEAD_VOCAL_CH,
    meas: cfg.MEAS_MIC_CH,
    balance: [...cfg.BALANCE_CHANNELS],
    guest: [...cfg.GUEST_CHANNELS],
    stereoLinks: cfg.STEREO_LINKS.map((p) => [...p]),
    stage: cfg.STAGE_MIC_CH,
    phasePairs: cfg.PHASE_PAIRS.map((p) => [...p]),
  };
}

export function restoreChannelMapState(s: ChannelMapState, target: Config): void {
  const cfg = target;
  cfg.CHANNELS = new Map(s.channels);
  cfg.ROLE_LABELS = new Map(s.roleLabels);
  cfg.LEAD_VOCAL_CH = s.lead;
  cfg.MEAS_MIC_CH = s.meas;
  cfg.BALANCE_CHANNELS = [...s.balance];
  cfg.GUEST_CHANNELS = [...s.guest];
  cfg.STEREO_LINKS = s.stereoLinks.map((p) => [...p]);
  cfg.STAGE_MIC_CH = s.stage;
  cfg.PHASE_PAIRS = s.phasePairs.map((p) => [...p]);
}
