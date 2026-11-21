import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import tls from "node:tls";
import {
  allLanIps,
  CERT_DAYS,
  certIsCa,
  certIsCurrent,
  ensureCert,
  ensureTrustedCert,
  issuedBy,
  TLSUnavailable,
  tlsHosts,
  trustInstructions,
} from "../src/host/tls.ts";
import { OID_SERVER_AUTH, basicConstraintsExt, buildCertificate, commonName, subjectAltNameExt, toPem } from "../src/host/tls/x509.ts";

const DAY_MS = 86_400_000;

function withDir(prefix: string, fn: (dir: string) => void | Promise<void>): () => Promise<void> {
  return async () => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    try {
      await fn(d);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };
}

function load(path: string): X509Certificate {
  return new X509Certificate(readFileSync(path));
}

function lifetimeDays(c: X509Certificate): number {
  return Math.floor((new Date(c.validTo).getTime() - new Date(c.validFrom).getTime()) / DAY_MS);
}

function sanEntries(c: X509Certificate): string[] {
  return (c.subjectAltName ?? "").split(", ");
}

function writeOverlong(certfile: string, keyfile: string, days = 3650): void {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const name = commonName("old");
  const t = Math.floor(Date.now() / 1000) * 1000;
  const der = buildCertificate({
    subject: name,
    issuer: name,
    publicKey,
    signingKey: privateKey,
    notBefore: new Date(t - DAY_MS),
    notAfter: new Date(t + days * DAY_MS),
    extensions: [subjectAltNameExt(["localhost"])],
  });
  writeFileSync(keyfile, privateKey.export({ type: "pkcs1", format: "pem" }));
  writeFileSync(certfile, toPem(der, "CERTIFICATE"));
}

function handshake(cert: string, key: string, ca: string): Promise<{ got: string; reply: string; protocol: string | null }> {
  return new Promise((resolve, reject) => {
    const server = tls.createServer(
      { cert: readFileSync(cert), key: readFileSync(key), minVersion: "TLSv1.2" },
      (sock) => {
        sock.on("data", (d) => {
          got = d.toString();
          sock.end("ack");
        });
        sock.on("error", reject);
      },
    );
    let got = "";
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") return reject(new Error("no port"));
      let protocol: string | null = null;
      const client = tls.connect({ host: "127.0.0.1", port: addr.port, ca: readFileSync(ca), minVersion: "TLSv1.2" }, () => {
        protocol = client.getProtocol();
        client.write("ok");
      });
      let reply = "";
      client.on("data", (d) => {
        reply += d.toString();
      });
      client.on("error", (e) => {
        server.close();
        reject(e);
      });
      client.on("close", () => {
        server.close(() => resolve({ got, reply, protocol }));
      });
    });
  });
}

function opensslAvailable(): boolean {
  const r = spawnSync("openssl", ["version"], { encoding: "utf8" });
  return r.status === 0;
}

test("cert is browser acceptable", withDir("autofoh_cert_", (d) => {
  const [cert] = ensureCert(d, ["127.0.0.1"]);
  const c = load(cert);
  assert.ok(lifetimeDays(c) <= 398);
  assert.ok((c.keyUsage ?? []).includes(OID_SERVER_AUTH));
  assert.equal(c.ca, false);
}));

test("overlong cached cert is regenerated", withDir("autofoh_cert_", (d) => {
  const [cert, key] = ensureCert(d, ["127.0.0.1"]);
  writeOverlong(cert, key);
  assert.ok(lifetimeDays(load(cert)) > 398);
  ensureCert(d, ["127.0.0.1"]);
  assert.ok(lifetimeDays(load(cert)) <= 398);
}));

test("trusted CA mode shapes", withDir("autofoh_ca_", (d) => {
  const [cert, key, ca] = ensureTrustedCert(d, ["127.0.0.1", "192.168.1.50"]);
  for (const p of [cert, key, ca]) assert.ok(existsSync(p));
  const caC = load(ca);
  assert.equal(caC.ca, true);
  const leaf = load(cert);
  assert.equal(leaf.issuer, caC.subject);
  assert.equal(leaf.ca, false);
  assert.ok((leaf.keyUsage ?? []).includes(OID_SERVER_AUTH));
  assert.ok(lifetimeDays(leaf) <= 398);
  assert.ok(sanEntries(leaf).includes("IP Address:192.168.1.50"));
  const [, , ca2] = ensureTrustedCert(d, ["127.0.0.1"]);
  assert.equal(caC.serialNumber, load(ca2).serialNumber);
}));

test("CA signed cert verifies like an installed root over a real socket", withDir("autofoh_ca_", async (d) => {
  const [cert, key, ca] = ensureTrustedCert(d, ["127.0.0.1"]);
  const r = await handshake(cert, key, ca);
  assert.equal(r.got, "ok");
  assert.equal(r.reply, "ack");
  assert.ok(r.protocol === "TLSv1.2" || r.protocol === "TLSv1.3");
}));

