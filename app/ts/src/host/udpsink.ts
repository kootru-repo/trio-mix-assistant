import dgram from "node:dgram";
import type { DatagramSink } from "../core/console.ts";

export class UdpSink implements DatagramSink {
  private readonly socket: dgram.Socket;
  private readonly ip: string;
  private readonly port: number;
  private closed = false;
  private errorCount = 0;
  private errorLast: unknown = null;

  constructor(ip: string, port: number) {
    this.ip = ip;
    this.port = port;
    this.socket = dgram.createSocket("udp4");
    this.socket.on("error", (e) => this.record(e));
    this.socket.unref();
  }

  get lastError(): unknown {
    return this.errorLast;
  }

  get failures(): number {
    return this.errorCount;
  }

  private record(e: unknown): void {
    this.errorCount++;
    this.errorLast = e;
  }

  send(data: Uint8Array): void {
    if (this.closed) return;
    try {
      this.socket.send(data, this.port, this.ip, (err) => {
        if (err) this.record(err);
      });
    } catch (e) {
      this.record(e);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close();
    } catch (e) {
      this.record(e);
    }
  }
}
