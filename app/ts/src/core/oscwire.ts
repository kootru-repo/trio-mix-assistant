export type OscArg =
  | { t: "i"; v: number }
  | { t: "f"; v: number }
  | { t: "s"; v: string }
  | { t: "b"; v: Uint8Array };

export interface OscMessage {
  address: string;
  args: OscArg[];
}

export const oscInt = (v: number): OscArg => ({ t: "i", v: Math.trunc(v) });
export const oscFloat = (v: number): OscArg => ({ t: "f", v });
export const oscStr = (v: string): OscArg => ({ t: "s", v });
export const oscBlob = (v: Uint8Array): OscArg => ({ t: "b", v });

export function argNumber(a: OscArg | undefined): number | null {
  if (!a || (a.t !== "i" && a.t !== "f")) return null;
  return a.v;
}

export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}

export function utf8Decode(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; ) {
    const c = b[i]!;
    let cp: number;
    let len: number;
    if (c < 0x80) {
      cp = c;
      len = 1;
    } else if ((c & 0xe0) === 0xc0) {
      cp = c & 0x1f;
      len = 2;
    } else if ((c & 0xf0) === 0xe0) {
      cp = c & 0x0f;
      len = 3;
    } else if ((c & 0xf8) === 0xf0) {
      cp = c & 0x07;
      len = 4;
    } else {
      s += "�";
      i++;
      continue;
    }
    if (i + len > b.length) {
      s += "�";
      break;
    }
    for (let j = 1; j < len; j++) cp = (cp << 6) | (b[i + j]! & 0x3f);
    s += String.fromCodePoint(cp);
    i += len;
  }
  return s;
}

const pad4 = (n: number): number => (n + 3) & ~3;

function oscString(s: string): Uint8Array {
  const raw = utf8Encode(s);
  const out = new Uint8Array(pad4(raw.length + 1));
  out.set(raw, 0);
  return out;
}

export function encodeMessage(address: string, args: readonly OscArg[]): Uint8Array {
  const parts: Uint8Array[] = [oscString(address), oscString("," + args.map((a) => a.t).join(""))];
  for (const a of args) {
    if (a.t === "i") {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setInt32(0, a.v, false);
      parts.push(b);
    } else if (a.t === "f") {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setFloat32(0, a.v, false);
      parts.push(b);
    } else if (a.t === "s") {
      parts.push(oscString(a.v));
    } else {
      const b = new Uint8Array(4 + pad4(a.v.length));
      new DataView(b.buffer).setInt32(0, a.v.length, false);
      b.set(a.v, 4);
      parts.push(b);
    }
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function readString(b: Uint8Array, at: number): { s: string; next: number } | null {
  let end = at;
  while (end < b.length && b[end] !== 0) end++;
  if (end >= b.length) return null;
  const next = at + pad4(end - at + 1);
  if (next > b.length) return null;
  return { s: utf8Decode(b.subarray(at, end)), next };
}

export function decodeMessage(b: Uint8Array): OscMessage | null {
  const addr = readString(b, 0);
  if (!addr || !addr.s.startsWith("/")) return null;
  const tags = readString(b, addr.next);
  if (!tags) {
    return { address: addr.s, args: [] };
  }
  if (!tags.s.startsWith(",")) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const args: OscArg[] = [];
  let off = tags.next;
  for (const t of tags.s.slice(1)) {
    if (t === "i") {
      if (off + 4 > b.length) return null;
      args.push({ t: "i", v: dv.getInt32(off, false) });
      off += 4;
    } else if (t === "f") {
      if (off + 4 > b.length) return null;
      args.push({ t: "f", v: dv.getFloat32(off, false) });
      off += 4;
    } else if (t === "s") {
      const r = readString(b, off);
      if (!r) return null;
      args.push({ t: "s", v: r.s });
      off = r.next;
    } else if (t === "b") {
      if (off + 4 > b.length) return null;
      const len = dv.getInt32(off, false);
      if (len < 0 || off + 4 + len > b.length) return null;
      args.push({ t: "b", v: b.slice(off + 4, off + 4 + len) });
      off += 4 + pad4(len);
    } else if (t === "d") {
      if (off + 8 > b.length) return null;
      args.push({ t: "f", v: dv.getFloat64(off, false) });
      off += 8;
    } else if (t === "h") {
      if (off + 8 > b.length) return null;
      args.push({ t: "i", v: Number(dv.getBigInt64(off, false)) });
      off += 8;
    } else if (t === "T" || t === "F") {
      args.push({ t: "i", v: t === "T" ? 1 : 0 });
    } else if (t === "N") {
      args.push({ t: "i", v: 0 });
    } else {
      return null;
    }
  }
  return { address: addr.s, args };
}

export function decodePacket(b: Uint8Array): OscMessage[] {
  if (b.length >= 8 && utf8Decode(b.subarray(0, 7)) === "#bundle") {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out: OscMessage[] = [];
    let off = 16;
    while (off + 4 <= b.length) {
      const len = dv.getInt32(off, false);
      off += 4;
      if (len <= 0 || off + len > b.length) break;
      out.push(...decodePacket(b.subarray(off, off + len)));
      off += len;
    }
    return out;
  }
  const m = decodeMessage(b);
  return m ? [m] : [];
}

export function decodeMeterBlob(blob: Uint8Array): number[] {
  if (blob.length < 4) return [];
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let n = dv.getInt32(0, true);
  n = Math.max(0, Math.min(n, Math.floor((blob.length - 4) / 4)));
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(dv.getFloat32(4 + i * 4, true));
  return out;
}

export function encodeMeterBlob(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(4 + values.length * 4);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, values.length, true);
  values.forEach((v, i) => dv.setFloat32(4 + i * 4, v, true));
  return out;
}
