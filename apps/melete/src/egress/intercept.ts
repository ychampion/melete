/**
 * TLS termination for one tunnel to a host of a connected account.
 *
 * The relay answers the computer's CONNECT, then speaks TLS to it with a leaf
 * for that host signed by the installation's egress CA, which the computer
 * trusts. Each HTTP/1.1 request inside is checked, classified and either
 * refused, sent as a read with the account added, or brought to the broker as
 * a write. Every request is re-originated to the host's pinned public address
 * with normal certificate verification. HTTP/2 is not offered, and an
 * upgrade, a CONNECT inside the tunnel, a Host header (or, where the runtime
 * reports one, a TLS server name) other than the tunnel's host, or an absolute
 * address elsewhere are refused.
 *
 * The client's own Authorization, Proxy-* and Cookie headers never travel
 * upstream, nor does any header carrying one of the account's placeholders.
 * Answers come back through a byte redactor over every form of the secret,
 * without Alt-Svc or Set-Cookie, and uncompressed, so the secret cannot reach
 * the computer even if the service echoes it.
 *
 * The token that opened the tunnel is checked again on every request: once
 * its command has settled, the tunnel carries the account no more.
 */

import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { connect, type Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import type { JsonObject } from '@melete/contracts';
import type { EgressWriteOutcome } from '../broker/egress-admission.ts';
import type { ResolvedAddress } from '../connectors/web.ts';
import { requestWrite } from './adapters/generic.ts';
import type {
  Classification,
  ClassifiedWrite,
  InterceptedRequest,
  OutboundRequest,
  UpstreamResponse,
} from './adapters/types.ts';
import type { ForwardResult } from './connector.ts';
import type { CredentialUse, EgressCredentialPort } from './credentials.ts';
import { ByteRedactor } from './redact.ts';
import type { EgressHostCounters, EgressTokenEntry, EgressTokens } from './tokens.ts';

export const DEFAULT_HOLD_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_APPROVAL_HOLD_SECONDS = 90;
/** A held request is always answered this long before its command runs out of time. */
export const HOLD_MARGIN_MS = 10_000;
/** Requests one computer may have held for an answer at once. */
export const MAX_HELD_PER_COMPUTER = 4;

/** Where a request for a host really goes. Only a test changes it. */
export type UpstreamRoute = (
  host: string,
  pinned: ResolvedAddress,
) => { address: ResolvedAddress; port: number };

export type InterceptOptions = {
  holdMaxBytes?: number;
  /** Request-body bytes one computer may have in memory at once (default four requests' worth). */
  computerBodyBytes?: number;
  /** Request-body bytes every computer together may have in memory at once (default sixteen requests' worth). */
  globalBodyBytes?: number;
  approvalHoldSeconds?: number;
  upstream?: UpstreamRoute;
  /** Extra trust for upstream certificates; only a test fixture passes one. */
  upstreamCa?: string | string[];
  now?: () => number;
};

export type InterceptContext = {
  host: string;
  pinned: ResolvedAddress;
  token: EgressTokenEntry;
  tokens: EgressTokens;
  space: string | null;
  port: EgressCredentialPort;
  counters: EgressHostCounters | null;
  /** Shared by every tunnel of one computer. */
  held: { count: number };
  /** Request bodies in memory: this computer's, then the installation's. */
  budgets: readonly BodyBudget[];
  onRead: () => void;
  onWrite: (actionId: string | null) => void;
  options: InterceptOptions;
};

/** Headers that never travel upstream from the computer. */
const DROPPED_UP = new Set([
  'authorization',
  'cookie',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
  'host',
  'content-length',
  'accept-encoding',
  'http2-settings',
  // A method named in a header could turn an approved POST into a DELETE upstream.
  'x-http-method-override',
  'x-http-method',
  'x-method-override',
]);
/** Headers that never travel back to the computer. */
const DROPPED_DOWN = new Set([
  'alt-svc',
  'set-cookie',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
  'trailer',
  'upgrade',
]);
const DECODERS: Record<string, (input: Buffer, options: { maxOutputLength: number }) => Buffer> = {
  gzip: gunzipSync,
  'x-gzip': gunzipSync,
  deflate: inflateSync,
  br: brotliDecompressSync,
};

function flat(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers))
    if (value !== undefined)
      out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  return out;
}

