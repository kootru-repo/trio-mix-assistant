import dgram from "node:dgram";
import { networkInterfaces } from "node:os";

export function lanIp(): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        resolve(value);
        return;
      }
      resolve(value);
    };
    socket.once("error", () => done(null));
    try {
      socket.connect(80, "8.8.8.8", () => {
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

export async function allLanIps(): Promise<string[]> {
  const ips: string[] = [];
  const primary = await lanIp();
  if (primary) ips.push(primary);
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const info of list ?? []) {
        if (info.family === "IPv4" && !info.internal && !info.address.startsWith("127.") && !ips.includes(info.address)) {
          ips.push(info.address);
        }
      }
    }
  } catch {
    return ips;
  }
  return ips;
}
