import { appendFileSync } from "node:fs";
import { BlockAnalyser } from "../src/core/blockanalysis.ts";
import type { Frame } from "../src/core/capture.ts";
import { defaultConfig } from "../src/core/config.ts";
import { SeededRng } from "../src/core/rng.ts";
import { slowness } from "../test/timing.ts";

const cfg = defaultConfig();
const blockMs = (cfg.BLOCK / cfg.SAMPLE_RATE) * 1000;
const rng = new SeededRng(11);
const noise = (n: number, amp: number): Float32Array => Float32Array.from({ length: n }, () => amp * rng.standardNormal());

function measure(channels: number, blocks: number): number[] {
  const chans = Array.from({ length: channels }, (_, i) => i + 1);
  const frame: Frame = new Map(chans.map((ch) => [ch, noise(cfg.BLOCK, 0.05 + ch * 0.01)]));
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < chans.length && pairs.length < 4; i += 2) pairs.push([chans[i]!, chans[i + 1]!]);
  const a = new BlockAnalyser(cfg);
  const config = { channels: chans, measCh: chans.at(-1)!, phasePairs: pairs, sampleRate: cfg.SAMPLE_RATE };
  for (let i = 0; i < 50; i++) a.analyse(frame, config);
  const times: number[] = [];
  for (let i = 0; i < blocks; i++) {
    const t0 = performance.now();
    a.analyse(frame, config);
    times.push(performance.now() - t0);
  }
  return times.sort((x, y) => x - y);
}

const pct = (xs: number[], p: number): number => xs[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))]!;

const factor = slowness();
const rows = [3, 8, 16, 32].map((n) => {
  const t = measure(n, 400);
  const p50 = pct(t, 50);
  const p99 = pct(t, 99);
  return { n, p50, p99, share: p99 / blockMs, normalised: p99 / factor / blockMs };
});
const lines = [
  "## Block analysis time",
  "",
  `One block is ${blockMs.toFixed(1)} ms of audio. This runner is ${factor.toFixed(2)}x the reference speed (calibration workload).`,
  "",
  "| Channels | median ms | 99th pct ms | share of a block | share, normalised |",
  "|---:|---:|---:|---:|---:|",
  ...rows.map((r) => `| ${r.n} | ${r.p50.toFixed(2)} | ${r.p99.toFixed(2)} | ${(r.share * 100).toFixed(1)}% | ${(r.normalised * 100).toFixed(1)}% |`),
  "",
  "Report only: nothing fails on these numbers yet. After about 20 runs they become the baseline to gate against.",
];
process.stdout.write(lines.join("\n") + "\n");
const summary = process.env["GITHUB_STEP_SUMMARY"];
if (summary) appendFileSync(summary, lines.join("\n") + "\n");
