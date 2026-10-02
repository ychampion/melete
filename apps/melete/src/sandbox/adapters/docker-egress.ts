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
 * A sandbox is known by its address on its own network: no secret it holds
 * opens another sandbox's grant, and a container without network capabilities
 * cannot take another's address. On top of that, each command the service runs
 * carries a token in its proxy address naming that command (see
 * egress/tokens.ts). The token only says which command a tunnel belongs to, and
 * it counts only from the computer it was minted for: a token presented from
 * another computer is refused, and a connection with no live token is still
 * tunnelled, as unattributed.
 *
 * A grant is `open`, any public HTTPS host, or `connected_hosts_only`, the hosts
 * of the space's connected accounts and the operator's list, read again at each
 * connection. Every tunnel and every refusal for a granted computer is recorded.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import { publicPin, type ResolvedAddress, resolveHost } from '../../connectors/web.ts';
import type { EgressRecordSink } from '../../egress/records.ts';
import {
  type EgressAttribution,
  type EgressHostCounters,
  type EgressTokenEntry,
  EgressTokens,
} from '../../egress/tokens.ts';

export type SandboxEgressMode = 'open' | 'connected_hosts_only';

export type SandboxEgressOptions = {
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
  dial?: (port: number, address: string) => Socket;
  /** Tunnels one sandbox may hold open at once. */
  maxTunnels?: number;
  idleMs?: number;
  /** Where tunnels and refusals are recorded. */
  records?: EgressRecordSink;
  /**
   * The hosts a `connected_hosts_only` computer of this space may reach: exact
   * names, or `.suffix` for every name below it. Asked at each connection.
   */
  connectedHosts?: (space: string | null) => readonly string[] | Promise<readonly string[]>;
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

/**
 * Whether a host is on a list of exact names and `.suffix` entries. A suffix
 * covers the names below it, not itself; an address literal is on no list.
 */
export function hostListed(host: string, list: readonly string[]): boolean {
  const name = host.toLowerCase();
  if (isIP(name)) return false;
  return list.some((entry) => {
    const item = entry.toLowerCase();
    return item.startsWith('.') ? name.length > item.length && name.endsWith(item) : name === item;
  });
}

/**
 * The token in a `Proxy-Authorization: Basic` header, or null. Anything that
 * is not that shape carries no token, and the connection is unattributed.
 */
export function proxyToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Basic ([A-Za-z0-9+/=]{1,1024})$/.exec(value?.trim() ?? '');
  if (!match?.[1]) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon >= 0 && colon < decoded.length - 1 ? decoded.slice(colon + 1) : null;
}

type Grant = {
  sandbox: string;
  mode: SandboxEgressMode;
  /** The session that last ran a command here; unattributed records go to it. */
  session: string | null;
  space: string | null;
  tunnels: Set<() => void>;
};

export type SandboxEgressGrantOptions = {
  mode?: SandboxEgressMode;
  session?: string | null;
  space?: string | null;
};

/** Who a connection is from, once the computer and its token are known. */
type Caller =
  | { grant: Grant; token: EgressTokenEntry | null; refused?: undefined }
  | { grant: Grant; token: null; refused: 'token_refused' };

export class SandboxEgressGuard {
  private readonly grants = new Map<string, Grant>();
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;
  private readonly resolve: (host: string) => Promise<ResolvedAddress[]>;
  private readonly dial: (port: number, address: string) => Socket;
  private listening?: Promise<number>;
  /** The tokens of commands running in granted computers. */
  readonly tokens = new EgressTokens();

