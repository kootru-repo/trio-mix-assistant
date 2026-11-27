import type { Config } from "./config.ts";

export const NEG_INF = -1000000000;

export const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

export const perChannel = <T>(value: T, cfg: Config): Map<number, T> => new Map([...cfg.CHANNELS.keys()].map((c) => [c, value]));

const NUMERIC = /^\s*[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)\s*$/;
const INTEGER = /^\s*[+-]?\d+\s*$/;
const TRUE_WORDS = new Set(["true", "1", "yes", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off"]);

export const numOf = (x: unknown): number => {
  let v: number;
  if (typeof x === "number") v = x;
  else if (typeof x === "string" && NUMERIC.test(x)) v = Number(x.trim());
  else throw new TypeError("not a number");
  if (!Number.isFinite(v)) throw new RangeError("non-finite number");
  return v;
};

export const parseInteger = (text: string): number | null => {
  if (!INTEGER.test(text)) return null;
  const v = Number(text.trim());
  return Number.isSafeInteger(v) ? v : null;
};

export const intOf = (x: unknown): number => {
  if (typeof x === "number" && Number.isSafeInteger(x)) return x;
  if (typeof x === "string") {
    const v = parseInteger(x);
    if (v !== null) return v;
  }
  throw new TypeError("not an integer");
};

export const zeroPad = (n: number, width: number): string => {
  const digits = String(Math.abs(Math.trunc(n)));
  return n < 0 ? "-" + digits.padStart(width - 1, "0") : digits.padStart(width, "0");
};

export const asBool = (x: unknown): boolean => {
  if (x === true || x === 1) return true;
  if (x === false || x === 0) return false;
  if (typeof x === "string") {
    const s = x.trim().toLowerCase();
    if (TRUE_WORDS.has(s)) return true;
    if (FALSE_WORDS.has(s)) return false;
  }
  throw new TypeError("not a boolean");
};
