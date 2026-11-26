import { C } from "./config.ts";
import type { ConsoleBase } from "./console.ts";
import { findResonantPeaks, octaveBandLevels } from "./dsp.ts";
import type { BandPair, Samples } from "./dsp.ts";
import { fixed, signed } from "./numfmt.ts";

export interface CalibrationResult {
  baseline: Map<number, number>;
  corrections: BandPair[];
  watchlist: BandPair[];
}

export const watchFreqs = (r: CalibrationResult): number[] => r.watchlist.map(([f]) => f);

export interface CalibrationStep {
  band: number;
  hz: number;
  gain: number;
  q: number;
  kind: "room" | "predip";
  excess?: number;
}

export class Calibrator {
  private readonly con: ConsoleBase;

  constructor(console: ConsoleBase) {
    this.con = console;
  }

  analyze(captured: Samples): CalibrationResult {
    const baseline = octaveBandLevels(captured);
    const { corrections, watchlist } = findResonantPeaks(captured, C.SAMPLE_RATE, baseline);
    return { baseline, corrections, watchlist };
  }

  plan(res: CalibrationResult): CalibrationStep[] {
    const steps: CalibrationStep[] = [];
    const corrected = new Set<number>();
    res.corrections.slice(0, C.calibration.roomBands).forEach(([fc, cut], i) => {
      steps.push({ band: i + 1, hz: fc, gain: cut, q: C.calibration.roomQ, kind: "room" });
      corrected.add(fc);
    });
    let nPredip = 0;
    for (const [fc, excess] of res.watchlist) {
      if (nPredip >= C.calibration.predipCount) break;
      if (corrected.has(fc)) continue;
      steps.push({ band: C.calibration.roomBands + 1 + nPredip, hz: fc, gain: C.calibration.predipDb, q: C.calibration.predipQ, kind: "predip", excess });
      nPredip++;
    }
    return steps;
  }

  apply(res: CalibrationResult, log: (msg: string) => void = () => {}): Set<number> {
    for (let band = 1; band <= C.BUS_EQ_BANDS; band++) this.con.setBusEq(band, C.EQ_FLAT_FREQ, 0.0, C.EQ_FLAT_Q);
    const used = new Set<number>();
    for (const s of this.plan(res)) {
      this.con.setBusEq(s.band, s.hz, s.gain, s.q);
      used.add(s.band);
      if (s.kind === "room") {
        log(`bus EQ ${s.band}: ${fixed(s.hz, 0)} Hz ${signed(s.gain, 1)} dB`);
      } else {
        log(`pre-dip ${s.band}: ${fixed(s.hz, 0)} Hz ${signed(s.gain, 1)} dB (excess ${fixed(s.excess ?? 0, 1)} dB)`);
      }
    }
    return used;
  }
}
