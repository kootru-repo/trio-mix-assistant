export interface Peer {
  host: string;
  port: number;
}

export type DatagramHandler = (data: Uint8Array, from: Peer) => void;

export interface UdpEndpoint {
  readonly port: number;
  send(data: Uint8Array, to: Peer): void;
  onMessage(handler: DatagramHandler): void;
  close(): void;
}

export interface UdpFactory {
  bind(port: number, host: string): Promise<UdpEndpoint>;
}