/** The computer's headers, without anything that names it, its credentials or a placeholder. */
export function upstreamHeaders(
  headers: IncomingHttpHeaders,
  placeholders: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(flat(headers))) {
    if (DROPPED_UP.has(name) || name.startsWith('proxy-')) continue;
    if (placeholders.some((placeholder) => placeholder && value.includes(placeholder))) continue;
    out[name] = value;
  }
  return out;
}

function plain(
  response: ServerResponse,
  status: number,
  reason: string,
  message: string,
  extra: Record<string, string> = {},
) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = `${message}\n`;
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'x-melete-egress': reason,
    ...extra,
  });
  response.end(body);
}

/**
 * Bytes of request bodies the relay holds in memory: one computer's, and the
 * whole installation's. A body is counted as it arrives and released when its
 * request is answered.
 */
export type BodyBudget = { used: number; max: number };

/**
 * The request body, whole; or `too_large` once it passes the per-request
 * limit, or `over_budget` once the computer's or the installation's budget is
 * spent. Either way the rest is read and dropped while the answer goes back.
 */
function readBody(
  request: IncomingMessage,
  max: number,
  budgets: readonly BodyBudget[],
  reserved: { bytes: number },
): Promise<Buffer | 'too_large' | 'over_budget'> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    const stop = (why: 'too_large' | 'over_budget') => {
      over = true;
      chunks.length = 0;
      resolve(why);
    };
    request.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > max) return stop('too_large');
      if (budgets.some((budget) => budget.used + chunk.length > budget.max))
        return stop('over_budget');
      for (const budget of budgets) budget.used += chunk.length;
      reserved.bytes += chunk.length;
      chunks.push(chunk);
    });
    request.once('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    request.once('error', () => {
      if (!over) stop('too_large');
    });
  });
}

/**
 * Headers that carry nothing about what a request does, sent as they come
 * and left out of what a person approves. Every other forwarded header is
 * bound into a write's approval.
 */
export const VOLATILE_HEADERS: ReadonlySet<string> = new Set([
  'user-agent',
  'traceparent',
  'tracestate',
  'x-request-id',
  'date',
]);

/**
 * What a write's approval is bound to besides the adapter's own payload: the
 * exact body bytes (or, where the adapter's payload already names what the
 * body does by content, the part of the body it names as `bound`), and every
 * header that will be forwarded, by lower-case name and value in name order.
 */
export function requestBinding(headers: Record<string, string>, body: Buffer, bound?: JsonObject) {
  return {
    headers: Object.entries(headers)
      .filter(([name]) => !VOLATILE_HEADERS.has(name))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => [name, value]),
    ...(bound
      ? { body: bound }
      : {
          body_sha256: createHash('sha256').update(body).digest('hex'),
          body_bytes: body.length,
        }),
  };
}

/** The path and query a request names, when it names this tunnel's host; otherwise null. */
export function requestTarget(url: string, host: string): { path: string; query: string } | null {
  let target = url;
  if (!target.startsWith('/')) {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return null;
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname.toLowerCase() !== host ||
      (parsed.port && parsed.port !== '443') ||
      parsed.username ||
      parsed.password
    )
      return null;
    target = `${parsed.pathname}${parsed.search}`;
  }
  if (target.startsWith('//')) return null;
  const mark = target.indexOf('?');
  return mark < 0
    ? { path: target, query: '' }
    : { path: target.slice(0, mark), query: target.slice(mark + 1) };
}

/** Whether a Host header names exactly this tunnel's host (with or without :443). */
export function hostMatches(header: string | undefined, host: string): boolean {
  const value = (header ?? '').trim().toLowerCase();
  return value === host || value === `${host}:443`;
}

function classifySafely(use: CredentialUse, request: InterceptedRequest): Classification {
  try {
    return use.adapter.classify(request, use.config);
  } catch {
    // What an adapter cannot read is a write: it asks first.
    return requestWrite(request);
  }
}

