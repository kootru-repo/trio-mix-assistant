import { createHash } from "node:crypto";

export const WS_MAX_FRAME = 1 << 18;
export const WS_MAX_FRAGMENTS = 64;
export const CLOSE_PROTOCOL = 1002;
export const CLOSE_TOO_BIG = 1009;
export const CLOSE_INTERNAL = 1011;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const wsAccept = (key: string): string =>
  createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");

export const wsKeyValid = (key: string | undefined): key is string =>
  key !== undefined && /^[A-Za-z0-9+/]{22}==$/.test(key) && Buffer.from(key, "base64").length === 16;

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

export interface WsFault {
  close: number;
}

const reservedOpcode = (op: number): boolean => (op > 0x2 && op < 0x8) || op > 0xa;

export class WsParser {
  private parts: Buffer[] = [];
  private size = 0;
  private need = 2;

  push(chunk: Buffer): void {
    this.parts.push(chunk);
    this.size += chunk.length;
  }

  private flat(): Buffer {
    if (this.parts.length !== 1) this.parts = [Buffer.concat(this.parts)];
    return this.parts[0]!;
  }

  next(): WsFrame | WsFault | null {
    if (this.size < this.need) return null;
    const b = this.flat();
    const fin = (b[0]! & 0x80) !== 0;
    const opcode = b[0]! & 0x0f;
    if ((b[0]! & 0x70) !== 0 || reservedOpcode(opcode)) return { close: CLOSE_PROTOCOL };
    if ((b[1]! & 0x80) === 0) return { close: CLOSE_PROTOCOL };
    let ln = b[1]! & 0x7f;
    let off = 2;
    const control = opcode >= 0x8;
    if (control && (!fin || ln > 125)) return { close: CLOSE_PROTOCOL };
    if (ln === 126) {
      if (b.length < 4) {
        this.need = 4;
        return null;
      }
      ln = b.readUInt16BE(2);
      off = 4;
    } else if (ln === 127) {
      if (b.length < 10) {
        this.need = 10;
        return null;
      }
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(WS_MAX_FRAME)) return { close: CLOSE_TOO_BIG };
      ln = Number(big);
      off = 10;
    }
    if (ln > WS_MAX_FRAME) return { close: CLOSE_TOO_BIG };
    const total = off + 4 + ln;
    if (b.length < total) {
      this.need = total;
      return null;
    }
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, total));
    for (let i = 0; i < ln; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
    const rest = b.subarray(total);
    this.parts = rest.length > 0 ? [rest] : [];
    this.size = rest.length;
    this.need = 2;
    return { fin, opcode, payload };
  }
}

export class WsAssembler {
  private parts: Buffer[] = [];
  private len = 0;
  private count = 0;
  private op: number | null = null;

  accept(frame: WsFrame): { message: Buffer; opcode: number } | WsFault | null {
    if (frame.opcode === 0x0) {
      if (this.op === null) return { close: CLOSE_PROTOCOL };
    } else {
      if (this.op !== null) return { close: CLOSE_PROTOCOL };
      this.op = frame.opcode;
    }
    this.count += 1;
    this.len += frame.payload.length;
    if (this.count > WS_MAX_FRAGMENTS || this.len > WS_MAX_FRAME) return { close: CLOSE_TOO_BIG };
    this.parts.push(frame.payload);
    if (!frame.fin) return null;
    const message = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts, this.len);
    const opcode = this.op!;
    this.parts = [];
    this.len = 0;
    this.count = 0;
    this.op = null;
    return { message, opcode };
  }
}

export const wsFrame = (data: string | Buffer, opcode: number = 0x1): Buffer => {
  const body = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const n = body.length;
  let hdr: Buffer;
  if (n < 126) hdr = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) {
    hdr = Buffer.alloc(4);
    hdr[0] = 0x80 | opcode;
    hdr[1] = 126;
    hdr.writeUInt16BE(n, 2);
  } else {
    hdr = Buffer.alloc(10);
    hdr[0] = 0x80 | opcode;
    hdr[1] = 127;
    hdr.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([hdr, body]);
};

export const wsCloseFrame = (code: number | null): Buffer => {
  if (code === null) return wsFrame(Buffer.alloc(0), 0x8);
  const body = Buffer.alloc(2);
  body.writeUInt16BE(code, 0);
  return wsFrame(body, 0x8);
};

export const closeCodeOf = (payload: Buffer): number | null | WsFault => {
  if (payload.length === 0) return null;
  if (payload.length === 1) return { close: CLOSE_PROTOCOL };
  const code = payload.readUInt16BE(0);
  const valid = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999);
  return valid ? code : { close: CLOSE_PROTOCOL };
};
