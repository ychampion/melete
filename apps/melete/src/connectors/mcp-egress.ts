/**
 * The only way out for a stdio MCP server that was given any network at all.
 *
 * A server's container sits on an internal network whose one other member is
 * the service, so it can open nothing but this proxy. The proxy tunnels HTTPS
 * (`CONNECT host:port`) for a request carrying a grant's token, to a
 * destination that grant names, and only when every address the name resolves
 * to is public; the connection goes to the address that was checked. Plain
 * HTTP, other destinations and private addresses are refused.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { publicPin, type ResolvedAddress, resolveHost } from './web.ts';

export type EgressGrant = {
  /** Goes in the server's proxy address as `http://mcp:<token>@host:port`. */
  token: string;
  revoke(): void;
};

export type EgressProxyOptions = {
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
  dial?: (port: number, address: string) => Socket;
  /** Open tunnels one grant may hold at once. */
  maxTunnels?: number;
  idleMs?: number;
};

type Grant = { destinations: ReadonlySet<string>; tunnels: Set<() => void> };

/** `host` means port 443; `host:port` names another; `*` is any public host on 443. */
export function egressDestination(entry: string): string {
  const [host = '', port = '443'] = entry.toLowerCase().split(':');
  return `${host}:${port}`;
}

function refuse(socket: Socket, status: 403 | 407, reason: string) {
  const text = status === 407 ? 'Proxy Authentication Required' : 'Forbidden';
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\nX-Melete-Egress: ${reason}\r\n` +
      (status === 407 ? 'Proxy-Authenticate: Basic realm="melete"\r\n' : '') +
      '\r\n',
  );
}

export class EgressProxy {
  private readonly grants = new Map<string, Grant>();
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;
  private readonly resolve: (host: string) => Promise<ResolvedAddress[]>;
  private readonly dial: (port: number, address: string) => Socket;

  constructor(private readonly options: EgressProxyOptions = {}) {
    this.resolve = options.resolve ?? resolveHost;
    this.dial = options.dial ?? ((port, address) => connect(port, address));
    this.server = createServer((request, response) => {
      // Only tunnels: a plain request would let the proxy read and rewrite what it carries.
      request.resume();
      response.writeHead(405, { connection: 'close', 'content-length': '0' }).end();
    });
    this.server.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.server.on('connect', (request, client: Socket, head: Buffer) => {
      void this.tunnel(request.url ?? '', request.headers['proxy-authorization'], client, head);
    });
  }

  /** A token that opens exactly these destinations until it is revoked. */
  grant(entries: readonly string[]): EgressGrant {
    const token = randomBytes(24).toString('base64url');
    const grant: Grant = {
      destinations: new Set(entries.map(egressDestination)),
      tunnels: new Set(),
    };
    this.grants.set(token, grant);
    return {
      token,
      revoke: () => {
        // Tunnels already open close with the grant that opened them.
        this.grants.delete(token);
        for (const close of [...grant.tunnels]) close();
      },
    };
  }

  async listen(port: number, hostname = '0.0.0.0'): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, hostname, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Egress proxy has no port');
    return address.port;
  }

  async close(): Promise<void> {
    this.grants.clear();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private lookup(header: string | undefined): Grant | undefined {
    const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header ?? '');
    if (!match?.[1]) return undefined;
    const presented = Buffer.from(match[1], 'base64')
      .toString('utf8')
      .split(':')
      .slice(1)
      .join(':');
    for (const [token, grant] of this.grants) {
      const expected = Buffer.from(token);
      const given = Buffer.from(presented);
      if (expected.length === given.length && timingSafeEqual(expected, given)) return grant;
    }
    return undefined;
  }

  private async tunnel(
    target: string,
    authorization: string | undefined,
    client: Socket,
    head: Buffer,
  ) {
    client.on('error', () => client.destroy());
    const grant = this.lookup(authorization);
    if (!grant) return refuse(client, 407, 'grant_required');
    const match = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(target);
    const host = match?.[1]?.toLowerCase();
    const port = Number(match?.[2]);
    // `*` opens any public HTTPS site; the address check below still applies to it.
    const named = grant.destinations.has(`${host}:${port}`);
    const anySite = port === 443 && grant.destinations.has('*:443');
    if (!host || !port || port > 65535 || !(named || anySite))
      return refuse(client, 403, 'destination_denied');
    if (grant.tunnels.size >= (this.options.maxTunnels ?? 32))
      return refuse(client, 403, 'too_many_tunnels');
    let pinned: ResolvedAddress | undefined;
    try {
      pinned = publicPin(await this.resolve(host));
    } catch {
      pinned = undefined;
    }
    if (!pinned) return refuse(client, 403, 'address_denied');
    // The grant may have been revoked while the name was resolving.
    if (![...this.grants.values()].includes(grant)) return refuse(client, 407, 'grant_required');
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
