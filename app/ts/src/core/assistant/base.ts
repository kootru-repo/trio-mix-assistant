import { C } from "../config.ts";
import { chanOf } from "./context.ts";

export interface AssistantEvent {
  time: string;
  kind: string;
  ch: number | null;
  role: string | null;
  msg: string;
  level?: string;
}

export interface CoachRec {
  seq: number;
  mono: number;
  persist: boolean;
  time: string;
  kind: string;
  ch: number | null;
  role: string | null;
  text: string;
  [meta: string]: unknown;
}

export type EventHandler = (ev: AssistantEvent) => void;
export type LatencyHandler = (kind: string, seconds: number) => void;

export const chan = (ch: number): string => chanOf(C, ch);