test("self-signed cert completes a handshake when trusted as its own root", withDir("autofoh_cert_", async (d) => {
  const [cert, key] = ensureCert(d, ["localhost", "127.0.0.1"]);
  const r = await handshake(cert, key, cert);
  assert.equal(r.reply, "ack");
}));

test("an untrusted client rejects the generated certificate", withDir("autofoh_ca_", async (d) => {
  const [cert, key] = ensureTrustedCert(d, ["127.0.0.1"]);
  const other = mkdtempSync(join(tmpdir(), "autofoh_other_"));
  try {
    const [, , otherCa] = ensureTrustedCert(other, ["127.0.0.1"]);
    await assert.rejects(handshake(cert, key, otherCa), /unable to verify|self.signed|issuer/i);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
}));

test("a client checking a name the certificate lacks is rejected", withDir("autofoh_ca_", async (d) => {
  const [cert, key, ca] = ensureTrustedCert(d, ["127.0.0.1"]);
  const server = tls.createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (s) => s.end());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr !== null && typeof addr !== "string");
  try {
    await new Promise<void>((resolve, reject) => {
      const c = tls.connect({ host: "127.0.0.1", port: addr.port, ca: readFileSync(ca), servername: "other.example" });
      c.on("secureConnect", () => {
        c.destroy();
        reject(new Error("handshake should have failed"));
      });
      c.on("error", (e) => {
        assert.match(e.message, /altnames|Hostname/i);
        resolve();
      });
    });
  } finally {
    server.close();
  }
}));

test("generate with LAN ip in SAN, and reuse when covered", withDir("autofoh_cert_", (d) => {
  const [cert, key] = ensureCert(d, ["localhost", "127.0.0.1", "192.168.1.50"]);
  assert.ok(existsSync(cert) && existsSync(key));
  const before = readFileSync(cert, "utf8");
  const [cert2] = ensureCert(d, ["localhost"]);
  assert.equal(cert, cert2);
  assert.equal(readFileSync(cert2, "utf8"), before);
  const san = sanEntries(load(cert));
  assert.ok(san.includes("IP Address:192.168.1.50"));
  assert.ok(san.includes("IP Address:127.0.0.1"));
  assert.ok(san.includes("DNS:localhost"));
}));

test("a new LAN ip not covered by the cached cert forces regeneration", withDir("autofoh_cert_", (d) => {
  const [cert] = ensureCert(d, ["127.0.0.1"]);
  const before = readFileSync(cert, "utf8");
  ensureCert(d, ["127.0.0.1", "10.0.0.7"]);
  assert.notEqual(readFileSync(cert, "utf8"), before);
  assert.ok(sanEntries(load(cert)).includes("IP Address:10.0.0.7"));
}));

test("trusted mode reissues the leaf for a new host and keeps the CA", withDir("autofoh_ca_", (d) => {
  const [cert, , ca] = ensureTrustedCert(d, ["127.0.0.1"]);
  const caBefore = readFileSync(ca, "utf8");
  const leafBefore = readFileSync(cert, "utf8");
  ensureTrustedCert(d, ["127.0.0.1", "10.1.2.3"]);
  assert.equal(readFileSync(ca, "utf8"), caBefore);
  assert.notEqual(readFileSync(cert, "utf8"), leafBefore);
  assert.ok(issuedBy(cert, ca));
}));

test("a self-signed cert is not accepted as issued by the CA, and is replaced in trusted mode", withDir("autofoh_ca_", (d) => {
  const [cert, key, ca] = ensureTrustedCert(d, ["127.0.0.1"]);
  writeOverlong(cert, key, 100);
  assert.equal(issuedBy(cert, ca), false);
  ensureTrustedCert(d, ["127.0.0.1"]);
  assert.ok(issuedBy(cert, ca));
}));

test("missing or corrupt CA key rebuilds the root", withDir("autofoh_ca_", (d) => {
  const [, , ca] = ensureTrustedCert(d, ["127.0.0.1"]);
  const serial = load(ca).serialNumber;
  writeFileSync(join(d, "ca-key.pem"), "garbage");
  ensureTrustedCert(d, ["127.0.0.1"]);
  assert.notEqual(load(ca).serialNumber, serial);
  assert.ok(certIsCa(ca, join(d, "ca-key.pem")));
}));

test("a non-CA file is not a root; garbage is not current", withDir("autofoh_cert_", (d) => {
  const [cert] = ensureCert(d, ["127.0.0.1"]);
  assert.equal(certIsCa(cert), false);
  writeFileSync(join(d, "junk.pem"), "nope");
  assert.equal(certIsCurrent(join(d, "junk.pem")), false);
  assert.equal(certIsCurrent(join(d, "absent.pem")), false);
}));

