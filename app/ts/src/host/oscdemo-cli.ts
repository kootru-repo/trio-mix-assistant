import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { defaultConfig } from "../core/config.ts";
import { OscConsole } from "../core/console.ts";
import { parseInteger } from "../core/util.ts";
import { SystemClock } from "./clock.ts";
import { animate, oneShot } from "./oscdemo.ts";
import { UdpSink } from "./udpsink.ts";

export async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { ip: { type: "string" }, animate: { type: "boolean" }, channels: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  const channels = values.channels === undefined ? 8 : parseInteger(values.channels);
  if (channels === null || channels < 1 || channels > 32) {
    console.error("usage: osc-demo [--ip <address>] [--animate] [--channels <1-32>]");
    return 2;
  }
  const ip = values.ip ?? "127.0.0.1";
  const clock = new SystemClock();
  const cfg = defaultConfig();
  const con = new OscConsole(new UdpSink(ip, cfg.CONSOLE_PORT), { clock, cfg });
  console.log(`Sending to ${ip}:${cfg.CONSOLE_PORT} via the app's OSC encoder.`);
  if (values.animate) {
    const signal = { aborted: false };
    process.once("SIGINT", () => {
      signal.aborted = true;
    });
    await animate(con, clock, channels, signal, (l) => console.log(l));
  } else {
    oneShot(con, (l) => console.log(l));
    console.log("Done. (Use --animate for continuous movement.)");
    await clock.sleep(0.2);
  }
  con.close();
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(2);
    },
  );
}
