import { Worker } from "node:worker_threads";
import type { CapturePort, FromCapture } from "../core/capturelink.ts";

export type CaptureKind = "native" | "timed";

export function captureThread(kind: CaptureKind): CapturePort {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const worker = new Worker(new URL(`./audioworker${ext}`, import.meta.url), { workerData: { kind } });
  return {
    post: (message) => worker.postMessage(message),
    onMessage: (handler) => void worker.on("message", (message: FromCapture) => handler(message)),
    onExit: (handler) => {
      worker.on("error", (err: unknown) => handler(err instanceof Error ? err.message : String(err)));
      worker.on("exit", (code) => handler(`exit code ${code}`));
    },
    close: () => void worker.terminate(),
  };
}
