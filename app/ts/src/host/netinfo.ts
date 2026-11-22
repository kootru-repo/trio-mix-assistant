import dgram from "node:dgram";
import { networkInterfaces } from "node:os";

const quietly = (fn: () => void): void => {
  try {
    fn();
  } catch {
    return;
  }
};

const UNUSABLE = ["", "0.0.0.0", "::"];

export function pickLanIp(routed: string | null, local: readonly string[]): string | null {
  if (routed !== null && !UNUSABLE.includes(routed)) return routed;
  return local.find((a) => !UNUSABLE.includes(a) && !a.startsWith("127.") && !a.startsWith("169.254.")) ?? null;
}

export function localIpv4(): string[] {
  const found: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === "IPv4" && !item.internal) found.push(item.address);
    }
  }
  return found;
}

function routedIp(): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      quietly(() => socket.close());
      resolve(value);
    };
    socket.once("error", () => done(null));
    try {
      socket.connect(80, "8.8.8.8", (err?: Error | null) => {
        if (err) {
          done(null);
          return;
        }
        try {
          done(socket.address().address);
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });
}

export async function lanIp(): Promise<string | null> {
  return pickLanIp(await routedIp(), localIpv4());
}
