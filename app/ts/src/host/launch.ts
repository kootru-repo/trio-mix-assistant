import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildArgv, ConfError, readConf } from "./launcher.ts";
import { defaultIo, run } from "./main.ts";
import type { Io } from "./main.ts";

export function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    return;
  }
}

export async function launch(argv: readonly string[], io: Io, open: (url: string) => void = openBrowser): Promise<number> {
  if (argv.includes("--list-devices")) return run(["--list-devices"], io);
  const cfg = readConf(join(io.layout.appDir, "show.conf"));
  const rehearse = argv.includes("--rehearse");
  let plan;
  try {
    plan = buildArgv(cfg, io.layout.appDir, rehearse, (l) => io.out(l));
  } catch (exc) {
    if (exc instanceof ConfError) {
      io.out("  [!] " + exc.message);
      return 2;
    }
    throw exc;
  }
  const scheme = plan.argv.includes("--https") ? "https" : "http";
  io.out("=".repeat(60));
  io.out("  Trio Mix-Assistant — " + (rehearse ? "REHEARSE (emulator)" : plan.mode.toUpperCase()));
  io.out(`  Dashboard: ${scheme}://127.0.0.1:${plan.port}/   (and the LAN URL/QR below)`);
  io.out("  Press Ctrl+C in this window to stop.");
  io.out("=".repeat(60));
  return run(plan.argv, { ...io, onListening: open });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  launch(process.argv.slice(2), defaultIo()).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error("Could not start the app:", err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
