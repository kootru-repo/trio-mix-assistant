import type { AssistantEvent } from "./assistant/index.ts";
import type { VenueLogSource } from "./venue.ts";

export interface SessionLogPort extends VenueLogSource {
  logEvent(ev: AssistantEvent): void;
  flush(): Promise<void>;
  close(): void;
}

export interface AdvisorPort {
  readonly available: boolean;
  start(): boolean;
  stop(): void;
}

export interface VetRequest {
  channel: number | null;
  gain: boolean;
  main: boolean;
}

export interface VetSummary {
  text: string;
  summary: string;
  failed: number;
}

export interface VetControl {
  stopped(): boolean;
  takeover(): boolean;
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