test("a cert expiring within 30 days is regenerated", withDir("autofoh_cert_", (d) => {
  const [cert, key] = ensureCert(d, ["127.0.0.1"]);
  writeOverlong(cert, key, 10);
  assert.equal(certIsCurrent(cert), false);
  ensureCert(d, ["localhost"]);
  assert.ok(certIsCurrent(cert, ["localhost"]));
}));

function writeForeignCa(dir: string, key: { publicKey: import("node:crypto").KeyObject; privateKey: import("node:crypto").KeyObject }): void {
  const name = commonName("foreign");
  const t = Math.floor(Date.now() / 1000) * 1000;
  const der = buildCertificate({
    subject: name,
    issuer: name,
    publicKey: key.publicKey,
    signingKey: key.privateKey,
    notBefore: new Date(t - DAY_MS),
    notAfter: new Date(t + 3650 * DAY_MS),
    extensions: [basicConstraintsExt(true, 0)],
  });
  writeFileSync(join(dir, "ca.pem"), toPem(der, "CERTIFICATE"));
}

test("an undersized CA key is refused with TLSUnavailable", withDir("autofoh_ca_", (d) => {
  const small = generateKeyPairSync("rsa", { modulusLength: 1024 });
  writeFileSync(join(d, "ca-key.pem"), small.privateKey.export({ type: "pkcs1", format: "pem" }));
  writeForeignCa(d, small);
  assert.throws(() => ensureTrustedCert(d, ["127.0.0.1"]), (e: unknown) => e instanceof TLSUnavailable && /1024/.test(e.message));
}));

test("a non-RSA CA key is refused with TLSUnavailable", withDir("autofoh_ca_", (d) => {
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  writeFileSync(join(d, "ca-key.pem"), ec.privateKey.export({ type: "pkcs8", format: "pem" }));
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeForeignCa(d, rsa);
  assert.ok(!certIsCa(join(d, "ca.pem"), join(d, "ca-key.pem")));
}));

test("file layout and key permissions", withDir("autofoh_ca_", (d) => {
  const [cert, key, ca] = ensureTrustedCert(join(d, "nested", ".certs"), ["127.0.0.1"]);
  assert.ok(cert.endsWith("cert.pem") && key.endsWith("key.pem") && ca.endsWith("ca.pem"));
  assert.ok(existsSync(join(d, "nested", ".certs", "ca-key.pem")));
  assert.match(readFileSync(key, "utf8"), /^-----BEGIN RSA PRIVATE KEY-----/);
  assert.equal((readFileSync(cert, "utf8").match(/BEGIN CERTIFICATE/g) ?? []).length, 2);
  if (process.platform !== "win32") {
    assert.equal(statSync(key).mode & 0o777, 0o600);
    assert.equal(statSync(join(d, "nested", ".certs", "ca-key.pem")).mode & 0o777, 0o600);
  }
}));

test("certificates parse back with the expected fields", withDir("autofoh_ca_", (d) => {
  const hosts = ["localhost", "127.0.0.1", "192.168.1.50", "::1", "fe80::1:2", "venue.local"];
  const [cert, key, ca] = ensureTrustedCert(d, hosts);
  const leaf = load(cert);
  const caC = load(ca);
  assert.equal(leaf.subject, "CN=AutoFOH Mix-Assistant");
  assert.equal(leaf.issuer, "CN=AutoFOH Mix-Assistant Local CA");
  assert.equal(caC.subject, "CN=AutoFOH Mix-Assistant Local CA");
  assert.equal(caC.issuer, caC.subject);
  assert.equal(caC.ca, true);
  assert.equal(leaf.ca, false);
  const san = sanEntries(leaf);
  assert.ok(san.includes("DNS:localhost") && san.includes("DNS:venue.local"));
  assert.ok(san.includes("IP Address:127.0.0.1") && san.includes("IP Address:192.168.1.50"));
  assert.ok(san.some((s) => s.startsWith("IP Address:") && s.includes("1:2")));
  assert.equal(san.length, hosts.length);
  const nb = new Date(leaf.validFrom).getTime();
  const na = new Date(leaf.validTo).getTime();
  assert.ok(Math.abs(nb - (Date.now() - DAY_MS)) < 60_000);
  assert.ok(Math.abs(na - (Date.now() + CERT_DAYS * DAY_MS)) < 60_000);
  const caNa = new Date(caC.validTo).getTime();
  assert.ok(Math.abs(caNa - (Date.now() + 3650 * DAY_MS)) < 60_000);
  assert.equal(leaf.verify(caC.publicKey), true);
  assert.equal(leaf.checkIssued(caC), true);
  assert.equal(caC.verify(caC.publicKey), true);
  assert.equal(leaf.checkPrivateKey(createPrivateKey(readFileSync(key))), true);
  assert.equal(leaf.checkIP("192.168.1.50"), "192.168.1.50");
  assert.equal(leaf.checkHost("venue.local"), "venue.local");
  assert.equal(leaf.checkIP("10.9.9.9"), undefined);
  assert.equal(leaf.publicKey.asymmetricKeyDetails?.modulusLength, 2048);
  assert.notEqual(leaf.serialNumber, caC.serialNumber);
}));

