import { createPrivateKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import {
  authorityKeyIdExt,
  basicConstraintsExt,
  buildCertificate,
  commonName,
  ipBytes,
  isIp,
  keyIdentifier,
  keyUsageExt,
  OID_SERVER_AUTH,
  serverAuthExt,
  subjectAltNameExt,
  subjectKeyIdExt,
  subjectOf,
  toPem,
} from "./tls/x509.ts";

export const CERT_DAYS = 396;
export const CA_DAYS = 3650;
export const MIN_KEY_BITS = 2048;

const DAY_MS = 86_400_000;
const SERVER_CN = "AutoFOH Mix-Assistant";
const CA_CN = "AutoFOH Mix-Assistant Local CA";

export class TLSUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TLSUnavailable";
  }
}

export interface CertFiles {
  readonly certfile: string;
  readonly keyfile: string;
}

export interface TrustedCertFiles extends CertFiles {
  readonly cafile: string;
}

interface KeyPair {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  readonly pem: string;
}

function generateRsa(): KeyPair {
  const pair = generateKeyPairSync("rsa", { modulusLength: MIN_KEY_BITS, publicExponent: 65537 });
  const pem = pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  return { publicKey: pair.publicKey, privateKey: pair.privateKey, pem };
}

function writeKey(path: string, pem: string): void {
  writeFileSync(path, pem, { mode: 0o600 });
}

function restrict(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    return;
  }
}

function now(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

function certDer(pemOrX509: X509Certificate): Buffer {
  return pemOrX509.raw;
}

function loadCert(path: string): X509Certificate {
  return new X509Certificate(readFileSync(path));
}

function normalizeSanEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (trimmed.startsWith("DNS:")) return `dns:${trimmed.slice(4).toLowerCase()}`;
  if (trimmed.startsWith("IP Address:")) {
    const ip = trimmed.slice("IP Address:".length);
    return isIp(ip) ? `ip:${ipBytes(ip).toString("hex")}` : null;
  }
  return null;
}

function certCovers(cert: X509Certificate, hosts: readonly string[]): boolean {
  const have = new Set<string>();
  for (const entry of (cert.subjectAltName ?? "").split(", ")) {
    const norm = normalizeSanEntry(entry);
    if (norm) have.add(norm);
  }
  return hosts.every((h) => have.has(isIp(h) ? `ip:${ipBytes(h).toString("hex")}` : `dns:${h.toLowerCase()}`));
}

function serverExtensions(hosts: readonly string[], extra: readonly Buffer[]): Buffer[] {
  return [
    subjectAltNameExt(hosts),
    basicConstraintsExt(false, null),
    keyUsageExt("server"),
    serverAuthExt(),
    ...extra,
  ];
}

export function certIsCurrent(certfile: string, hosts: readonly string[] = []): boolean {
  try {
    const c = loadCert(certfile);
    const nb = new Date(c.validFrom).getTime();
    const na = new Date(c.validTo).getTime();
    if (Math.floor((na - nb) / DAY_MS) > 398) return false;
    if (na - Date.now() < 30 * DAY_MS) return false;
    if (!(c.keyUsage ?? []).includes(OID_SERVER_AUTH)) return false;
    return certCovers(c, hosts);
  } catch {
    return false;
  }
}

export function ensureCert(certdir: string, hosts: readonly string[]): [string, string] {
  mkdirSync(certdir, { recursive: true });
  const certfile = join(certdir, "cert.pem");
  const keyfile = join(certdir, "key.pem");
  if (existsSync(certfile) && existsSync(keyfile) && certIsCurrent(certfile, hosts)) {
    return [certfile, keyfile];
  }
  generateSelfSigned(certfile, keyfile, hosts);
  restrict(keyfile);
  return [certfile, keyfile];
}

function generateSelfSigned(certfile: string, keyfile: string, hosts: readonly string[]): void {
  const key = generateRsa();
  const name = commonName(SERVER_CN);
  const t = now();
  const der = buildCertificate({
    subject: name,
    issuer: name,
    publicKey: key.publicKey,
    signingKey: key.privateKey,
    notBefore: new Date(t.getTime() - DAY_MS),
    notAfter: new Date(t.getTime() + CERT_DAYS * DAY_MS),
    extensions: serverExtensions(hosts, []),
  });
  writeKey(keyfile, key.pem);
  writeFileSync(certfile, toPem(der, "CERTIFICATE"));
}

export function ensureTrustedCert(certdir: string, hosts: readonly string[]): [string, string, string] {
  mkdirSync(certdir, { recursive: true });
  const cafile = join(certdir, "ca.pem");
  const cakey = join(certdir, "ca-key.pem");
  const certfile = join(certdir, "cert.pem");
  const keyfile = join(certdir, "key.pem");
  ensureCa(cafile, cakey);
  if (
    !(
      existsSync(certfile) &&
      existsSync(keyfile) &&
      certIsCurrent(certfile, hosts) &&
      issuedBy(certfile, cafile)
    )
  ) {
    generateLeafFromCa(certfile, keyfile, hosts, cafile, cakey);
  }
  restrict(keyfile);
  restrict(cakey);
  return [certfile, keyfile, cafile];
}

