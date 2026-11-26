import type { AssistantEvent } from "./assistant/index.ts";
import type { VenueLogSource } from "./venue.ts";

export interface SessionLogPort extends VenueLogSource {
  logEvent(ev: AssistantEvent): void;
  flush(): Promise<void>;
  close(): void;
}

export const VET_EXPECTED_STEPS = 66;
export const VET_EXPECTED_STEPS_WITH_CONSOLE = 83;

export interface VetRequest {
  channel: number | null;
  gain: boolean;
  main: boolean;
  identify: boolean;
}

export interface VetSummary {
  text: string;
  summary: string;
  failed: number;
}

export interface VetControl {
  stopped(): boolean;
  takeover(): boolean;
  progress?(done: number, title: string): void;
  appState?(): string[];
}

export interface VetHostPort {
  readonly console: boolean;
  run(request: VetRequest, control: VetControl): Promise<VetSummary>;
}

export interface MeterReceiverPort {
  readonly lastError?: unknown;
  start(): Promise<void>;
  stop(): void;
}