test("basicConstraints encodes the CA flag and path length", () => {
  assert.ok(basicConstraintsExt(true, 0).includes(Buffer.from([0x01, 0x01, 0xff, 0x02, 0x01, 0x00])));
  assert.ok(basicConstraintsExt(false, null).includes(Buffer.from([0x04, 0x02, 0x30, 0x00])));
});

test("lan ip listing and host list dedupe", () => {
  const iface = (address: string, internal = false): NetworkInterfaceInfo => ({
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: null,
  });
  const iface6 = (address: string): NetworkInterfaceInfo => ({
    address,
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: null,
    scopeid: 0,
  });
  const ips = allLanIps("192.168.1.50", {
    Ethernet: [iface("192.168.1.50"), iface6("fe80::1")],
    Wifi: [iface("10.0.0.4")],
    lo: [iface("127.0.0.1", true)],
    vpn: [iface("127.5.5.5"), iface("10.0.0.4")],
    empty: undefined,
  });
  assert.deepEqual(ips, ["192.168.1.50", "10.0.0.4"]);
  assert.deepEqual(tlsHosts(["127.0.0.1", "192.168.1.50", "192.168.1.50"]), ["localhost", "127.0.0.1", "192.168.1.50"]);
  assert.deepEqual(tlsHosts([]), ["localhost", "127.0.0.1"]);
  assert.ok(Array.isArray(allLanIps()));
});

test("trust instructions are returned as data", () => {
  const withIp = trustInstructions({ cafile: "C:/x/.certs/ca.pem", scheme: "https", port: 8080, ip: "192.168.1.50", host: "0.0.0.0" });
  assert.equal(withIp.steps.length, 3);
  assert.equal(withIp.steps[0]?.lines[0], "C:/x/.certs/ca.pem");
  assert.match(withIp.steps[0]?.lines[1] ?? "", /https:\/\/192\.168\.1\.50:8080\/ca\.pem/);
  assert.match(withIp.steps[2]?.title ?? "", /https:\/\/192\.168\.1\.50:8080\//);
  assert.equal(withIp.steps[1]?.lines.length, 4);
  const noIp = trustInstructions({ cafile: "ca.pem", scheme: "https", port: 1, ip: null, host: "127.0.0.1" });
  assert.equal(noIp.steps[0]?.lines.length, 1);
  assert.match(noIp.steps[2]?.title ?? "", /127\.0\.0\.1:1/);
});

test("openssl verifies the chain and reads the extensions", { skip: !opensslAvailable() }, withDir("autofoh_ssl_", (d) => {
  const [cert, , ca] = ensureTrustedCert(d, ["localhost", "127.0.0.1", "192.168.1.50"]);
  const v = spawnSync("openssl", ["verify", "-CAfile", ca, cert], { encoding: "utf8" });
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /OK/);
  const text = spawnSync("openssl", ["x509", "-text", "-noout", "-in", cert], { encoding: "utf8" });
  assert.equal(text.status, 0, text.stderr);
  const out = text.stdout.replace(/\r/g, "");
  assert.match(out, /Signature Algorithm: sha256WithRSAEncryption/);
  assert.match(out, /Issuer: CN\s*=\s*AutoFOH Mix-Assistant Local CA/);
  assert.match(out, /Public-Key: \(2048 bit\)/);
  assert.match(out, /X509v3 Basic Constraints: critical\s+CA:FALSE/);
  assert.match(out, /X509v3 Key Usage: critical\s+Digital Signature, Key Encipherment/);
  assert.match(out, /TLS Web Server Authentication/);
  assert.match(out, /DNS:localhost/);
  assert.match(out, /IP Address:192\.168\.1\.50/);
  assert.match(out, /X509v3 Authority Key Identifier/);
  const caText = spawnSync("openssl", ["x509", "-text", "-noout", "-in", ca], { encoding: "utf8" }).stdout.replace(/\r/g, "");
  assert.match(caText, /X509v3 Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
  assert.match(caText, /X509v3 Key Usage: critical\s+Certificate Sign, CRL Sign/);
  assert.match(caText, /X509v3 Subject Key Identifier/);
  const self = ensureCert(join(d, "self"), ["127.0.0.1"]);
  const sv = spawnSync("openssl", ["verify", "-CAfile", self[0], self[0]], { encoding: "utf8" });
  assert.match(sv.stdout, /OK/);
}));
