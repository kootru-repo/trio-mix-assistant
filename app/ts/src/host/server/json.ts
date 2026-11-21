const MAX_DEPTH = 900;

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

const argString = (s: string): string =>
  '"' +
  s.replace(/[\\"]|[^ -~]/g, (ch) => ESCAPES[ch] ?? "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")) +
  '"';

export const coerceNumber = (x: number): string => {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  if (Object.is(x, -0)) return "-0.0";
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return String(x);
  const [mant, expText] = x.toExponential().split("e") as [string, string];
  const exp = Number(expText);
  if (exp >= -4 && exp < 16) {
    const neg = mant.startsWith("-");
    const digits = mant.replace("-", "").replace(".", "");
    let out: string;
    if (exp >= 0) {
      out = digits.length > exp + 1 ? digits.slice(0, exp + 1) + "." + digits.slice(exp + 1) : digits.padEnd(exp + 1, "0") + ".0";
    } else {
      out = "0." + "0".repeat(-exp - 1) + digits;
    }
    return (neg ? "-" : "") + out;
  }
  const sign = exp < 0 ? "-" : "+";
  return `${mant}e${sign}${String(Math.abs(exp)).padStart(2, "0")}`;
};

export const jsonText = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return argString(v);
  if (typeof v === "number") return coerceNumber(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return "[" + v.map(jsonText).join(", ") + "]";
  if (v instanceof Map) {
    return "{" + [...v].map(([k, x]) => argString(String(k)) + ": " + jsonText(x)).join(", ") + "}";
  }
  if (typeof v === "object") {
    return (
      "{" +
      Object.entries(v as Record<string, unknown>)
        .map(([k, x]) => argString(k) + ": " + jsonText(x))
        .join(", ") +
      "}"
    );
  }
  return "null";
};

export const jsonForHtml = (v: unknown): string =>
  jsonText(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

const checkDepth = (text: string): void => {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) {
      depth++;
      if (depth > MAX_DEPTH) throw new RangeError("JSON nested too deeply");
    } else if (c === 0x5d || c === 0x7d) depth--;
  }
};

export const strictLoads = (text: string): unknown => {
  checkDepth(text);
  return JSON.parse(text);
};

export const decodeUtf8 = (data: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);

export const strOf = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return coerceNumber(v);
  if (typeof v === "string") return v;
  return jsonText(v);
};
