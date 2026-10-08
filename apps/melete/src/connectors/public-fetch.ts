/**
 * A fetch that reaches only the addresses its caller may reach, and only the
 * ones it checked.
 *
 * The name is resolved on every request, every answer is checked, and the
 * connection is made to the checked addresses: Host and SNI still carry the
 * name, but nothing resolves it a second time. A name that answers with a
 * public address for the check and a private one for the connection has
 * nothing to answer the second time. A refusal happens before any byte is
 * sent, and no redirect is ever followed.
 *
 * There are two reaches:
 * - `public`: every answer must be globally routable (`publicPin`, the rule
 *   `web.fetch` uses). This holds every address a person other than the
 *   installation's owner names: a server, a calendar, a mailbox.
 * - `installation`: the installation owner's own settings, which may name a
 *   model or a server on this machine or their own network, so private,
 *   loopback and link-local answers are accepted.
 *
 * Cloud metadata (`isMetadataAddress`) is refused to both. An operator who
 * really runs a model there sets MELETE_ALLOW_CLOUD_METADATA=true, which opens
 * it to the `installation` reach only. Addresses from the deployment's own
 * environment and settings file are the operator's and do not pass through here.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import type { Sql } from 'postgres';
import { ConnectorFaultError } from './faults.ts';
import { isMetadataAddress, publicPin, type ResolvedAddress, resolveHost } from './web.ts';

export type PublicFetch = (url: string, init: RequestInit) => Promise<Response>;
export type PinnedRequest = (
  url: URL,
  address: ResolvedAddress,
  init: RequestInit,
) => Promise<Response>;
export type Resolve = (hostname: string) => Promise<ResolvedAddress[]>;

/** Who chose an address, and so where it may lead. See the module comment. */
export type Reach = 'public' | 'installation';

/** What a person is told when an address they named is refused. */
export const UNREACHABLE = 'This address isn’t reachable from Melete’s servers.';

/** Refused before dispatch: nothing reached the destination, so nothing may have landed. */
export const notPublic = () =>
  new ConnectorFaultError({
    kind: 'unsupported_route',
    detail: UNREACHABLE,
    may_have_committed: false,
  });

/** Whether the operator opened cloud metadata to the installation owner's settings. */
export const metadataAllowed = (env: Record<string, string | undefined> = process.env) =>
  env.MELETE_ALLOW_CLOUD_METADATA?.trim().toLowerCase() === 'true';

export type ReachOptions = {
  resolve?: Resolve;
  /** Defaults to what the operator set; see `metadataAllowed`. */
  allowMetadata?: boolean;
};

/**
 * The addresses a request may be sent to, or undefined when any answer is out
 * of reach. Public reach pins the first answer, as `publicPin` does; the
 * installation's reach keeps every answer, all of them checked, so a name that
 * answers on both IPv6 and IPv4 loopback still finds the server.
 */
export function reachPin(
  addresses: readonly ResolvedAddress[],
  reach: Reach,
  allowMetadata = metadataAllowed(),
): ResolvedAddress[] | undefined {
  if (!addresses.length) return undefined;
  if (reach === 'public') {
    const pinned = publicPin(addresses);
    return pinned ? [pinned] : undefined;
  }
  if (
    addresses.some(
      (entry) =>
        isIP(entry.address) !== entry.family ||
        (!allowMetadata && isMetadataAddress(entry.address)),
    )
  )
    return undefined;
  return [...addresses];
}

/** A host as it is checked: no brackets, no trailing dot, lower case. */
const bareHost = (hostname: string) =>
  hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();

/**
 * Every address a host may be reached at, resolved now and checked, or
 * undefined when it does not resolve or any answer is out of reach. For
 * connections that are not HTTP, such as a mailbox's IMAP and SMTP servers.
 */
export async function reachAddresses(
  host: string,
  reach: Reach,
  options: ReachOptions = {},
): Promise<ResolvedAddress[] | undefined> {
  const hostname = bareHost(host);
  const family = isIP(hostname);
  let addresses: ResolvedAddress[];
  try {
    addresses = family
      ? [{ address: hostname, family: family as 4 | 6 }]
      : await (options.resolve ?? resolveHost)(hostname);
  } catch {
    return undefined;
  }
  return reachPin(addresses, reach, options.allowMetadata ?? metadataAllowed());
}

/**
 * Whether a host resolves now to an address out of reach. A name that does not
 * resolve yet is not judged here: every connection checks it again.
 */
export async function outOfReach(
  host: string,
  reach: Reach,
  options: ReachOptions = {},
): Promise<boolean> {
  const hostname = bareHost(host);
  const family = isIP(hostname);
  let addresses: ResolvedAddress[];
  try {
    addresses = family
      ? [{ address: hostname, family: family as 4 | 6 }]
      : await (options.resolve ?? resolveHost)(hostname);
  } catch {
    return false;
  }
  return (
    addresses.length > 0 && !reachPin(addresses, reach, options.allowMetadata ?? metadataAllowed())
  );
}

