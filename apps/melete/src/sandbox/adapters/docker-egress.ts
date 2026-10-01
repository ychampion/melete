/**
 * The only way out of a docker sandbox whose connection allows the internet.
 *
 * Such a sandbox sits alone on an internal network whose one other member is
 * this service, so the only thing it can open is this relay. The relay tunnels
 * HTTPS (`CONNECT host:443`) for a client address it was told belongs to a
 * sandbox, and only when every address the name resolves to is public; the
 * tunnel goes to the address that was checked, never to a second lookup. Plain
 * HTTP, other ports, private, loopback and link-local addresses (the host,
 * other containers, cloud metadata) are refused. These are the public-address
 * floor and pinned DNS the web connector, the browser worker's relay and the
 * stdio egress proxy already hold, applied to one more client.
 *
 * A sandbox is known by its address on its own network: it holds no token,
 * so nothing it can print or leak opens another sandbox's grant, and a
 * container without network capabilities cannot take another's address.
 */
import { createServer, type Server } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import { publicPin, type ResolvedAddress, resolveHost } from '../../connectors/web.ts';

export type SandboxEgressOptions = {
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
  dial?: (port: number, address: string) => Socket;
  /** Tunnels one sandbox may hold open at once. */
  maxTunnels?: number;
  idleMs?: number;
};

/** The port a tunnel may reach: HTTPS, as the browser worker's relay allows. */
export const EGRESS_PORT = 443;

function refuse(socket: Socket, status: 403 | 405 | 407, reason: string) {
  const text =
    status === 407
      ? 'Proxy Authentication Required'
      : status === 405
        ? 'Method Not Allowed'
        : 'Forbidden';
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\nX-Melete-Egress: ${reason}\r\n\r\n`,
  );
}

/** `::ffff:10.0.0.2` and `10.0.0.2` are one client. */
export function clientAddress(address: string | undefined): string {
  const value = (address ?? '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value)?.[1];
  return mapped ?? value;
}

type Grant = { sandbox: string; tunnels: Set<() => void> };

export class SandboxEgressGuard {
  private readonly grants = new Map<string, Grant>();
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;
  private readonly resolve: (host: string) => Promise<ResolvedAddress[]>;
  private readonly dial: (port: number, address: string) => Socket;
  private listening?: Promise<number>;

  constructor(private readonly options: SandboxEgressOptions = {}) {
    this.resolve = options.resolve ?? resolveHost;
    this.dial = options.dial ?? ((port, address) => connect(port, address));
    this.server = createServer((request, response) => {
      // Only tunnels: a plain request would let the relay read and rewrite what it carries.
      request.resume();
      response
        .writeHead(405, {
          connection: 'close',
          'content-length': '0',
          'x-melete-egress': 'https_only',
        })
        .end();
    });
    this.server.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.server.on('connect', (request, client: Socket, head: Buffer) => {
      void this.tunnel(request.url ?? '', client, head);
    });
  }

  /** The sandbox at this address may open tunnels until it is revoked or replaced. */
  allow(address: string, sandbox: string): void {
    const key = clientAddress(address);
    if (!isIP(key)) throw new Error('a sandbox egress grant needs an IP address');
    const current = this.grants.get(key);
    if (current?.sandbox === sandbox) return;
    // An address handed to a new container ends whatever the old one held.
    if (current) this.end(current);
    this.grants.set(key, { sandbox, tunnels: new Set() });
  }

  /** Every grant this sandbox holds ends, with the tunnels it opened. */
  revoke(sandbox: string): void {
    for (const [key, grant] of this.grants)
      if (grant.sandbox === sandbox) {
        this.grants.delete(key);
        this.end(grant);
      }
  }

  granted(sandbox: string): string[] {
    return [...this.grants].filter(([, grant]) => grant.sandbox === sandbox).map(([key]) => key);
  }

  /** Listens once; later calls wait for the same listener. */
  listen(port: number, hostname = '0.0.0.0'): Promise<number> {
    this.listening ??= new Promise<number>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, hostname, () => {
        this.server.off('error', reject);
        const address = this.server.address();
        if (!address || typeof address === 'string')
          reject(new Error('the egress guard has no port'));
        else resolve(address.port);
      });
    });
    return this.listening;
  }

  async close(): Promise<void> {
    for (const each of this.grants.values()) this.end(each);
    this.grants.clear();
    for (const socket of this.sockets) socket.destroy();
    if (this.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private end(grant: Grant): void {
    for (const release of [...grant.tunnels]) release();
  }

  private async tunnel(target: string, client: Socket, head: Buffer) {
    client.on('error', () => client.destroy());
    const grant = this.grants.get(clientAddress(client.remoteAddress));
    if (!grant) return refuse(client, 407, 'not_a_sandbox');
    const match = /^([a-z0-9.-]+|\[[0-9a-f:.]+\]):(\d{1,5})$/i.exec(target);
    const host = match?.[1]?.toLowerCase().replace(/^\[|\]$/g, '');
    const port = Number(match?.[2]);
    if (!host || port !== EGRESS_PORT) return refuse(client, 403, 'destination_denied');
    if (grant.tunnels.size >= (this.options.maxTunnels ?? 64))
      return refuse(client, 403, 'too_many_tunnels');
    let pinned: ResolvedAddress | undefined;
    try {
      const family = isIP(host);
      pinned = publicPin(
        family ? [{ address: host, family: family as 4 | 6 }] : await this.resolve(host),
      );
    } catch {
      pinned = undefined;
    }
    if (!pinned) return refuse(client, 403, 'address_denied');
    // The grant may have ended while the name was resolving.
    if (this.grants.get(clientAddress(client.remoteAddress)) !== grant)
      return refuse(client, 407, 'not_a_sandbox');
    const upstream = this.dial(port, pinned.address);
    const release = () => {
      grant.tunnels.delete(release);
      upstream.destroy();
      client.destroy();
    };
    grant.tunnels.add(release);
    upstream.once('error', release);
    upstream.once('close', release);
    client.once('close', release);
    upstream.once('connect', () => {
      if (client.destroyed) return release();
      const idle = this.options.idleMs ?? 5 * 60_000;
      client.setTimeout(idle, release);
      upstream.setTimeout(idle, release);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
  }
}
