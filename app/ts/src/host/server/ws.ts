import { createHash } from "node:crypto";

export const WS_MAX_FRAME = 1 << 18;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const wsAccept = (key: string): string =>
  createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

export class WsParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
  }

  next(): WsFrame | null | "bad" {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0]! & 0x80) !== 0;
    const opcode = b[0]! & 0x0f;
    if ((b[1]! & 0x80) === 0) return "bad";
    let ln = b[1]! & 0x7f;
    let off = 2;
    if (ln === 126) {
      if (b.length < 4) return null;
      ln = b.readUInt16BE(2);
      off = 4;
    } else if (ln === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(WS_MAX_FRAME)) return "bad";
      ln = Number(big);
      off = 10;
    }
    if (ln > WS_MAX_FRAME) return "bad";
    if (b.length < off + 4 + ln) return null;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + ln));
    for (let i = 0; i < ln; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
    this.buf = b.subarray(off + 4 + ln);
    return { fin, opcode, payload };
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
