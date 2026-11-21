import type { Clock } from "../core/clock.ts";
import type { ConsoleBase } from "../core/console.ts";
import { signed } from "../core/pyfmt.ts";

export type Print = (line: string) => void;

export function oneShot(con: ConsoleBase, print: Print = () => undefined): void {
  print("Pushing a known set — read these back off your mixer app:");
  const set: [number, number][] = [
    [1, 0.0],
    [2, 5.0],
    [3, -10.0],
    [4, -20.0],
    [5, -40.0],
  ];
  for (const [ch, db] of set) {
    con.setFaderDb(ch, db);
    print(`  ch${ch} fader -> ${signed(db, 1)} dB`);
  }
  con.setChannelMute(6, true);
  print("  ch6 -> MUTED");
  con.setChannelMute(7, false);
  print("  ch7 -> ON");
  con.nudgeGainDb(1, 0.0, 30.0);
  print("  ch1 preamp -> +30 dB");
  con.setEqNotch(8, 1, 2500.0, -9.0, 8.0);
  print("  ch8 EQ band1 -> PEQ ~2500 Hz, -9 dB, Q 8");
  con.setBusEq(2, 125.0, -5.0, 4.0);
  print("  Main LR EQ band2 -> ~125 Hz, -5 dB, Q 4");
}

export function waveDb(t: number, ch: number): number {
  return -8.0 + 11.0 * 0.5 * (1.0 + Math.sin(t * 1.6 + ch * 0.7));
}

export async function animate(
  con: ConsoleBase,
  clock: Clock,
  channels: number,
  signal: { aborted: boolean },
  print: Print = () => undefined,
): Promise<void> {
  print(`Animating ${channels} faders — watch them wave in your mixer app. Ctrl+C to stop.`);
  const t0 = clock.time();
  while (!signal.aborted) {
    const t = clock.time() - t0;
    for (let ch = 1; ch <= channels; ch++) con.setFaderDb(ch, waveDb(t, ch));
    await clock.sleep(0.08);
  }
  print("\nstopped.");
}
