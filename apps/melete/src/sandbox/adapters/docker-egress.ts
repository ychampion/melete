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
 * connection. Every tunnel and every refusal for a granted computer is recorded,
 * within a budget: the same refusal repeated within a minute is one record with
 * a count, and past `recordsPerMinute` records a computer's further connections
 * are counted on one `suppressed` record for that minute, so a computer that
 * loops cannot fill the database.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import { publicPin, type ResolvedAddress, resolveHost } from '../../connectors/web.ts';
import type { EgressCredentialPort } from '../../egress/credentials.ts';
import { type InterceptOptions, interceptTunnel } from '../../egress/intercept.ts';
import type { EgressRecordSink } from '../../egress/records.ts';
import {
  type EgressAttribution,
  type EgressHostCounters,
  type EgressTokenEntry,
  EgressTokens,
  hostCounters,
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
  /** Records one computer may add per minute before the rest are counted on one record. */
  recordsPerMinute?: number;
  now?: () => number;
  /**
   * Connected command-line accounts. With one for a command's space and host,
   * the tunnel is terminated and each request checked and credentialed (see
   * egress/intercept.ts); without, every tunnel stays blind.
   */
  credentials?: EgressCredentialPort;
  /** Limits and test routes for terminated tunnels. */
  intercept?: InterceptOptions;
};

/** How long a record budget lasts, and how often coalesced counts are written. */
const RECORD_WINDOW_MS = 60_000;
const RECORD_FLUSH_MS = 5_000;
export const DEFAULT_RECORDS_PER_MINUTE = 120;

/** One record whose count grows while the window lasts. */
type Counted = { id: string; count: number; written: number };

