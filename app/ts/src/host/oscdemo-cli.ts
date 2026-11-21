import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { C } from "../core/config.ts";
import { OscConsole } from "../core/console.ts";
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
  const ip = values.ip ?? "127.0.0.1";
  const clock = new SystemClock();
  const con = new OscConsole(new UdpSink(ip, C.CONSOLE_PORT), { clock });
  console.log(`Sending to ${ip}:${C.CONSOLE_PORT} via the app's OSC encoder.`);
  if (values.animate) {
    const signal = { aborted: false };
    process.once("SIGINT", () => {
      signal.aborted = true;
    });
    await animate(con, clock, Number(values.channels ?? 8), signal, (l) => console.log(l));
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
