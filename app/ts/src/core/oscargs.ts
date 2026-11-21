import { utf8Decode } from "./oscwire.ts";
import type { OscArg } from "./oscwire.ts";

const FLOAT_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const INT_TEXT = /^[+-]?\d+$/;

export function argFloat(a: OscArg | undefined): number | null {
  if (!a) return null;
  if (a.t === "i" || a.t === "f") return a.v;
  if (a.t === "s") {
    const s = a.v.trim();
    if (FLOAT_TEXT.test(s)) return Number(s);
    const lower = s.toLowerCase();
    if (lower === "inf" || lower === "+inf" || lower === "infinity") return Infinity;
    if (lower === "-inf" || lower === "-infinity") return -Infinity;
    if (lower === "nan") return NaN;
    return null;
  }
  return null;
}

export function argInt(a: OscArg | undefined): number | null {
  if (!a) return null;
  if (a.t === "i") return a.v;
  if (a.t === "f") return Number.isFinite(a.v) ? Math.trunc(a.v) : null;
  if (a.t === "s") {
    const s = a.v.trim();
    return INT_TEXT.test(s) ? Number(s) : null;
  }
  return null;
}

export function argText(a: OscArg): string {
  if (a.t === "s") return a.v;
  if (a.t === "b") return utf8Decode(a.v);
  return String(a.v);
}
