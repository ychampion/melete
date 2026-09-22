/**
 * Serves the reference client's built bundle and its same-origin API proxy.
 *
 * A file server instead of a dependency, because a self-hosted client that has
 * to reach a package registry before it can start is not self-hosted. Unknown
 * paths fall back to index.html: the client routes on the hash, but a deep link
 * that arrives as a path should still load the app rather than 404.
 *
 * The static file boundary is one pure function with its own
 * tests. It works on filesystem paths throughout and never builds a `file:` URL
 * from a request, because a URL resolved against a base will happily leave the
 * base: `file:///etc/passwd` is not a path under `dist`, it is a different
 * absolute URL, and `%2e%2e` is a dot segment the URL parser climbs with.
 */
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import {
  plainAddress,
  type TrustedPeer,
  trustedPeer,
} from '../../apps/melete/src/api/trusted-peer.ts';

export type StaticServerOptions = {
  /** The directory to serve. Nothing outside it is ever readable. */
  root: string;
  port?: number;
  hostname?: string;
  /** Trusted startup configuration, never derived from a request. */
  apiOrigin?: string;
  /** External HTTPS origin when TLS terminates before this server. */
  publicOrigin?: string;
  /**
   * The one upstream whose `X-Forwarded-For` states a browser's address: a
   * literal address, or a service name on a shared network. Unset, as in the
   * default loopback deployment, every request is attributed to its own socket
   * peer and no forwarding header is read.
   */
  trustedUpstream?: string;
};

const API_ORIGIN = 'http://melete:8787';

/**
 * Tells the API which browser a proxied request came from, so its login limits
 * do not treat every browser as this one server. The value is this server's own
 * socket peer, or the address its configured upstream stated, and it replaces
 * whatever the browser sent. The API believes it only on a connection from the
 * proxy it was told to trust.
 */
export const CLIENT_ADDRESS_HEADER = 'x-melete-client-address';

/**
 * Identity headers a Tailscale node writes on a request it proxies. They are
 * not a sign-in here: password and device cookie remain the sign-in, and the
 * API reads none of these. They are stripped from every request, whatever
 * socket it arrived on, so nothing behind this server can mistake one for a
 * claim the installation has checked.
 *
 * Arriving from the trusted upstream is not evidence that the upstream wrote
 * them. Serve rewrites the fixed set of names it owns and passes every other
 * `Tailscale-` header on as the browser sent it, so a browser chooses the
 * rest. The whole prefix goes rather than the names that happen to be
 * rewritten today.
 */
const IDENTITY_HEADER_PREFIX = 'tailscale-';

/**
 * The browser address an upstream states, or null.
 *
 * Tailscale Serve sets `X-Forwarded-For` to the tailnet peer it accepted the
 * connection from, replacing whatever the browser sent, so the header holds
 * exactly one address. A list means some other hop is appending, which is a
 * deployment this server has not been told how to read: it states no address
 * rather than guessing which entry is the browser. Tailnet addresses are in
 * the 100.64.0.0/10 range or an IPv6 unique local prefix, and need no special
 * case: one well-formed address is one well-formed address.
 */
export function forwardedAddress(header: string | null): string | null {
  if (header === null || header.includes(',')) return null;
  return plainAddress(header);
}

/** `setting` names where the value came from, so a refusal says what to change. */
function parseOrigin(value: string, setting: string): string {
  const refused = new Error(
    `${setting} must be an http:// or https:// origin without a path or credentials, for example https://assistant.example.net.`,
  );
  if (!URL.canParse(value)) throw refused;
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw refused;
  }
  return url.origin;
}

/** Connection metadata belongs to one connection, not the next peer. */
function endToEndHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  const connectionHeaders = (headers.get('connection') ?? '').split(',');
  for (const name of [
    ...connectionHeaders,
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]) {
    if (name.trim()) headers.delete(name.trim());
  }
  return headers;
}

