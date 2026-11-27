const MAX_DEPTH = 900;

export class BadMessage extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadMessage";
  }
}

export const jsonText = (v: unknown): string => JSON.stringify(v) ?? "null";

export const jsonForHtml = (v: unknown): string => jsonText(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

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
      if (depth > MAX_DEPTH) throw new BadMessage("JSON nested too deeply");
    } else if (c === 0x5d || c === 0x7d) depth--;
  }
};

export const strictLoads = (text: string): unknown => {
  checkDepth(text);
  try {
    return JSON.parse(text);
  } catch {
    throw new BadMessage("invalid JSON");
  }
};

export const decodeUtf8 = (data: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw new BadMessage("invalid UTF-8");
  }
};

export const strOf = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return jsonText(v);
};
