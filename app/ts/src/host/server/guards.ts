import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const hostAllowed = (hostHeader: string | undefined): boolean => {
  let h = (hostHeader ?? "").trim();
  if (h === "") return true;
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    h = end >= 0 ? h.slice(1, end) : h.slice(1);
  } else if (h.split(":").length - 1 === 1) {
    h = h.slice(0, h.lastIndexOf(":"));
  }
  const hl = h.toLowerCase();
  if (hl === "localhost" || hl.endsWith(".local")) return true;
  return isIP(h) !== 0;
};

const netlocOf = (origin: string): { scheme: string; netloc: string } | null => {
  const url = origin.replace(/[\t\r\n]/g, "").replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(url);
  if (m === null) return { scheme: "", netloc: "" };
  const rest = m[2]!;
  let netloc = "";
  if (rest.startsWith("//")) {
    const body = rest.slice(2);
    const cut = body.search(/[/?#]/);
    netloc = cut < 0 ? body : body.slice(0, cut);
  }
  if ((netloc.includes("[") && !netloc.includes("]")) || (netloc.includes("]") && !netloc.includes("["))) return null;
  return { scheme: m[1]!.toLowerCase(), netloc };
};

export const originAllowed = (origin: string | null | undefined, hostHeader: string | undefined): boolean => {
  if (origin === null || origin === undefined) return true;
  const parts = netlocOf(origin.trim());
  if (parts === null) return false;
  if ((parts.scheme !== "http" && parts.scheme !== "https") || parts.netloc === "") return false;
  return parts.netloc.toLowerCase() === (hostHeader ?? "").trim().toLowerCase();
};

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

export const safeEqual = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));
