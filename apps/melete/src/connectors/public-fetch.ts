/**
 * A fetch that reaches public addresses only, and only the one it checked.
 *
 * The name is resolved on every request, every answer must be globally
 * routable (`publicPin`, the rule `web.fetch` uses), and the connection is made
 * to that checked address: Host and SNI still carry the name, but nothing
 * resolves it a second time. A name that answers with a public address for the
 * check and a private one for the connection has nothing to answer the second
 * time. A refusal happens before any byte is sent.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { ConnectorFaultError } from './faults.ts';
import { publicPin, type ResolvedAddress, resolveHost } from './web.ts';

export type PublicFetch = (url: string, init: RequestInit) => Promise<Response>;
export type PinnedRequest = (
  url: URL,
  address: ResolvedAddress,
  init: RequestInit,
) => Promise<Response>;

/** Refused before dispatch: nothing reached the destination, so nothing may have landed. */
export const notPublic = () =>
  new ConnectorFaultError({
    kind: 'unsupported_route',
    detail: 'This endpoint is not a public address',
    may_have_committed: false,
  });

/** One HTTP(S) request to an address already checked. It never follows a redirect. */
export const pinnedRequest: PinnedRequest = (url, address, init) =>
  new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === 'string' ? init.body : undefined;
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: init.method ?? 'GET',
        agent: false,
        servername: isIP(hostname) ? undefined : hostname,
        lookup: (_name, options, callback) =>
          options.all ? callback(null, [address]) : callback(null, address.address, address.family),
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

export function publicOnlyFetch(
  options: {
    resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
    request?: PinnedRequest;
  } = {},
): PublicFetch {
  const resolve = options.resolve ?? resolveHost;
  const request = options.request ?? pinnedRequest;
  return async (input, init) => {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw notPublic();
    const hostname = url.hostname
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
      .toLowerCase();
    const family = isIP(hostname);
    let addresses: ResolvedAddress[];
    try {
      addresses = family
        ? [{ address: hostname, family: family as 4 | 6 }]
        : await resolve(hostname);
    } catch {
      throw notPublic();
    }
    const pinned = publicPin(addresses);
    if (!pinned) throw notPublic();
    return request(url, pinned, init);
  };
}

/** Whether an address resolves, right now, to public addresses only. For install-time checks. */
export async function isPublicEndpoint(
  address: string,
  resolve: (hostname: string) => Promise<ResolvedAddress[]> = resolveHost,
): Promise<boolean> {
  try {
    await publicOnlyFetch({ resolve, request: async () => new Response(null) })(address, {});
    return true;
  } catch {
    return false;
  }
}
