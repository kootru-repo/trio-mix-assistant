import { parseInteger } from "./util.ts";
import { utf8Decode } from "./oscwire.ts";
import type { OscArg } from "./oscwire.ts";

const FLOAT_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function argNumber(a: OscArg | undefined): number | null {
  if (!a || (a.t !== "i" && a.t !== "f")) return null;
  return a.v;
}

export function argFloat(a: OscArg | undefined): number | null {
  if (!a) return null;
  if (a.t !== "s") return argNumber(a);
  const s = a.v.trim();
  if (FLOAT_TEXT.test(s)) return Number(s);
  const lower = s.toLowerCase();
  if (lower === "inf" || lower === "+inf" || lower === "infinity") return Infinity;
  if (lower === "-inf" || lower === "-infinity") return -Infinity;
  if (lower === "nan") return NaN;
  return null;
}

export function argInt(a: OscArg | undefined): number | null {
  if (!a) return null;
  if (a.t === "i") return a.v;
  if (a.t === "f") return Number.isFinite(a.v) ? Math.trunc(a.v) : null;
  if (a.t === "s") return parseInteger(a.v);
  return null;
}

export function argText(a: OscArg): string {
  if (a.t === "s") return a.v;
  if (a.t === "b") return utf8Decode(a.v);
  return String(a.v);
}
