import { createHash, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import {
  bitString,
  boolean,
  children,
  explicit,
  implicitPrimitive,
  integerFromBytes,
  integerFromNumber,
  nullValue,
  octetString,
  oid,
  readTlv,
  sequence,
  set,
  time,
  utf8String,
} from "./der.ts";

const OID_SHA256_RSA = "1.2.840.113549.1.1.11";
const OID_COMMON_NAME = "2.5.4.3";
const OID_SAN = "2.5.29.17";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SKI = "2.5.29.14";
const OID_AKI = "2.5.29.35";
export const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

export function isIp(host: string): boolean {
  return isIPv4(host) || isIPv6(host);
}

export function ipBytes(host: string): Buffer {
  if (isIPv4(host)) return Buffer.from(host.split(".").map((p) => Number(p)));
  if (!isIPv6(host)) throw new RangeError(`not an IP address: ${host}`);
  let text = host.split("%")[0] ?? host;
  const tail = text.lastIndexOf(":");
  const last = text.slice(tail + 1);
  if (isIPv4(last)) {
    const v4 = last.split(".").map((p) => Number(p));
    const hex = (a: number | undefined, b: number | undefined) => (((a ?? 0) << 8) | (b ?? 0)).toString(16);
    text = `${text.slice(0, tail + 1)}${hex(v4[0], v4[1])}:${hex(v4[2], v4[3])}`;
  }
  const halves = text.split("::");
  const parse = (s: string): number[] => (s === "" ? [] : s.split(":").map((g) => parseInt(g, 16)));
  const head = parse(halves[0] ?? "");
  const rest = halves.length > 1 ? parse(halves[1] ?? "") : [];
  const groups =
    halves.length > 1 ? [...head, ...new Array<number>(8 - head.length - rest.length).fill(0), ...rest] : head;
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(g, i * 2));
  return out;
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));
}

export function commonName(cn: string): Buffer {
  return sequence(set(sequence(oid(OID_COMMON_NAME), utf8String(cn))));
}

export function subjectAltNameExt(hosts: readonly string[]): Buffer {
  const names = hosts.map((h) =>
    isIp(h) ? implicitPrimitive(7, ipBytes(h)) : implicitPrimitive(2, Buffer.from(h, "ascii")),
  );
  return extension(OID_SAN, false, sequence(...names));
}

export function basicConstraintsExt(ca: boolean, pathLength: number | null): Buffer {
  const parts: Buffer[] = [];
  if (ca) parts.push(boolean(true));
  if (ca && pathLength !== null) parts.push(integerFromNumber(pathLength));
  return extension(OID_BASIC_CONSTRAINTS, true, sequence(...parts));
}

export function keyUsageExt(kind: "server" | "ca"): Buffer {
  const value = kind === "server" ? bitString(Buffer.from([0xa0]), 5) : bitString(Buffer.from([0x06]), 1);
  return extension(OID_KEY_USAGE, true, value);
}

export function serverAuthExt(): Buffer {
  return extension(OID_EXT_KEY_USAGE, false, sequence(oid(OID_SERVER_AUTH)));
}

export function keyIdentifier(publicKey: KeyObject): Buffer {
  const rsaPublic = publicKey.export({ type: "pkcs1", format: "der" });
  return createHash("sha1").update(rsaPublic).digest();
}

export function subjectKeyIdExt(keyId: Buffer): Buffer {
  return extension(OID_SKI, false, octetString(keyId));
}

export function authorityKeyIdExt(keyId: Buffer): Buffer {
  return extension(OID_AKI, false, sequence(implicitPrimitive(0, keyId)));
}

function randomSerial(): Buffer {
  const bytes = randomBytes(19);
  bytes[0] = ((bytes[0] ?? 0) & 0x7f) | 0x01;
  return integerFromBytes(bytes);
}

export interface CertificateSpec {
  readonly subject: Buffer;
  readonly issuer: Buffer;
  readonly publicKey: KeyObject;
  readonly signingKey: KeyObject;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly extensions: readonly Buffer[];
}

export function buildCertificate(spec: CertificateSpec): Buffer {
  const algorithm = sequence(oid(OID_SHA256_RSA), nullValue());
  const spki = spec.publicKey.export({ type: "spki", format: "der" });
  const tbs = sequence(
    explicit(0, integerFromNumber(2)),
    randomSerial(),
    algorithm,
    spec.issuer,
    sequence(time(spec.notBefore), time(spec.notAfter)),
    spec.subject,
    Buffer.from(spki),
    explicit(3, sequence(...spec.extensions)),
  );
  const signature = sign("sha256", tbs, spec.signingKey);
  return sequence(tbs, algorithm, bitString(signature));
}

export function subjectOf(certDer: Uint8Array): Buffer {
  const cert = readTlv(certDer, 0);
  const tbs = children(certDer, cert)[0];
  if (!tbs) throw new RangeError("malformed certificate");
  const fields = children(certDer, tbs);
  const hasVersion = fields[0]?.tag === 0xa0;
  const subject = fields[hasVersion ? 5 : 4];
  if (!subject) throw new RangeError("malformed certificate");
  return Buffer.from(certDer.subarray(subject.start, subject.end));
}

export function toPem(der: Uint8Array, label: string): string {
  const lines = Buffer.from(der).toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
