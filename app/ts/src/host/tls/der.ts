export interface Tlv {
  readonly tag: number;
  readonly start: number;
  readonly contentStart: number;
  readonly end: number;
}

function lengthBytes(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lengthBytes(body.length), body]);
}

export function sequence(...parts: Buffer[]): Buffer {
  return tlv(0x30, ...parts);
}

export function set(...parts: Buffer[]): Buffer {
  return tlv(0x31, ...parts);
}

export function explicit(n: number, ...parts: Buffer[]): Buffer {
  return tlv(0xa0 | n, ...parts);
}

export function implicitPrimitive(n: number, content: Buffer): Buffer {
  return tlv(0x80 | n, content);
}

export function nullValue(): Buffer {
  return Buffer.from([0x05, 0x00]);
}

export function boolean(v: boolean): Buffer {
  return tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
}

export function integerFromBytes(bytes: Uint8Array): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = Buffer.from(bytes.subarray(start));
  const first = trimmed[0] ?? 0;
  const body = first & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed;
  return tlv(0x02, body.length === 0 ? Buffer.from([0]) : body);
}

export function integerFromNumber(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("only non-negative integers are encoded");
  const bytes: number[] = [];
  let v = n;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return integerFromBytes(Buffer.from(bytes));
}

export function oid(dotted: string): Buffer {
  const arcs = dotted.split(".").map((p) => Number(p));
  const a = arcs[0];
  const b = arcs[1];
  if (a === undefined || b === undefined || arcs.some((x) => !Number.isInteger(x) || x < 0)) {
    throw new RangeError(`bad OID ${dotted}`);
  }
  const out: number[] = [];
  for (const arc of [a * 40 + b, ...arcs.slice(2)]) {
    const chunk: number[] = [arc & 0x7f];
    let v = Math.floor(arc / 128);
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

export function utf8String(s: string): Buffer {
  return tlv(0x0c, Buffer.from(s, "utf8"));
}

export function octetString(content: Buffer): Buffer {
  return tlv(0x04, content);
}

export function bitString(content: Buffer, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.from([unusedBits]), content);
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

export function time(d: Date): Buffer {
  const year = d.getUTCFullYear();
  const rest =
    two(d.getUTCMonth() + 1) + two(d.getUTCDate()) + two(d.getUTCHours()) + two(d.getUTCMinutes()) + two(d.getUTCSeconds()) + "Z";
  if (year >= 1950 && year < 2050) return tlv(0x17, Buffer.from(two(year % 100) + rest, "ascii"));
  return tlv(0x18, Buffer.from(String(year).padStart(4, "0") + rest, "ascii"));
}

export function readTlv(buf: Uint8Array, offset: number): Tlv {
  const tag = buf[offset];
  const first = buf[offset + 1];
  if (tag === undefined || first === undefined) throw new RangeError("truncated DER");
  let len = first;
  let contentStart = offset + 2;
  if (first & 0x80) {
    const n = first & 0x7f;
    if (n === 0 || n > 4) throw new RangeError("unsupported DER length");
    len = 0;
    for (let i = 0; i < n; i++) {
      const b = buf[offset + 2 + i];
      if (b === undefined) throw new RangeError("truncated DER");
      len = len * 256 + b;
    }
    contentStart = offset + 2 + n;
  }
  const end = contentStart + len;
  if (end > buf.length) throw new RangeError("truncated DER");
  return { tag, start: offset, contentStart, end };
}

export function children(buf: Uint8Array, node: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let pos = node.contentStart;
  while (pos < node.end) {
    const child = readTlv(buf, pos);
    out.push(child);
    pos = child.end;
  }
  return out;
}