async function checkedUrl(url: URL, reach: Reach, options: ReachOptions) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw notPublic();
  const pinned = await reachAddresses(url.hostname, reach, options);
  if (!pinned?.length) throw notPublic();
  return pinned;
}

/**
 * A request body as bytes on the wire. A form is encoded as `fetch` would
 * encode it; a body this transport cannot send whole is refused, never dropped.
 */
function wireBody(body: RequestInit['body']): string | Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('This request body cannot be sent to a checked address');
}

/** One HTTP(S) request to addresses already checked. It never follows a redirect. */
function send(url: URL, addresses: readonly ResolvedAddress[], init: RequestInit) {
  return new Promise<Response>((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = wireBody(init.body);
    if (init.body instanceof URLSearchParams)
      headers['content-type'] ??= 'application/x-www-form-urlencoded;charset=UTF-8';
    const first = addresses[0] as ResolvedAddress;
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: init.method ?? 'GET',
        agent: false,
        servername: isIP(hostname) ? undefined : hostname,
        lookup: (_name, options, callback) =>
          options.all
            ? callback(null, [...addresses])
            : callback(null, first.address, first.family),
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
        },
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (response) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value === undefined) continue;
          for (const entry of Array.isArray(value) ? value : [value])
            responseHeaders.append(name, entry);
        }
        const status = response.statusCode ?? 502;
        resolve(
          new Response(
            status === 204 || status === 304
              ? null
              : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
            { status, headers: responseHeaders },
          ),
        );
      },
    );
    // A refused certificate or a reset is reported by the request and again by
    // its socket; the second must land on a listener, not end the process.
    req.on('error', reject);
    req.end(body);
  });
}

/** One HTTP(S) request to an address already checked. It never follows a redirect. */
export const pinnedRequest: PinnedRequest = (url, address, init) => send(url, [address], init);

/** A fetch held to `reach`; `request` replaces the pinned transport in tests. */
export function reachFetch(
  options: ReachOptions & { reach: Reach; request?: PinnedRequest },
): PublicFetch {
  return async (input, init) => {
    const url = new URL(input);
    const pinned = await checkedUrl(url, options.reach, options);
    return options.request
      ? options.request(url, pinned[0] as ResolvedAddress, init)
      : send(url, pinned, init);
  };
}

export function publicOnlyFetch(
  options: { resolve?: Resolve; request?: PinnedRequest } = {},
): PublicFetch {
  return reachFetch({ ...options, reach: 'public' });
}

/**
 * The same check for a transport that takes a `Request`, as the model gateway's
 * does. Given `transport`, the address is checked and the request is then
 * handed to it as it is (tests pass one); otherwise it goes to the checked
 * addresses. The body is read whole first: model requests are JSON text.
 */
export function reachTransport(
  options: ReachOptions & {
    reach: Reach;
    transport?: (request: Request) => Promise<Response>;
  },
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const pinned = await checkedUrl(url, options.reach, options);
    if (options.transport) return options.transport(request);
    return send(url, pinned, {
      method: request.method,
      headers: request.headers,
      ...(request.body ? { body: await request.text() } : {}),
      signal: request.signal,
    });
  };
}

/** A `PublicFetch` in the shape of the global `fetch`, for code written against it. */
export function asFetch(reaching: PublicFetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (input instanceof Request) return reachingRequest(reaching, input, init);
    return reaching(String(input), init ?? {});
  }) as typeof fetch;
}

async function reachingRequest(reaching: PublicFetch, request: Request, init?: RequestInit) {
  return reaching(request.url, {
    method: request.method,
    headers: request.headers,
    ...(request.body ? { body: await request.text() } : {}),
    signal: request.signal,
    ...init,
  });
}

/** Whether an address can be reached, right now, under `reach`. For install-time checks. */
export async function isReachableEndpoint(
  address: string,
  reach: Reach,
  options: ReachOptions = {},
): Promise<boolean> {
  try {
    await checkedUrl(new URL(address), reach, options);
    return true;
  } catch {
    return false;
  }
}

/** Whether an address resolves, right now, to public addresses only. For install-time checks. */
export async function isPublicEndpoint(address: string, resolve: Resolve = resolveHost) {
  return isReachableEndpoint(address, 'public', { resolve });
}

/**
 * Whether a space is the setup owner's own, who runs the installation and may
 * point a server at an address inside it. A space that names no owner predates
 * accounts and is the setup owner's, and before setup there is nobody else. A
 * room the setup owner made is not their own: its requests come from everyone
 * in it, so its servers are held to public addresses like anyone else's.
 */
export async function setupOwnersSpace(sql: Sql, spaceId: string): Promise<boolean> {
  const [row] = await sql`select s.kind = 'personal'
      and (o.id is null or coalesce(s.owner_principal_id, o.id) = o.id) as setup
    from space s left join lateral (select id from owner order by created_at limit 1) o on true
    where s.id = ${spaceId}`;
  return row?.setup === true;
}

/** How far the addresses a space's connections name may reach. */
export async function spaceReach(sql: Sql, spaceId: string): Promise<Reach> {
  return (await setupOwnersSpace(sql, spaceId)) ? 'installation' : 'public';
}