/** Sends one request upstream to the pinned address, verifying the host's certificate. */
function send(
  context: InterceptContext,
  outbound: OutboundRequest,
  onResponse: (upstream: IncomingMessage) => void,
  onError: (error: Error, connected: boolean) => void,
) {
  const route = context.options.upstream?.(context.host, context.pinned) ?? {
    address: context.pinned,
    port: 443,
  };
  let connected = false;
  const request = httpsRequest(
    {
      host: context.host,
      port: route.port,
      method: outbound.method,
      path: outbound.target,
      servername: context.host,
      agent: false,
      ...(context.options.upstreamCa ? { ca: context.options.upstreamCa } : {}),
      lookup: (_name, options, callback) =>
        (options as { all?: boolean }).all
          ? (callback as (error: null, addresses: ResolvedAddress[]) => void)(null, [route.address])
          : (callback as (error: null, address: string, family: number) => void)(
              null,
              route.address.address,
              route.address.family,
            ),
      headers: {
        ...outbound.headers,
        host: context.host,
        'accept-encoding': 'identity',
        'content-length': String(outbound.body.length),
      },
    },
    onResponse,
  );
  request.once('socket', (socket) => {
    socket.once('secureConnect', () => {
      connected = true;
    });
  });
  request.on('error', (error) => onError(error, connected));
  request.setTimeout(10 * 60_000, () => request.destroy(new Error('the service did not answer')));
  request.end(outbound.body);
}

function downstreamHeaders(
  headers: IncomingHttpHeaders,
  redactor: ByteRedactor,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(flat(headers))) {
    if (DROPPED_DOWN.has(name) || name.startsWith('proxy-')) continue;
    out[name] = redactor.text(value);
  }
  return out;
}

const encodingOf = (headers: IncomingHttpHeaders) =>
  String(headers['content-encoding'] ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part && part !== 'identity');