/** What one computer has recorded in the current minute. */
type RecordWindow = {
  start: number;
  written: number;
  refusals: Map<string, Counted>;
  suppressed: Counted | null;
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
  records: RecordWindow;
  /** Requests of this computer held for an answer right now. */
  held: { count: number };
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
  private readonly now: () => number;
  private readonly flusher: ReturnType<typeof setInterval>;

  constructor(private readonly options: SandboxEgressOptions = {}) {
    this.now = options.now ?? Date.now;
    this.flusher = setInterval(() => this.flushRecords(), RECORD_FLUSH_MS);
    this.flusher.unref?.();
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
      // Narrowed: what was opened under the wider mode ends now.
      if (current.mode === 'open' && mode !== 'open') this.end(current);
      current.mode = mode;
      if (options.session) current.session = options.session;
      if (options.space) current.space = options.space;
      return;
    }
    // An address handed to a new container ends whatever the old one held.
    if (current) {
      this.end(current);
      this.flushWindow(current.records);
      this.tokens.revokeSandbox(current.sandbox);
    }
    this.grants.set(key, {
      sandbox,
      mode,
      session: options.session ?? null,
      space: options.space ?? null,
      tunnels: new Set(),
      records: this.freshWindow(),
      held: { count: 0 },
    });
  }

  /** Every grant this sandbox holds ends, with the tunnels it opened and its commands' tokens. */
  revoke(sandbox: string): void {
    for (const [key, grant] of this.grants)
      if (grant.sandbox === sandbox) {
        this.grants.delete(key);
        this.end(grant);
        this.flushWindow(grant.records);
      }
    this.tokens.revokeSandbox(sandbox);
  }

  /** Writes the counts that grew since they were last written. */
  flushRecords(): void {
    for (const grant of this.grants.values()) this.flushWindow(grant.records);
  }

  /** The space a granted computer belongs to, or null. */
  spaceOf(sandbox: string): string | null {
    for (const grant of this.grants.values()) if (grant.sandbox === sandbox) return grant.space;
    return null;
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
    clearInterval(this.flusher);
    this.flushRecords();
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

  private freshWindow(): RecordWindow {
    return { start: this.now(), written: 0, refusals: new Map(), suppressed: null };
  }

  private flushWindow(window: RecordWindow): void {
    for (const each of [...window.refusals.values(), window.suppressed])
      if (each && each.count > each.written) {
        each.written = each.count;
        this.options.records?.counted(each.id, each.count);
      }
  }

  /** This computer's budget for the current minute, begun again when the minute is over. */
  private window(grant: Grant): RecordWindow {
    if (this.now() - grant.records.start >= RECORD_WINDOW_MS) {
      this.flushWindow(grant.records);
      grant.records = this.freshWindow();
    }
    return grant.records;
  }

  /** Whether one more record fits this minute's budget; if not, it is counted as suppressed. */
  private admit(window: RecordWindow, session: string): boolean {
    if (window.written < (this.options.recordsPerMinute ?? DEFAULT_RECORDS_PER_MINUTE)) {
      window.written += 1;
      return true;
    }
    if (window.suppressed) {
      window.suppressed.count += 1;
      return false;
    }
    const now = new Date(this.now());
    window.suppressed = { id: randomUUID(), count: 1, written: 1 };
    this.options.records?.opened({
      id: window.suppressed.id,
      sessionId: session,
      jobId: null,
      attemptId: null,
      actionId: null,
      tokenKind: null,
      host: '',
      port: 0,
      verdict: 'suppressed',
      reason: 'over_record_budget',
      count: 1,
      openedAt: now,
      closedAt: now,
    });
    return false;
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
    return token ? hostCounters(token.hosts, host) : null;
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
    if (!session || !this.options.records) return;
    const window = this.window(grant);
    // The same refusal again this minute adds to the count on its record.
    const key = [session, token?.attribution.actionId ?? '', host, port, reason].join('\n');
    const seen = window.refusals.get(key);
    if (seen) {
      seen.count += 1;
      return;
    }
    if (!this.admit(window, session)) return;
    const id = randomUUID();
    window.refusals.set(key, { id, count: 1, written: 1 });
    const now = new Date(this.now());
    this.options.records.opened({
      id,
      sessionId: session,
      jobId: token?.attribution.jobId ?? null,
      attemptId: token?.attribution.attemptId ?? null,
      actionId: token?.attribution.actionId ?? null,
      tokenKind: token?.attribution.kind ?? null,
      host,
      port,
      verdict: 'refused',
      reason,
      count: 1,
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

  /** A terminated tunnel: counted and recorded like a blind one, with its reads and writes. */
  private async credentialed(
    client: Socket,
    head: Buffer,
    input: {
      grant: Grant;
      token: EgressTokenEntry;
      host: string;
      pinned: ResolvedAddress;
      counters: EgressHostCounters | null;
      record: string | null;
      port: EgressCredentialPort;
    },
  ) {
    const { grant, token, counters } = input;
    if (counters) counters.credentialed = true;
    let bytesUp = 0;
    let bytesDown = 0;
    let reads = 0;
    let writes = 0;
    const written: string[] = [];
    let closed = false;
    let stop: (() => void) | undefined;
    const release = () => {
      grant.tunnels.delete(release);
      token.ended.delete(release);
      stop?.();
      client.destroy();
      if (closed) return;
      closed = true;
      if (input.record)
        this.options.records?.closed(input.record, {
          bytesUp,
          bytesDown,
          closedAt: new Date(),
          reads,
          writes,
          writeActionIds: written,
        });
    };
    grant.tunnels.add(release);
    // Closed when its command settles: an account is never used past its command.
    token.ended.add(release);
    client.once('close', release);
    const idle = this.options.idleMs ?? 5 * 60_000;
    client.setTimeout(idle, release);
    client.on('data', (chunk: Buffer) => {
      bytesUp += chunk.length;
      if (counters) counters.bytesUp += chunk.length;
    });
    const write = client.write.bind(client);
    client.write = ((chunk: unknown, ...rest: unknown[]) => {
      const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : (chunk as Buffer).length;
      bytesDown += size;
      if (counters) counters.bytesDown += size;
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof client.write;
    try {
      stop = await interceptTunnel(client, head, {
        host: input.host,
        pinned: input.pinned,
        token,
        tokens: this.tokens,
        space: grant.space,
        port: input.port,
        counters,
        held: grant.held,
        onRead: () => {
          reads += 1;
          if (counters) counters.reads = (counters.reads ?? 0) + 1;
        },
        onWrite: (actionId) => {
          writes += 1;
          if (counters) counters.writes = (counters.writes ?? 0) + 1;
          if (actionId && written.length < 256) written.push(actionId);
        },
        options: { ...this.options.intercept, now: this.now },
      });
      if (closed) stop();
    } catch {
      // No leaf for this host: nothing is sent, and the computer is told so.
      if (!closed) refuse(client, 403, 'credential_unavailable');
      release();
    }
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
    // A command with a live token, at a host of an account its space connected:
    // the tunnel is terminated and each request credentialed or refused.
    let use: Awaited<ReturnType<EgressCredentialPort['find']>> = null;
    if (token && this.options.credentials) {
      try {
        use = await this.options.credentials.find({
          space: grant.space,
          attribution: token.attribution,
          host,
        });
      } catch {
        // An account that cannot be looked up is not used: the tunnel stays blind.
        use = null;
      }
      if (this.grants.get(clientAddress(client.remoteAddress)) !== grant)
        return refuse(client, 407, 'not_a_sandbox');
    }
    const record = randomUUID();
    const session = token?.attribution.sessionId ?? grant.session;
    const recorded = !!session && !!this.options.records && this.admit(this.window(grant), session);
    if (recorded && session)
      this.options.records?.opened({
        id: record,
        sessionId: session,
        jobId: token?.attribution.jobId ?? null,
        attemptId: token?.attribution.attemptId ?? null,
        actionId: token?.attribution.actionId ?? null,
        tokenKind: token?.attribution.kind ?? null,
        host,
        port,
        verdict: use ? 'credentialed' : token ? 'tunnel' : 'unattributed',
        reason: null,
        count: 1,
        openedAt: new Date(this.now()),
        ...(use ? { connectionId: use.connectionId } : {}),
      });
    if (use && token && this.options.credentials)
      return this.credentialed(client, head, {
        grant,
        token,
        host,
        pinned,
        counters,
        record: recorded ? record : null,
        port: this.options.credentials,
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
      if (recorded)
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
