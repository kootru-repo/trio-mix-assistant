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
    res.corrections.slice(0, 4).forEach(([fc, cut], i) => {
      steps.push({ band: i + 1, hz: fc, gain: cut, q: 3.0, kind: "room" });
      corrected.add(fc);
    });
    let nPredip = 0;
    for (const [fc, excess] of res.watchlist) {
      if (nPredip >= C.CAL_N_PREDIP) break;
      if (corrected.has(fc)) continue;
      steps.push({ band: 5 + nPredip, hz: fc, gain: C.CAL_PREDIP_DB, q: 6.0, kind: "predip", excess });
      nPredip++;
    }
    return steps;
  }

  apply(res: CalibrationResult, log: (msg: string) => void = () => {}): Set<number> {
    for (let band = 1; band <= 6; band++) this.con.setBusEq(band, 1000.0, 0.0, 2.0);
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
