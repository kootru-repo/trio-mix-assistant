import { parentPort, workerData } from "node:worker_threads";
import { CaptureHost } from "../core/capturelink.ts";
import type { FromCapture, ToCapture } from "../core/capturelink.ts";
import { C } from "../core/config.ts";
import type { AudioInputFactory } from "../core/devicecapture.ts";
import { TimedAudioFactory } from "../core/timedaudio.ts";
import { NativeAudioInputFactory } from "./audiodevice.ts";
import { SystemClock, threadStamp } from "./clock.ts";

const port = parentPort;
if (port === null) throw new Error("the audio worker must be started as a worker thread");

const kind: unknown = (workerData as { kind?: unknown } | null)?.kind;
const clock = new SystemClock();
const factory: AudioInputFactory = kind === "timed" ? new TimedAudioFactory(clock) : await NativeAudioInputFactory.create();
const host = new CaptureHost(factory, clock, (message: FromCapture) => port.postMessage(message), threadStamp);

port.on("message", (message: ToCapture) => {
  if (message.type === "open") C.MEAS_MIC_CH = message.config.measCh;
  host.handle(message);
});