export function issuedBy(certfile: string, cafile: string): boolean {
  try {
    const leaf = loadCert(certfile);
    const ca = loadCert(cafile);
    return leaf.issuer === ca.subject && leaf.verify(ca.publicKey);
  } catch {
    return false;
  }
}

export function certIsCa(cafile: string, cakey?: string): boolean {
  try {
    const c = loadCert(cafile);
    if (new Date(c.validTo).getTime() - Date.now() < 30 * DAY_MS) return false;
    if (!c.ca) return false;
    if (cakey !== undefined) {
      const priv = createPrivateKey(readFileSync(cakey));
      if (!c.checkPrivateKey(priv)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function ensureCa(cafile: string, cakey: string): void {
  if (existsSync(cafile) && existsSync(cakey) && certIsCa(cafile, cakey)) return;
  const key = generateRsa();
  const name = commonName(CA_CN);
  const t = now();
  const der = buildCertificate({
    subject: name,
    issuer: name,
    publicKey: key.publicKey,
    signingKey: key.privateKey,
    notBefore: new Date(t.getTime() - DAY_MS),
    notAfter: new Date(t.getTime() + CA_DAYS * DAY_MS),
    extensions: [basicConstraintsExt(true, 0), keyUsageExt("ca"), subjectKeyIdExt(keyIdentifier(key.publicKey))],
  });
  writeKey(cakey, key.pem);
  writeFileSync(cafile, toPem(der, "CERTIFICATE"));
}

function generateLeafFromCa(
  certfile: string,
  keyfile: string,
  hosts: readonly string[],
  cafile: string,
  cakey: string,
): void {
  const ca = loadCert(cafile);
  const caKey = createPrivateKey(readFileSync(cakey));
  if (caKey.asymmetricKeyType !== "rsa") {
    throw new TLSUnavailable("the local root CA key is not an RSA key; delete .certs to rebuild");
  }
  const bits = caKey.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_KEY_BITS) {
    throw new TLSUnavailable(
      `the local root CA key is ${bits} bits, below the ${MIN_KEY_BITS}-bit minimum; delete .certs to rebuild`,
    );
  }
  const key = generateRsa();
  const t = now();
  const caDer = certDer(ca);
  const der = buildCertificate({
    subject: commonName(SERVER_CN),
    issuer: subjectOf(caDer),
    publicKey: key.publicKey,
    signingKey: caKey,
    notBefore: new Date(t.getTime() - DAY_MS),
    notAfter: new Date(t.getTime() + CERT_DAYS * DAY_MS),
    extensions: serverExtensions(hosts, [authorityKeyIdExt(keyIdentifier(ca.publicKey))]),
  });
  writeKey(keyfile, key.pem);
  writeFileSync(certfile, toPem(der, "CERTIFICATE") + toPem(caDer, "CERTIFICATE"));
}

export type Interfaces = Record<string, readonly NetworkInterfaceInfo[] | undefined>;

export function allLanIps(primary: string | null = null, interfaces: Interfaces = networkInterfaces()): string[] {
  const ips: string[] = [];
  if (primary) ips.push(primary);
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      if (info.address.startsWith("127.") || ips.includes(info.address)) continue;
      ips.push(info.address);
    }
  }
  return ips;
}

export function tlsHosts(lanIps: readonly string[]): string[] {
  return [...new Set(["localhost", "127.0.0.1", ...lanIps])];
}

export interface TrustStep {
  readonly title: string;
  readonly lines: readonly string[];
}

export interface TrustInstructions {
  readonly heading: string;
  readonly steps: readonly TrustStep[];
}

export interface TrustOptions {
  readonly cafile: string;
  readonly scheme: string;
  readonly port: number;
  readonly ip: string | null;
  readonly host: string;
}

export function trustInstructions(o: TrustOptions): TrustInstructions {
  const hostUrl = o.ip ?? o.host;
  const fetch: string[] = [o.cafile];
  if (o.ip) {
    fetch.push(
      `(or, if a device lets you tap through the warning once: ${o.scheme}://${o.ip}:${o.port}/ca.pem )`,
    );
  }
  return {
    heading: "Trusted TLS — do this ONCE per device for ZERO warnings:",
    steps: [
      { title: "Get the root CA onto the device — copy / AirDrop / email this file:", lines: fetch },
      {
        title: "Install + TRUST it:",
        lines: [
          "iOS:     install the profile, then Settings > General > About > Certificate Trust Settings > enable it",
          "Android: Settings > Security > Install a certificate > CA certificate",
          "macOS:   double-click > Keychain 'System' > set this cert to 'Always Trust'",
          "Windows: double-click > Install > Local Machine > 'Trusted Root Certification Authorities'",
        ],
      },
      { title: `Reload  ${o.scheme}://${hostUrl}:${o.port}/  — trusted, no warning.`, lines: [] },
    ],
  };
}
