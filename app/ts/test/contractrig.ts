import type { Clock } from "../src/core/clock.ts";
import { defaultConfig } from "../src/core/config.ts";
import { RecordingUdpFactory, buildFixture, runProbes } from "../src/core/contract.ts";
import type { ContractFixture } from "../src/core/contract.ts";
import { EmulatedDesk } from "../src/core/emulator.ts";
import { MemNetwork } from "../src/core/memtransport.ts";

export const PROBE_STEP = "contract probes";

export async function emulatorFixture(): Promise<ContractFixture> {
  const net = new MemNetwork();
  const clock: Clock = {
    monotonic: () => 0,
    highResolution: () => 0,
    time: () => 1_764_273_600,
    hhmmss: () => "00:00:00",
    sleep: () => net.settle(),
  };
  const desk = new EmulatedDesk(net, clock, { cfg: defaultConfig(), listenPort: 0, localIp: "10.0.0.5" });
  await desk.start();
  const rec = new RecordingUdpFactory(net);
  rec.step = PROBE_STEP;
  try {
    await runProbes(rec, { host: "127.0.0.1", port: desk.listenPort }, clock, 0, 0);
    await net.settle();
  } finally {
    desk.stop();
  }
  return buildFixture(rec.exchanges, "emulator");
}