async function proxyApi(
  request: Request,
  url: URL,
  apiOrigin: string,
  publicOrigin: string | undefined,
  peer: string | undefined,
  upstream: TrustedPeer,
) {
  const origin = request.headers.get('origin');
  if (
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (origin !== null && origin !== (publicOrigin ?? url.origin))
  ) {
    return Response.json(
      { error: { code: 'origin_rejected', message: 'Use the same origin.' } },
      { status: 403, headers: { 'cache-control': 'no-store' } },
    );
  }

  // Set only the path and query. Resolving a caller path against the origin
  // would let a leading // choose another host and expose the session cookie.
  const target = new URL(apiOrigin);
  target.pathname = url.pathname.slice('/api'.length) || '/';
  target.search = url.search;

  // One question about the socket, asked before the forwarding headers are
  // dropped: is this connection from the upstream the deployment named? Only
  // then does its X-Forwarded-For state the browser's address.
  const stated = forwardedAddress(request.headers.get('x-forwarded-for'));
  const clientAddress =
    stated !== null && peer !== undefined && (await upstream(peer)) ? stated : peer;

  const headers = endToEndHeaders(request.headers);
  for (const name of [...headers.keys()]) {
    if (
      name === 'host' ||
      name === 'forwarded' ||
      name.startsWith('x-forwarded-') ||
      name.startsWith(IDENTITY_HEADER_PREFIX)
    ) {
      headers.delete(name);
    }
  }
  // The browser origin has been checked here. The API checks the internal
  // origin on the new connection and retains its own direct-request defense.
  if (origin !== null) headers.set('origin', apiOrigin);
  // Socket metadata, or the one address the trusted upstream stated. Either
  // way a browser cannot choose the address it is limited by.
  headers.delete(CLIENT_ADDRESS_HEADER);
  if (clientAddress) headers.set(CLIENT_ADDRESS_HEADER, clientAddress);

  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      signal: request.signal,
      redirect: 'manual',
      decompress: false,
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: endToEndHeaders(response.headers),
    });
  } catch {
    return Response.json(
      { error: { code: 'api_unavailable', message: 'The API is unavailable.' } },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }
}

/**
 * Turn a request path into an absolute path inside `root`, or null if it does
 * not belong to one. Null means 404: the caller must not fall back to reading
 * something else, because "not a path under dist" is the whole answer.
 */
export function resolveInside(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed percent sequence is not a path anyone can reason about.
    return null;
  }

  // A NUL truncates a path in some system calls, so a name that carries one
  // means something different to the kernel than it does here.
  if (decoded.includes('\0')) return null;

  // A backslash is a separator on Windows and a colon opens both a drive letter
  // and a URL scheme. Neither can appear in a file Vite emitted, and both are
  // how a path stops meaning what it looks like.
  if (decoded.includes('\\') || decoded.includes(':')) return null;

  // Leading slashes are stripped so the remainder is always resolved as
  // relative; `resolve(root, '/etc/passwd')` would otherwise return the
  // absolute path it was handed.
  const relative = decoded.replace(/^\/+/, '');
  const target = resolve(root, relative);

  // The containment check is what actually holds, and it is a prefix ending at
  // a separator: a plain `startsWith` would accept `dist-backup` for `dist`.
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    // Missing, or a path component that is not a directory. Either way, no file.
    return false;
  }
};

export function createStaticServer(options: StaticServerOptions) {
  const root = resolve(options.root);
  const indexPath = resolve(root, 'index.html');
  const apiOrigin = parseOrigin(options.apiOrigin ?? API_ORIGIN, 'The API origin');
  const publicOrigin = options.publicOrigin
    ? parseOrigin(options.publicOrigin, 'MELETE_WEB_ORIGIN')
    : undefined;
  const upstream = trustedPeer(options.trustedUpstream);

  const index = () =>
    new Response(Bun.file(indexPath), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

  return Bun.serve({
    port: options.port ?? Number(process.env.PORT ?? 3000),
    ...(options.hostname ? { hostname: options.hostname } : {}),
    idleTimeout: 60,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        // A job event stream can be quiet for longer than the static timeout.
        server.timeout(request, 0);
        return proxyApi(
          request,
          url,
          apiOrigin,
          publicOrigin,
          server.requestIP(request)?.address,
          upstream,
        );
      }

      // A built bundle is read only, so reading it is the whole vocabulary.
      // Anything else is 405 rather than 404: the path may well exist, the verb
      // is what does not, and answering a POST with the index would report a 200
      // for a write that never happened. A 405 has to say what it does allow.
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed\n', {
          status: 405,
          headers: { allow: 'GET, HEAD' },
        });
      }

      const { pathname } = url;
      const target = resolveInside(root, pathname);

      // Malformed, or pointing outside the bundle. Not a deep link.
      if (target === null) return new Response('Not found\n', { status: 404 });

      if (target !== root && (await isFile(target))) {
        return new Response(Bun.file(target));
      }

      // Structurally fine with no file behind it: the client's own routing.
      return index();
    },
  });
}

if (import.meta.main) {
  const server = createStaticServer({
    root: resolve(process.cwd(), 'dist'),
    publicOrigin: process.env.MELETE_WEB_ORIGIN || undefined,
    trustedUpstream: process.env.MELETE_WEB_TRUSTED_UPSTREAM || undefined,
  });
  process.stdout.write(`melete web client listening on :${server.port}\n`);
}
