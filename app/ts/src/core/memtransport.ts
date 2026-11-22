import type { DatagramHandler, Peer, UdpEndpoint, UdpFactory } from "./transport.ts";

class MemEndpoint implements UdpEndpoint {
  readonly port: number;
  private readonly net: MemNetwork;
  private handlers: DatagramHandler[] = [];
  private closed = false;

  constructor(net: MemNetwork, port: number) {
    this.net = net;
    this.port = port;
  }

  send(data: Uint8Array, to: Peer): void {
    if (this.closed) return;
    this.net.deliver(data, { host: "127.0.0.1", port: this.port }, to);
  }

  onMessage(handler: DatagramHandler): void {
    this.handlers.push(handler);
  }

  receive(data: Uint8Array, from: Peer): void {
    if (this.closed) return;
    for (const h of this.handlers) h(data, from);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.net.release(this.port);
  }
}

export class MemNetwork implements UdpFactory {
  private readonly endpoints = new Map<number, MemEndpoint>();
  private nextPort = 49152;
  private pending = 0;

  bind(port: number, _host: string): Promise<UdpEndpoint> {
    let p = port;
    if (p === 0) {
      while (this.endpoints.has(this.nextPort)) this.nextPort++;
      p = this.nextPort++;
    } else if (this.endpoints.has(p)) {
      return Promise.reject(new Error(`address in use: ${p}`));
    }
    const ep = new MemEndpoint(this, p);
    this.endpoints.set(p, ep);
    return Promise.resolve(ep);
  }

  deliver(data: Uint8Array, from: Peer, to: Peer): void {
    const copy = data.slice();
    this.pending++;
    void Promise.resolve().then(() => {
      try {
        this.endpoints.get(to.port)?.receive(copy, from);
      } finally {
        this.pending--;
      }
    });
  }

  release(port: number): void {
    this.endpoints.delete(port);
  }

  async settle(): Promise<void> {
    for (let guard = 0; guard < 10000 && this.pending > 0; guard++) await Promise.resolve();
    await Promise.resolve();
  }
}