/** A whole answer, decoded if the service compressed it anyway, and redacted. */
function collect(
  upstream: IncomingMessage,
  redactor: ByteRedactor,
  max: number,
): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    upstream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        upstream.destroy(new Error('the answer is larger than the relay holds'));
        return;
      }
      chunks.push(chunk);
    });
    upstream.once('error', reject);
    upstream.once('end', () => {
      try {
        let body: Buffer = Buffer.concat(chunks);
        for (const encoding of encodingOf(upstream.headers).reverse()) {
          const decode = DECODERS[encoding];
          if (!decode) throw new Error(`an answer encoded as ${encoding} cannot be checked`);
          body = decode(body, { maxOutputLength: max });
        }
        resolve({
          status: upstream.statusCode ?? 502,
          headers: downstreamHeaders(upstream.headers, redactor),
          body: Buffer.concat([redactor.feed(body), redactor.end()]),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** A read: sent with the account, its answer streamed back through the redactor. */
async function read(
  context: InterceptContext,
  use: CredentialUse,
  base: OutboundRequest,
  response: ServerResponse,
  max: number,
) {
  await use.withSecret(
    (secret) =>
      new Promise<void>((resolve) => {
        const outbound = use.adapter.authorize(base, secret, use.config);
        const redactor = new ByteRedactor(use.adapter.redactions(secret));
        send(
          context,
          outbound,
          (upstream) => {
            context.onRead();
            if (encodingOf(upstream.headers).length) {
              // Compressed despite being asked not to: decoded whole, so the redactor sees it.
              void collect(upstream, redactor, max).then(
                (whole) => {
                  response.writeHead(whole.status, whole.headers);
                  response.end(whole.body);
                  resolve();
                },
                () => {
                  plain(
                    response,
                    502,
                    'unreadable_answer',
                    'The answer could not be checked for the account secret, so it was not passed on.',
                  );
                  resolve();
                },
              );
              return;
            }
            response.writeHead(
              upstream.statusCode ?? 502,
              downstreamHeaders(upstream.headers, redactor),
            );
            upstream.on('data', (chunk: Buffer) => {
              const safe = redactor.feed(chunk);
              if (safe.length) response.write(safe);
            });
            upstream.once('end', () => {
              response.end(redactor.end());
              resolve();
            });
            upstream.once('error', () => {
              response.destroy();
              resolve();
            });
          },
          () => {
            plain(response, 502, 'upstream_unreachable', `${context.host} could not be reached.`);
            resolve();
          },
        );
      }),
  );
}

/** Forwards a write once its admission allows it; the whole answer is kept for the receipt. */
function forwarder(
  context: InterceptContext,
  use: CredentialUse,
  base: OutboundRequest,
  write: ClassifiedWrite,
  max: number,
): () => Promise<ForwardResult> {
  let started = false;
  const attempt = () =>
    use.withSecret(
      (secret) =>
        new Promise<ForwardResult>((resolve) => {
          const outbound = use.adapter.authorize(base, secret, use.config);
          const redactor = new ByteRedactor(use.adapter.redactions(secret));
          started = true;
          send(
            context,
            outbound,
            (upstream) => {
              void collect(upstream, redactor, max).then(
                (response) =>
                  resolve({
                    outcome: 'answered',
                    response,
                    rejected: use.adapter.rejected?.(write, response) ?? null,
                    detail: {
                      host: context.host,
                      method: base.method,
                      target: redactor.text(base.target).slice(0, 2000),
                      status: response.status,
                      operation: write.operation,
                      ...use.adapter.receipt(write, response),
                    },
                  }),
                (error: Error) => resolve({ outcome: 'lost', reason: error.message }),
              );
            },
            (error, connected) =>
              resolve(
                connected
                  ? { outcome: 'lost', reason: `the answer was lost: ${error.message}` }
                  : { outcome: 'not_sent', reason: `${context.host} could not be reached` },
              ),
          );
        }),
    );
  // A failure before anything was sent (the secret could not be opened, the
  // request could not be signed) is not a send whose answer was lost.
  return () =>
    attempt().catch(
      (error: unknown): ForwardResult =>
        started
          ? { outcome: 'lost', reason: String((error as Error)?.message ?? error) }
          : { outcome: 'not_sent', reason: 'the account could not be used for this request' },
    );
}

function answer(
  response: ServerResponse,
  outcome: EgressWriteOutcome,
  held?: (message: string, status: number) => UpstreamResponse | null,
) {
  if (outcome.kind === 'sent') {
    const result = outcome.result;
    if (result.outcome === 'answered') {
      response.writeHead(result.response.status, {
        ...result.response.headers,
        'content-length': String(result.response.body.length),
      });
      response.end(result.response.body);
      return;
    }
    if (result.outcome === 'lost')
      return plain(
        response,
        502,
        'answer_lost',
        'This change was sent, and its answer was lost. Melete will not send it again; check the destination.',
        { 'x-melete-approval': outcome.actionId },
      );
    return plain(response, 502, 'upstream_unreachable', `${result.reason}. Nothing was sent.`, {
      'x-melete-approval': outcome.actionId,
    });
  }
  const reason = outcome.kind === 'waiting' ? 'approval_pending' : 'write_refused';
  const status = outcome.kind === 'waiting' ? 403 : outcome.status;
  // In the words the service's own clients print, where the adapter knows them.
  const shaped = held?.(outcome.message, status);
  if (shaped && !response.headersSent) {
    response.writeHead(shaped.status, {
      ...shaped.headers,
      'content-length': String(shaped.body.length),
      'x-melete-egress': reason,
      ...(outcome.actionId ? { 'x-melete-approval': outcome.actionId } : {}),
    });
    response.end(shaped.body);
    return;
  }
  return plain(
    response,
    status,
    reason,
    outcome.message,
    outcome.actionId ? { 'x-melete-approval': outcome.actionId } : {},
  );
}

/** One request inside the tunnel. */
async function handle(
  context: InterceptContext,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const host = context.host;
  const max = context.options.holdMaxBytes ?? DEFAULT_HOLD_MAX_BYTES;
  // Where the runtime reports the TLS server name it must be this host. Where
  // it does not, the leaf names only this host, so a client that checks
  // certificates cannot have asked for another, and the Host header below
  // must name it either way.
  const servername = (request.socket as TLSSocket).servername;
  if (servername && servername !== host)
    return plain(response, 421, 'host_mismatch', 'This connection was opened for another host.');
  if (!context.tokens.isLive(context.token)) {
    response.shouldKeepAlive = false;
    return plain(
      response,
      403,
      'command_ended',
      'The command that opened this connection has ended, so its account is not used any more.',
    );
  }
  if (request.method === 'CONNECT' || request.headers.upgrade)
    return plain(
      response,
      403,
      'upgrade_refused',
      'Upgrades and tunnels inside a tunnel are refused.',
    );
  if (!hostMatches(request.headers.host, host))
    return plain(response, 403, 'host_mismatch', 'The Host header must name the tunnel’s host.');
  const target = requestTarget(request.url ?? '', host);
  if (!target)
    return plain(
      response,
      403,
      'destination_denied',
      'A request may only name this tunnel’s host.',
    );
  const method = (request.method ?? 'GET').toUpperCase();
  // A request that may be a change takes its place among the held ones before
  // its body is read, so a computer cannot buffer more than its share.
  const mayWrite = method !== 'GET' && method !== 'HEAD';
  if (mayWrite && context.held.count >= MAX_HELD_PER_COMPUTER) {
    response.shouldKeepAlive = false;
    return plain(
      response,
      429,
      'too_many_held',
      'Too many changes from this computer are already waiting for an answer. Try again shortly.',
    );
  }
  if (mayWrite) context.held.count += 1;
  const reserved = { bytes: 0 };
  try {
    await handleBody(context, request, response, { method, target, max, reserved });
  } finally {
    if (mayWrite) context.held.count -= 1;
    for (const budget of context.budgets) budget.used -= reserved.bytes;
  }
}

async function handleBody(
  context: InterceptContext,
  request: IncomingMessage,
  response: ServerResponse,
  input: {
    method: string;
    target: { path: string; query: string };
    max: number;
    reserved: { bytes: number };
  },
) {
  const { host } = context;
  const { method, target, max } = input;
  const body = await readBody(request, max, context.budgets, input.reserved);
  if (body === 'too_large' || body === 'over_budget') {
    response.shouldKeepAlive = false;
    return body === 'too_large'
      ? plain(
          response,
          413,
          'too_large',
          `This request is larger than the ${Math.floor(max / (1024 * 1024))} MiB the relay holds for an approval, so it was not sent.`,
        )
      : plain(
          response,
          429,
          'too_much_held',
          'Too much from this computer is waiting to be sent. Nothing was sent; try again shortly.',
        );
  }
  const use = await context.port
    .find({ space: context.space, attribution: context.token.attribution, host })
    .catch(() => null);
  if (!use)
    return plain(
      response,
      403,
      'account_unavailable',
      'This account is no longer available to this command.',
    );
  const placeholders =
    use.adapter.standIns?.(use.config) ?? Object.values(use.adapter.placeholders(use.config));
  const intercepted: InterceptedRequest = {
    host,
    method,
    path: target.path,
    query: target.query,
    headers: upstreamHeaders(request.headers, placeholders),
    body,
  };
  const base: OutboundRequest = {
    host,
    method,
    target: `${target.path}${target.query ? `?${target.query}` : ''}`,
    headers: intercepted.headers,
    body,
  };
  const verdict = classifySafely(use, intercepted);
  if (verdict.kind === 'refuse') return plain(response, 403, 'refused', verdict.reason);
  if (verdict.kind === 'read') return read(context, use, base, response, max);
  // The approval binds the exact bytes and every header that will be sent;
  // the write forwards exactly those, plus headers that say nothing about it.
  const binding = requestBinding(intercepted.headers, body, verdict.boundBody);
  const write: ClassifiedWrite = {
    ...verdict,
    payload: { ...verdict.payload, request: binding },
    summary: {
      ...verdict.summary,
      facts: [
        ...verdict.summary.facts,
        ...(binding.headers.length
          ? [
              {
                label: 'Headers',
                value: binding.headers.map(([name, value]) => `${name}: ${value}`).join('\n'),
              },
            ]
          : []),
      ],
    },
  };
  const bound: OutboundRequest = {
    ...base,
    headers: Object.fromEntries([
      ...binding.headers.map(([name, value]) => [name as string, value as string]),
      ...Object.entries(intercepted.headers).filter(([name]) => VOLATILE_HEADERS.has(name)),
    ]),
  };
  const now = context.options.now?.() ?? Date.now();
  const holdSeconds = context.options.approvalHoldSeconds ?? DEFAULT_APPROVAL_HOLD_SECONDS;
  const deadline = context.token.attribution.deadlineAt;
  const holdMs = Math.max(
    0,
    Math.min(
      holdSeconds * 1000,
      deadline === undefined ? Infinity : deadline - now - HOLD_MARGIN_MS,
    ),
  );
  const aborted = new AbortController();
  const hungUp = () => aborted.abort();
  response.once('close', hungUp);
  try {
    const outcome = await context.port.admitWrite({
      attribution: context.token.attribution,
      connectionId: use.connectionId,
      adapter: use.adapter.id,
      write,
      holdMs,
      forward: forwarder(context, use, bound, write, max),
      signal: aborted.signal,
      live: () => context.tokens.isLive(context.token),
    });
    if (outcome.kind === 'sent') context.onWrite(outcome.actionId);
    answer(response, outcome, (message, status) => {
      try {
        return use.adapter.heldAnswer?.(intercepted, write, message, status) ?? null;
      } catch {
        return null;
      }
    });
  } finally {
    response.off('close', hungUp);
  }
}

/**
 * Takes over a CONNECT for a credentialed host: TLS with a leaf for it, then
 * each request handled as above. Answers how to close it.
 */
export async function interceptTunnel(
  client: Socket,
  head: Buffer,
  context: InterceptContext,
): Promise<() => void> {
  const leaf = await context.port.ca.leaf(context.host);
  // Bun has no way to hand an accepted socket to a TLS server, so a loopback
  // listener for this tunnel alone gives it a real TLS stack and HTTP parser.
  const secured = createHttpsServer(
    { key: leaf.key, cert: leaf.cert, ALPNProtocols: ['http/1.1'], minVersion: 'TLSv1.2' },
    (request, response) => {
      void handle(context, request, response).catch(() =>
        plain(response, 502, 'relay_failed', 'The relay could not handle this request.'),
      );
    },
  );
  // An upgrade or a tunnel inside the tunnel is answered, in plain words, and never followed.
  const refused = 'Upgrades and tunnels inside a tunnel are refused.\n';
  const refuseRaw = (socket: Socket) =>
    socket.end(
      [
        'HTTP/1.1 403 Forbidden',
        'Connection: close',
        'Content-Type: text/plain; charset=utf-8',
        'X-Melete-Egress: upgrade_refused',
        `Content-Length: ${Buffer.byteLength(refused)}`,
        '',
        refused,
      ].join('\r\n'),
    );
  secured.on('upgrade', (_request, socket: Socket) => refuseRaw(socket));
  secured.on('connect', (_request, socket: Socket) => refuseRaw(socket));
  secured.maxConnections = 1;
  secured.headersTimeout = 30_000;
  secured.requestTimeout = 0;
  secured.on('tlsClientError', () => client.destroy());
  await new Promise<void>((resolve, reject) => {
    secured.once('error', reject);
    secured.listen(0, '127.0.0.1', resolve);
  });
  const address = secured.address();
  if (!address || typeof address === 'string') {
    secured.close();
    throw new Error('the relay could not listen for this tunnel');
  }
  const bridge = connect(address.port, '127.0.0.1');
  const close = () => {
    bridge.destroy();
    client.destroy();
    secured.closeAllConnections();
    secured.close();
  };
  client.once('close', close);
  bridge.once('error', close);
  bridge.once('close', close);
  bridge.once('connect', () => {
    if (client.destroyed) return close();
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) bridge.write(head);
    client.pipe(bridge).pipe(client);
  });
  return close;
}
