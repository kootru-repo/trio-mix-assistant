import dgram from "node:dgram";
import type { DatagramHandler, Peer, UdpEndpoint, UdpFactory } from "../core/transport.ts";

class NodeUdpEndpoint implements UdpEndpoint {
  readonly port: number;
  private readonly socket: dgram.Socket;
  private closed = false;

  constructor(socket: dgram.Socket, port: number) {
    this.socket = socket;
    this.port = port;
    socket.on("error", () => undefined);
  }

  send(data: Uint8Array, to: Peer): void {
    if (this.closed) return;
    this.socket.send(data, to.port, to.host, () => undefined);
  }

  onMessage(handler: DatagramHandler): void {
    this.socket.on("message", (msg, rinfo) => {
      handler(new Uint8Array(msg), { host: rinfo.address, port: rinfo.port });
    });
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
