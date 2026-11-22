import dgram from "node:dgram";

const quietly = (fn: () => void): void => {
  try {
    fn();
  } catch {
    return;
  }
};

export function lanIp(): Promise<string | null> {
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
