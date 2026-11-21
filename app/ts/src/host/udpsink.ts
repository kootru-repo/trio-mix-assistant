import dgram from "node:dgram";
import type { DatagramSink } from "../core/console.ts";

export class UdpSink implements DatagramSink {
  private readonly socket: dgram.Socket;
  private readonly ip: string;
  private readonly port: number;
  private closed = false;

  constructor(ip: string, port: number) {
    this.ip = ip;
    this.port = port;
    this.socket = dgram.createSocket("udp4");
    this.socket.on("error", () => undefined);
    this.socket.unref();
  }

  send(data: Uint8Array): void {
    if (this.closed) return;
    this.socket.send(data, this.port, this.ip, () => undefined);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      return;
    }
  }
}
