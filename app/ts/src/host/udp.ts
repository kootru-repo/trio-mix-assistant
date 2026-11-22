import dgram from "node:dgram";
import type { DatagramHandler, Peer, UdpEndpoint, UdpFactory } from "../core/transport.ts";

export class NodeUdpEndpoint implements UdpEndpoint {
  readonly port: number;
  private readonly socket: dgram.Socket;
  private closed = false;
  private errorCount = 0;
  private errorLast: unknown = null;

  constructor(socket: dgram.Socket, port: number) {
    this.socket = socket;
    this.port = port;
    socket.on("error", (e) => this.record(e));
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

  send(data: Uint8Array, to: Peer): void {
    if (this.closed) return;
    try {
      this.socket.send(data, to.port, to.host, (err) => {
        if (err) this.record(err);
      });
    } catch (e) {
      this.record(e);
    }
  }

  onMessage(handler: DatagramHandler): void {
    this.socket.on("message", (msg, rinfo) => {
      try {
        handler(new Uint8Array(msg), { host: rinfo.address, port: rinfo.port });
      } catch (e) {
        this.record(e);
      }
    });
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

export class NodeUdpFactory implements UdpFactory {
  bind(port: number, host: string): Promise<UdpEndpoint> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: false });
      const onError = (err: Error): void => {
        socket.close();
        reject(err);
      };
      socket.once("error", onError);
      socket.bind(port, host, () => {
        socket.off("error", onError);
        resolve(new NodeUdpEndpoint(socket, socket.address().port));
      });
    });
  }
}
