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

export interface MeterReceiverPort {
  start(): Promise<void>;
  stop(): void;
}
