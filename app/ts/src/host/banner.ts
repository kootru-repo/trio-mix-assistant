import type { Config } from "../core/config.ts";
import type { Args } from "./args.ts";

const WILDCARD_HOSTS = ["0.0.0.0", "::"];
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

export function trustStepsLines(args: Args, scheme: string, ip: string | null, caPath: string): string[] {
  const hostUrl = ip || (!WILDCARD_HOSTS.includes(args.host) ? args.host : "127.0.0.1");
  const lines: string[] = [];
  lines.push("  Trusted TLS — do this ONCE per device for ZERO warnings:");
  lines.push("    1) Get the root CA onto the device — copy / AirDrop / email this file:");
  lines.push(`         ${caPath}`);
  if (ip) {
    lines.push(`       (or, if a device lets you tap through the warning once: ${scheme}://${ip}:${args.port}/ca.pem )`);
  }
  lines.push("    2) Install + TRUST it:");
  lines.push("         iOS:     install the profile, then Settings > General > About > Certificate Trust Settings > enable it");
  lines.push("         Android: Settings > Security > Install a certificate > CA certificate");
  lines.push("         macOS:   double-click > Keychain 'System' > set this cert to 'Always Trust'");
  lines.push(
    "         Windows: rename it to end in .crt, double-click > Install Certificate > Local Machine > 'Trusted Root Certification Authorities'",
  );
  lines.push(`    3) Reload  ${scheme}://${hostUrl}:${args.port}/  — trusted, no warning.`);
  return lines;
}

export interface BannerInput {
  args: Args;
  scheme: string;
  ip: string | null;
  altIps: readonly string[];
  caPath: string;
  qr: readonly string[] | null;
  version?: string;
}

export function bannerLines(input: BannerInput): string[] {
  const { args, scheme, ip } = input;
  const lines: string[] = [];
  const mode = args.emulate ? "EMULATED-HARDWARE" : args.hardware ? "HARDWARE" : "SIMULATION";
  const open = WILDCARD_HOSTS.includes(args.host);
  lines.push(
    `Trio Mix-Assistant${input.version ? ` ${input.version}` : ""} [${mode}] -> ${scheme}://${open ? "127.0.0.1" : args.host}:${args.port}/`,
  );
  if (args.pin) {
    lines.push("  PIN auth: ON — the dashboard asks for the PIN before it opens.");
    if (scheme !== "https" && !LOOPBACK_HOSTS.includes(args.host))
      lines.push("  [!] PIN over plain http is sniffable on the LAN — add --https.");
  } else if (WILDCARD_HOSTS.includes(args.host)) {
    lines.push("  [!] No PIN: anyone on this network can open the dashboard and control the");
    lines.push("      console. On shared WiFi set one (--pin, or PIN= in show.conf).");
  }
  if (args.trust && scheme === "https") lines.push(...trustStepsLines(args, scheme, ip, input.caPath));
  if (args.emulate) {
    lines.push("  Real OSC stack over localhost sockets against the desk emulator.");
    lines.push("  NB: wire formats are assumptions — validate them with the bring-up checklist:");
    lines.push("      https://github.com/kootru-repo/trio-mix-assistant/blob/main/app/HARDWARE_BRINGUP.md");
  }
  if (WILDCARD_HOSTS.includes(args.host) && ip) {
    const tabletUrl = `${scheme}://${ip}:${args.port}/`;
    lines.push(`  Phone or tablet (iPhone, iPad, Android): open  ${tabletUrl}  then Add to Home Screen`);
    const alts = input.altIps.filter((a) => a !== ip);
    if (alts.length) {
      lines.push("  If that's unreachable, try: " + alts.map((a) => `${scheme}://${a}:${args.port}/`).join(", "));
    }
    if (scheme === "https" && !args.trust)
      lines.push("  (self-signed: accept the certificate warning once on each device; it returns on a new network)");
    if (input.qr) {
      lines.push("  Scan with the phone or tablet camera:");
      lines.push(...input.qr);
    }
  } else if (WILDCARD_HOSTS.includes(args.host)) {
    lines.push("  No network address was found for this computer. On a phone or tablet, open");
    lines.push(`  ${scheme}://<this computer's IP address>:${args.port}/`);
  } else if (scheme === "http") {
    lines.push("  For a phone or tablet, restart with  --lan --https --pin <6+ characters>");
    lines.push("  (or set LAN=yes and PIN= in show.conf).");
  }
  lines.push("Press Ctrl+C to stop.");
  return lines;
}

export function emulatorLines(cfg: Config, ip: string | null, listenPort: number, trace: boolean, lan: boolean = false): string[] {
  const lines = [
    "  Mixer app: connect Mixing Station (console type Behringer X32, access",
    `             Full) to  ${ip ?? "127.0.0.1"}:${listenPort}  — appears as "${cfg.X32_NAME}" in search.`,
    `             X32-Edit also works; identity = ${cfg.X32_MODEL}/${cfg.X32_FW}` + (trace ? "  [--trace-osc ON]" : ""),
  ];
  if (ip === null) {
    lines.push(
      lan
        ? "             No network address was found: from a phone or tablet, use this computer's IP address."
        : "             This computer only: add --lan (with a PIN) to reach it from a phone or tablet.",
    );
  }
  return lines;
}
