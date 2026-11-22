import { launch } from "./launch.ts";
import { defaultIo, run } from "./main.ts";
import type { Io } from "./main.ts";

const LAUNCH_FLAGS = new Set(["--rehearse", "--list-devices"]);

export const entryFor = (argv: readonly string[]): "launch" | "run" =>
  argv.every((a) => LAUNCH_FLAGS.has(a)) ? "launch" : "run";

export async function startFromExecutable(argv: readonly string[], io: Io = defaultIo()): Promise<number> {
  io.out(`  Settings and logs are in: ${io.layout.appDir}`);
  return entryFor(argv) === "launch" ? launch(argv, io) : run(argv, io);
}