  constructor(private readonly options: SandboxEgressOptions = {}) {
    this.resolve = options.resolve ?? resolveHost;
    this.dial = options.dial ?? ((port, address) => connect(port, address));
    this.server = createServer((request, response) => {
      // Only tunnels: a plain request would let the relay read and rewrite what it carries.
      request.resume();
      this.refusedPlain(request);
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
    this.server.on('connect', (request: IncomingMessage, client: Socket, head: Buffer) => {
      void this.tunnel(request.url ?? '', request.headers['proxy-authorization'], client, head);
    });
  }

  /** The sandbox at this address may open tunnels until it is revoked or replaced. */
  allow(address: string, sandbox: string, options: SandboxEgressGrantOptions = {}): void {
    const key = clientAddress(address);
    if (!isIP(key)) throw new Error('a sandbox egress grant needs an IP address');
    const mode = options.mode ?? 'open';
    const current = this.grants.get(key);
    if (current?.sandbox === sandbox) {
      current.mode = mode;
      if (options.session) current.session = options.session;
      if (options.space) current.space = options.space;
      return;
    }
    // An address handed to a new container ends whatever the old one held.
    if (current) {
      this.end(current);
      this.tokens.revokeSandbox(current.sandbox);
    }
    this.grants.set(key, {
      sandbox,
      mode,
      session: options.session ?? null,
      space: options.space ?? null,
      tunnels: new Set(),
    });
  }

  /** Every grant this sandbox holds ends, with the tunnels it opened and its commands' tokens. */
  revoke(sandbox: string): void {
    for (const [key, grant] of this.grants)
      if (grant.sandbox === sandbox) {
        this.grants.delete(key);
        this.end(grant);
      }
    this.tokens.revokeSandbox(sandbox);
  }

  granted(sandbox: string): string[] {
    return [...this.grants].filter(([, grant]) => grant.sandbox === sandbox).map(([key]) => key);
  }

  /**
   * A token for one command in this computer. Tunnels it opens are recorded
   * against the command until `tokens.settle` ends it.
   */
  mint(sandbox: string, attribution: EgressAttribution): string {
    for (const grant of this.grants.values())
      if (grant.sandbox === sandbox) grant.session = attribution.sessionId;
    return this.tokens.mint(sandbox, attribution);
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
    for (const each of this.grants.values()) {
      this.end(each);
      this.tokens.revokeSandbox(each.sandbox);
    }
    this.grants.clear();
    for (const socket of this.sockets) socket.destroy();
    if (this.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private end(grant: Grant): void {
    for (const release of [...grant.tunnels]) release();
  }

  /**
   * The computer a connection comes from, and the command its token names.
   * A live token minted for another computer is refused outright; a missing,
   * malformed or ended token leaves the connection unattributed.
   */
  private caller(
    remote: string | undefined,
    authorization: string | string[] | undefined,
  ): Caller | null {
    const grant = this.grants.get(clientAddress(remote));
    if (!grant) return null;
    const presented = proxyToken(authorization);
    const token = presented ? (this.tokens.find(presented) ?? null) : null;
    if (token && token.sandbox !== grant.sandbox)
      return { grant, token: null, refused: 'token_refused' };
    return { grant, token };
  }

  private counters(token: EgressTokenEntry | null, host: string): EgressHostCounters | null {
    if (!token) return null;
    let counters = token.hosts.get(host);
    if (!counters) {
      counters = { tunnels: 0, refused: 0, bytesUp: 0, bytesDown: 0 };
      token.hosts.set(host, counters);
    }
    return counters;
  }

  /** One refusal of a granted computer, on its record and its command's receipt. */
  private recordRefusal(
    grant: Grant,
    token: EgressTokenEntry | null,
    host: string,
    port: number,
    reason: string,
  ) {
    const counters = this.counters(token, host);
    if (counters) counters.refused += 1;
    const session = token?.attribution.sessionId ?? grant.session;
    if (!session) return;
    const now = new Date();
    this.options.records?.opened({
      id: randomUUID(),
      sessionId: session,
      jobId: token?.attribution.jobId ?? null,
      attemptId: token?.attribution.attemptId ?? null,
      actionId: token?.attribution.actionId ?? null,
      tokenKind: token?.attribution.kind ?? null,
      host,
      port,
      verdict: 'refused',
      reason,
      openedAt: now,
      closedAt: now,
    });
  }

  /** A plain request from a granted computer is refused, and recorded with what it named. */
  private refusedPlain(request: IncomingMessage) {
    const found = this.caller(request.socket.remoteAddress, request.headers['proxy-authorization']);
    if (!found) return;
    let host = '';
    let port = 80;
    try {
      const url = new URL(request.url ?? '', 'http://unknown.invalid');
      host = url.hostname === 'unknown.invalid' ? '' : url.hostname;
      port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    } catch {
      // Unparseable: recorded with no host.
    }
    this.recordRefusal(found.grant, found.token, host, port, 'https_only');
  }

  private async tunnel(
    target: string,
    authorization: string | string[] | undefined,
    client: Socket,
    head: Buffer,
  ) {
    client.on('error', () => client.destroy());
    const found = this.caller(client.remoteAddress, authorization);
    if (!found) return refuse(client, 407, 'not_a_sandbox');
    const match = /^([a-z0-9.-]+|\[[0-9a-f:.]+\]):(\d{1,5})$/i.exec(target);
    const host = match?.[1]?.toLowerCase().replace(/^\[|\]$/g, '');
    const port = Number(match?.[2] ?? 0);
    const { grant, token } = found;
    const deny = (status: 403 | 407, reason: string) => {
      this.recordRefusal(grant, token, host ?? target.slice(0, 255), port, reason);
      return refuse(client, status, reason);
    };
    if (found.refused) return deny(407, found.refused);
    if (!host || port !== EGRESS_PORT) return deny(403, 'destination_denied');
    if (grant.mode !== 'open') {
      let listed = false;
      try {
        listed = hostListed(host, (await this.options.connectedHosts?.(grant.space)) ?? []);
      } catch {
        // A list that cannot be read lets nothing through.
      }
      if (!listed) return deny(403, 'host_not_connected');
    }
    if (grant.tunnels.size >= (this.options.maxTunnels ?? 64)) return deny(403, 'too_many_tunnels');
    let pinned: ResolvedAddress | undefined;
    try {
      const family = isIP(host);
      pinned = publicPin(
        family ? [{ address: host, family: family as 4 | 6 }] : await this.resolve(host),
      );
    } catch {
      pinned = undefined;
    }
    if (!pinned) return deny(403, 'address_denied');
    // The grant may have ended while the name was resolving.
    if (this.grants.get(clientAddress(client.remoteAddress)) !== grant)
      return refuse(client, 407, 'not_a_sandbox');
    const counters = this.counters(token, host);
    if (counters) counters.tunnels += 1;
    const record = randomUUID();
    const session = token?.attribution.sessionId ?? grant.session;
    if (session)
      this.options.records?.opened({
        id: record,
        sessionId: session,
        jobId: token?.attribution.jobId ?? null,
        attemptId: token?.attribution.attemptId ?? null,
        actionId: token?.attribution.actionId ?? null,
        tokenKind: token?.attribution.kind ?? null,
        host,
        port,
        verdict: token ? 'tunnel' : 'unattributed',
        reason: null,
        openedAt: new Date(),
      });
    let bytesUp = 0;
    let bytesDown = 0;
    let closed = false;
    const upstream = this.dial(port, pinned.address);
    const release = () => {
      grant.tunnels.delete(release);
      upstream.destroy();
      client.destroy();
      if (closed) return;
      closed = true;
      if (session)
        this.options.records?.closed(record, { bytesUp, bytesDown, closedAt: new Date() });
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
      client.on('data', (chunk: Buffer) => {
        bytesUp += chunk.length;
        if (counters) counters.bytesUp += chunk.length;
      });
      upstream.on('data', (chunk: Buffer) => {
        bytesDown += chunk.length;
        if (counters) counters.bytesDown += chunk.length;
      });
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) {
        bytesUp += head.length;
        if (counters) counters.bytesUp += head.length;
        upstream.write(head);
      }
      client.pipe(upstream).pipe(client);
    });
  }
}
