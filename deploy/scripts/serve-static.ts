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
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import type { ServerWebSocket } from 'bun';
import {
  plainAddress,
  type TrustedPeer,
  trustedPeer,
} from '../../apps/melete/src/api/trusted-peer.ts';
import {
  CALL_UPSTREAM_PATH,
  SPEECH_ENGINE_AUTH_HEADER,
} from '../../apps/melete/src/call/upstream-path.ts';
import { PREVIEW_PREFIX } from '../../apps/melete/src/sandbox/preview-path.ts';
import { isIsolated, VIEW_PREFIX } from '../../apps/melete/src/viewer/headers.ts';
import { displayName } from '../../packages/contracts/src/instance-name.ts';

export type StaticServerOptions = {
  /** The directory to serve. Nothing outside it is ever readable. */
  root: string;
  /**
   * The installation's brand folder (`MELETE_WEB_BRAND_DIR`), read before
   * `root` for the files BRAND_FILE allows and nothing else.
   */
  brandDir?: string;
  /** What the installation calls itself (`MELETE_INSTANCE_NAME`): the page title. */
  instanceName?: string;
  port?: number;
  hostname?: string;
  /** Trusted startup configuration, never derived from a request. */
  apiOrigin?: string;
  /** External HTTPS origin when TLS terminates before this server. */
  publicOrigin?: string;
  /**
   * The one upstream whose `X-Forwarded-For` states a browser's address: a
   * literal address, a service name on a shared network, or `gateway` for a
   * reverse proxy on the Docker host. Unset, as in the default loopback
   * deployment, every request is attributed to its own socket peer and no
   * forwarding header is read.
   */
  trustedUpstream?: string;
  /** Reads the container's routing table; a test supplies its own. */
  routeTable?: () => Promise<string>;
};

/**
 * The upstream named for a reverse proxy on the Docker host. A connection that
 * reaches a published port from the host arrives from the container's default
 * gateway, whose address Docker chooses, so it is read from the routing table
 * rather than written into the configuration.
 */
export const HOST_GATEWAY = 'gateway';

/**
 * The default route's gateway in a Linux routing table (`/proc/net/route`),
 * whose addresses are little-endian hex, or null when there is none.
 */
export function defaultGateway(table: string): string | null {
  for (const line of table.split('\n').slice(1)) {
    const [, destination, gateway] = line.trim().split(/\s+/);
    if (destination !== '00000000' || !gateway || !/^[0-9A-Fa-f]{8}$/.test(gateway)) continue;
    const octets = [6, 4, 2, 0].map((at) => Number.parseInt(gateway.slice(at, at + 2), 16));
    const address = octets.join('.');
    return address === '0.0.0.0' ? null : address;
  }
  return null;
}

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
 * Tells the API the origin the browser opened Melete at: the configured
 * `MELETE_WEB_ORIGIN`, or this request's own when it is plain http on this
 * machine (an SSH tunnel, or a browser on the server). A sign-in to a connected app
 * returns the browser there when the service has no public address of its
 * own. It replaces whatever the browser sent, and the API believes it only on
 * a connection from the proxy it was told to trust.
 */
export const WEB_ORIGIN_HEADER = 'x-melete-web-origin';

/** A plain http:// address on this machine, as a browser opening this server directly has. */
export function loopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/**
 * Where an app's or account's sign-in sends the browser back. That return is
 * a top-level navigation from the app's own site, so it arrives marked
 * cross-site; it carries a one-time code and a state only the sign-in that
 * started it can spend, so it is let through as a page load and nothing else.
 */
export function signInReturn(request: Request, pathname: string): boolean {
  return (
    request.method === 'GET' &&
    request.headers.get('sec-fetch-mode') === 'navigate' &&
    // A top-level page load only: a frame on another site navigates too.
    request.headers.get('sec-fetch-dest') === 'document' &&
    /^\/api\/oauth\/(?:[a-z]+\/)?callback$/.test(pathname)
  );
}

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

/**
 * The OAuth discovery documents for the API's MCP endpoint. RFC 8414 and RFC
 * 9728 place them at the root of the public origin, not under `/api`, so they
 * are forwarded to the API with their paths unchanged.
 */
export function discoveryPath(pathname: string): boolean {
  return (
    pathname === '/.well-known/oauth-authorization-server' ||
    pathname === '/.well-known/oauth-protected-resource' ||
    pathname === '/.well-known/oauth-protected-resource/api/mcp'
  );
}

/**
 * Headers on every page and file of the client itself. Only Melete may frame
 * Melete, which keeps another site from laying its own controls over it; and
 * a frame Melete draws loads only from Melete, wherever the page inside it
 * tries to go next.
 */
export const CLIENT_FRAME_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': "frame-ancestors 'self'; frame-src 'self'",
  'x-frame-options': 'SAMEORIGIN',
});

/**
 * The proxied path of a published app's file, or of a preview of a server in
 * an agent's computer: each is loaded by a sandboxed page with a token, and
 * leaves only with the isolation headers.
 */
export function appViewPath(method: string, pathname: string): boolean {
  return (
    (method === 'GET' || method === 'HEAD') &&
    (pathname.startsWith(`/api${VIEW_PREFIX}`) || pathname.startsWith(`/api${PREVIEW_PREFIX}`))
  );
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
  // An app's page has an opaque origin, so its own file requests arrive marked
  // cross-site, some with `Origin: null`. They only read, carry a token rather
  // than a session, and leave without the session cookie (below).
  const view = appViewPath(request.method, url.pathname);
  if (
    !view &&
    !signInReturn(request, url.pathname) &&
    (request.headers.get('sec-fetch-site') === 'cross-site' ||
      (origin !== null && origin !== (publicOrigin ?? url.origin)))
  ) {
    return Response.json(
      { error: { code: 'origin_rejected', message: 'Use the same origin.' } },
      { status: 403, headers: { 'cache-control': 'no-store' } },
    );
  }

  // Set only the path and query. Resolving a caller path against the origin
  // would let a leading // choose another host and expose the session cookie.
  const target = new URL(apiOrigin);
  target.pathname = discoveryPath(url.pathname)
    ? url.pathname
    : url.pathname.slice('/api'.length) || '/';
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
  // An app's file is the token's to authorise. The session never travels with it.
  if (view) {
    headers.delete('cookie');
    headers.delete('authorization');
    headers.delete('origin');
  }
  // Socket metadata, or the one address the trusted upstream stated. Either
  // way a browser cannot choose the address it is limited by.
  headers.delete(CLIENT_ADDRESS_HEADER);
  if (clientAddress) headers.set(CLIENT_ADDRESS_HEADER, clientAddress);
  // Without a configured origin, only a plain http:// address on this machine
  // can be the browser's own: this server speaks plain HTTP, so anything else
  // came from a request target or Host the client wrote, and is not passed on.
  const browserOrigin = publicOrigin ?? (loopbackHttp(url) ? url.origin : undefined);
  headers.delete(WEB_ORIGIN_HEADER);
  if (browserOrigin) headers.set(WEB_ORIGIN_HEADER, browserOrigin);

  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      signal: request.signal,
      redirect: 'manual',
      decompress: false,
    });
    const answered = endToEndHeaders(response.headers);
    if (view) {
      answered.delete('set-cookie');
      // The page runs only with the isolation the API sets on it. Should that
      // ever be missing, nothing of the answer is passed on.
      if (!isIsolated(answered)) {
        await response.body?.cancel();
        return new Response('Not served\n', {
          status: 502,
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'content-security-policy': "sandbox; default-src 'none'",
            'cache-control': 'no-store',
          },
        });
      }
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: answered,
    });
  } catch {
    return Response.json(
      { error: { code: 'api_unavailable', message: 'Melete is not responding right now.' } },
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

/**
 * The bundle and the brand folder are read synchronously. They are small local
 * files, and Bun (1.3) leaves a `Connection: close` request's socket open when
 * a buffered body follows an awaited file read, which the rendered page is.
 */
const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    // Missing, or a path component that is not a directory. Either way, no file.
    return false;
  }
};

/** One call's upstream WebSocket, passed through to the API: what is waiting, and the API's side. */
type CallBridge = {
  authorization: string;
  upstream?: WebSocket;
  waiting: (string | Uint8Array)[];
  /** Bytes held in `waiting` while the API side opens. */
  held: number;
  closed?: boolean;
};

/**
 * The largest message carried, the same limit the API sets. Until the API has
 * accepted the connection (and so checked that it is from ElevenLabs), no more
 * than this is held in all: the provider sends only its opening message first.
 */
export const CALL_BRIDGE_MESSAGE_BYTES = 2 * 1024 * 1024;

/**
 * The one WebSocket this server passes through: ElevenLabs connecting for a
 * call. The API checks the connection's own proof that it is from ElevenLabs,
 * so that header goes along and nothing else of the request does. Messages are
 * carried both ways as they come; either side closing closes the other.
 */
function callBridge(apiOrigin: string) {
  const target = new URL(apiOrigin);
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  target.pathname = CALL_UPSTREAM_PATH;
  return {
    open(socket: ServerWebSocket<CallBridge>) {
      const upstream = new WebSocket(target.toString(), {
        headers: { [SPEECH_ENGINE_AUTH_HEADER]: socket.data.authorization },
      } as unknown as string[]);
      upstream.binaryType = 'arraybuffer';
      socket.data.upstream = upstream;
      upstream.onopen = () => {
        for (const message of socket.data.waiting.splice(0)) upstream.send(message);
      };
      upstream.onmessage = (event) => {
        socket.send(
          typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer),
        );
      };
      upstream.onclose = (event) => {
        if (socket.data.closed) return;
        // 1005 and 1006 only describe a close; they are never sent in one.
        if (event.code === 1005) socket.close(1000, event.reason);
        else if (event.code === 1006 || event.code === 1015)
          socket.close(1011, 'call service unavailable');
        else socket.close(event.code, event.reason);
      };
      upstream.onerror = () => {
        if (socket.data.closed) return;
        process.stderr.write('web: a call could not reach the API\n');
        socket.close(1011, 'call service unavailable');
      };
    },
    message(socket: ServerWebSocket<CallBridge>, message: string | Buffer) {
      const data = typeof message === 'string' ? message : new Uint8Array(message);
      const upstream = socket.data.upstream;
      if (upstream?.readyState === WebSocket.OPEN) {
        upstream.send(data);
        return;
      }
      socket.data.held += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
      if (socket.data.held > CALL_BRIDGE_MESSAGE_BYTES) {
        socket.data.waiting.length = 0;
        socket.close(1009, 'too much before the call connected');
        return;
      }
      socket.data.waiting.push(data);
    },
    close(socket: ServerWebSocket<CallBridge>) {
      socket.data.closed = true;
      socket.data.waiting.length = 0;
      socket.data.upstream?.close();
    },
    maxPayloadLength: CALL_BRIDGE_MESSAGE_BYTES,
  };
}

/**
 * The files a brand folder may hold, as paths relative to it. Anything else in
 * the folder is never served: it may replace the icons, the logo, the web app
 * manifest and the colours, and not the app.
 */
export const BRAND_FILE =
  /^(?:favicon\.(?:ico|svg|png)|logo\.(?:svg|png|webp)|icons\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.(?:png|svg|ico|webp)|manifest\.webmanifest|brand\.css)$/;

/** Bundle paths that read a brand file of another name: the mark the app draws is its logo. */
const BRAND_ALIASES: Readonly<Record<string, string>> = { 'melete-logo.png': 'logo.png' };

/**
 * The custom properties `brand.css` may set: every design token the web
 * client declares in apps/web/src/design/tokens.css, and nothing else. A test
 * keeps the two lists equal, so these names are the contract.
 */
export const BRAND_TOKENS: ReadonlySet<string> = new Set(
  (
    '--canvas --surface --soft --overlay --text --heading --muted --secondary --placeholder ' +
    '--line --line-strong --control --hover --row-hover --primary --primary-hover --primary-fg ' +
    '--blue-soft --blue-ink --blue-line --bubble --bubble-ink --travel --travel-ink --sage ' +
    '--sage-ink --sand --sand-ink --lilac --lilac-ink --success --success-soft --danger ' +
    '--danger-soft --rating --chip-bg --elevated --ring --skeleton-a --skeleton-b --studio ' +
    '--studio-panel --studio-panel-2 --studio-line --studio-text --studio-muted --rose ' +
    '--rose-ink --radius-sheet --radius-card --radius-block --radius-button --shadow-sheet ' +
    '--shadow-lift --shadow-pill --font-body --font-voice --font-head'
  ).split(' '),
);

/** The most a `brand.css` may hold: it is read and checked on every page load. */
export const BRAND_CSS_MAX_BYTES = 64 * 1024;

/** The most any other brand file may hold: it is read whole before it is served. */
export const BRAND_FILE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The stylesheet with each comment blanked, exactly where a browser finds
 * one: `/*` inside a string is text to a browser, so a pattern that strips
 * every `/* ... *\/` would hide from the check what the browser then applies.
 * A string ends at its quote or a line break, as CSS strings do; a backslash
 * is refused afterwards wherever it is left, so no escape is read here.
 */
function blankComments(css: string): string {
  let out = '';
  let quote = '';
  for (let at = 0; at < css.length; at += 1) {
    const c = css[at] as string;
    if (quote) {
      if (c === quote || c === '\n' || c === '\r' || c === '\f') quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '/' && css[at + 1] === '*') {
      const end = css.indexOf('*/', at + 2);
      at = end === -1 ? css.length : end + 1;
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

/** The rule sets `brand.css` may write: the same three tokens.css uses for light and dark. */
const BRAND_SELECTORS = new Set([
  ':root',
  ':root[data-theme="light"]',
  ':root[data-theme="dark"]',
  ':root:not([data-theme="light"])',
  ':root:not([data-theme="dark"])',
]);

/**
 * Why a `brand.css` cannot be served, or an empty list when it can. It may only
 * set the design tokens, in `:root` rule sets, optionally inside
 * `@media (prefers-color-scheme: dark|light)`. No other property, selector or
 * at-rule, no `url()` (so nothing is fetched from elsewhere) and no escapes
 * (so a name cannot be spelt another way).
 */
export function brandCssIssues(css: string): string[] {
  if (css.length > BRAND_CSS_MAX_BYTES) return [`it is over ${BRAND_CSS_MAX_BYTES / 1024} KiB`];
  const text = blankComments(css);
  const issues: string[] = [];
  if (/[\\<]/.test(text)) issues.push('backslash escapes and < are not allowed');
  if (/url\s*\(|image-set\s*\(|expression\s*\(/i.test(text)) issues.push('url() is not allowed');
  if (issues.length) return issues;
  const selector = (raw: string) =>
    raw
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/'/g, '"')
      .replace(/\[\s*/g, '[')
      .replace(/\s*\]/g, ']');
  const declarations = (body: string, where: string) => {
    for (const part of body.split(';')) {
      if (!part.trim()) continue;
      const colon = part.indexOf(':');
      const name = (colon === -1 ? part : part.slice(0, colon)).trim();
      const value = colon === -1 ? '' : part.slice(colon + 1).trim();
      if (!BRAND_TOKENS.has(name)) issues.push(`${where}: ${name} is not a design token`);
      else if (!value) issues.push(`${where}: ${name} has no value`);
    }
  };
  // A selector starts at its first non-space character, so the leading `\s*`
  // and the selector never compete for the same whitespace: each pattern
  // takes time in proportion to what it reads, not its square.
  const rule = /\s*([^{}@;\s][^{}@;]*)\{([^{}]*)\}/y;
  const media = /\s*@media\s*\(\s*prefers-color-scheme\s*:\s*(?:dark|light)\s*\)\s*\{/y;
  const close = /\s*\}/y;
  const end = /\s*$/y;
  let at = 0;
  let inMedia = false;
  for (;;) {
    end.lastIndex = at;
    if (end.test(text)) break;
    media.lastIndex = at;
    const opened = inMedia ? null : media.exec(text);
    if (opened) {
      inMedia = true;
      at = media.lastIndex;
      continue;
    }
    rule.lastIndex = at;
    const set = rule.exec(text);
    if (set) {
      const name = selector(set[1] ?? '');
      if (!BRAND_SELECTORS.has(name)) issues.push(`${name} is not a :root rule set`);
      else declarations(set[2] ?? '', name);
      at = rule.lastIndex;
      continue;
    }
    close.lastIndex = at;
    const closed = inMedia ? close.exec(text) : null;
    if (closed) {
      inMedia = false;
      at = close.lastIndex;
      continue;
    }
    issues.push(`unexpected text near "${text.slice(at).trim().slice(0, 40)}"`);
    break;
  }
  if (inMedia) issues.push('an @media block is not closed');
  return issues;
}

const BRAND_TYPES: Readonly<Record<string, string>> = {
  css: 'text/css; charset=utf-8',
  ico: 'image/x-icon',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  webmanifest: 'application/manifest+json',
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/**
 * The client's page with the installation's name as its title and home-screen
 * title, and the brand stylesheet linked last in the head, after the bundle's
 * own, so its tokens win.
 */
export function renderIndex(html: string, name: string, brandCss: boolean): string {
  const safe = escapeHtml(name);
  let page = html
    .replace(/<title>[^<]*<\/title>/, () => `<title>${safe}</title>`)
    .replace(
      /(<meta\s+name="apple-mobile-web-app-title"\s+content=")[^"]*(")/,
      (_m, open: string, end: string) => `${open}${safe}${end}`,
    )
    // The description opens with the name: "Melete: the assistant that actually does it."
    .replace(
      /(<meta\s+name="description"\s+content=")Melete(:[^"]*")/,
      (_m, open: string, rest: string) => `${open}${safe}${rest}`,
    );
  if (brandCss)
    page = page.replace('</head>', () => '<link rel="stylesheet" href="/brand.css" />\n</head>');
  return page;
}

/**
 * The brand file a request names, as an absolute path whose real location is
 * inside the brand folder, or null. A symbolic link may point within the
 * folder; one that leaves it is refused, as is any path not in BRAND_FILE.
 */
export function brandFile(brandRoot: string, pathname: string): string | null {
  const target = resolveInside(brandRoot, pathname);
  if (target === null || target === brandRoot) return null;
  const name = relative(brandRoot, target).split(sep).join('/');
  const wanted = BRAND_ALIASES[name] ?? name;
  if (!BRAND_FILE.test(wanted)) return null;
  const path = resolve(brandRoot, wanted);
  try {
    const real = realpathSync(path);
    if (!real.startsWith(brandRoot + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * A brand file's bytes, read through one handle that is checked to be the file
 * `real` names inside the folder now, after it was opened. brandFile judges a
 * path; a folder on the way swapped for a link between that judgement and the
 * open would have the open read somewhere else, and this sees it: the handle's
 * file is not the one the path now names inside the folder. `refused` says why
 * a file that is there is not served; a file that vanished says nothing.
 */
export function readBrandFile(
  brandRoot: string,
  real: string,
  limit: number,
): { bytes: Buffer } | { refused: string | null } {
  let fd: number;
  try {
    fd = openSync(real, 'r');
  } catch {
    return { refused: null };
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return { refused: null };
    if (opened.size > limit)
      return { refused: `it is over ${Math.round(limit / 1024)} KiB, so it is not served` };
    const now = realpathSync(real);
    if (!now.startsWith(brandRoot + sep)) return { refused: null };
    const named = statSync(now);
    if (named.dev !== opened.dev || named.ino !== opened.ino) return { refused: null };
    const bytes = Buffer.alloc(opened.size);
    let read = 0;
    while (read < bytes.length) {
      const got = readSync(fd, bytes, read, bytes.length - read, read);
      if (got === 0) break;
      read += got;
    }
    return { bytes: bytes.subarray(0, read) };
  } catch {
    return { refused: null };
  } finally {
    closeSync(fd);
  }
}

/**
 * Headers on an SVG from the brand folder. Opened on its own it is a
 * document at this origin, so it runs no script, loads nothing, and is
 * sandboxed into an origin of its own should anything in it still try.
 * As an icon or an `<img>` it draws as before: an image's own policy is not
 * applied to the page that shows it.
 */
const BRAND_SVG_POLICY =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; sandbox";

/** The brand folder's real path, or undefined when none is configured or it cannot be read. */
function brandRootOf(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  try {
    return realpathSync(resolve(dir));
  } catch {
    process.stderr.write(`MELETE_WEB_BRAND_DIR ${dir} cannot be read; serving the bundle alone.\n`);
    return undefined;
  }
}

export function createStaticServer(options: StaticServerOptions) {
  const root = resolve(options.root);
  const indexPath = resolve(root, 'index.html');
  const brandRoot = brandRootOf(options.brandDir);
  const instanceName = displayName(options.instanceName, 'MELETE_INSTANCE_NAME');

  // Why a brand file is not served, said once for each file until the answer
  // changes, so a page load that repeats it does not fill the log.
  const said = new Map<string, string>();
  const say = (file: string, why: string | null) => {
    if (why === null) said.delete(file);
    else if (said.get(file) !== why) {
      said.set(file, why);
      process.stderr.write(`brand ${file} is not served: ${why}\n`);
    }
  };

  /** A brand file's bytes, or null when the bundle's own should be served. */
  const brandBytes = (path: string, name: string, limit: number): Buffer | null => {
    if (!brandRoot) return null;
    const read = readBrandFile(brandRoot, path, limit);
    if ('bytes' in read) return read.bytes;
    if (read.refused) say(name, read.refused);
    return null;
  };

  /** The brand stylesheet's text when it only sets design tokens; otherwise null, and why is logged. */
  const brandCss = (): string | null => {
    if (!brandRoot) return null;
    const path = brandFile(brandRoot, '/brand.css');
    if (!path) return null;
    const bytes = brandBytes(path, 'brand.css', BRAND_CSS_MAX_BYTES);
    if (!bytes) return null;
    const css = bytes.toString('utf8');
    const issues = brandCssIssues(css);
    say('brand.css', issues.length ? issues.join('; ') : null);
    return issues.length ? null : css;
  };
  const apiOrigin = parseOrigin(options.apiOrigin ?? API_ORIGIN, 'The API origin');
  const publicOrigin = options.publicOrigin
    ? parseOrigin(options.publicOrigin, 'MELETE_WEB_ORIGIN')
    : undefined;
  const routeTable = options.routeTable ?? (() => readFile('/proc/net/route', 'utf8'));
  const upstream =
    options.trustedUpstream === HOST_GATEWAY
      ? trustedPeer(HOST_GATEWAY, async () => {
          const gateway = defaultGateway(await routeTable());
          return gateway ? [gateway] : [];
        })
      : trustedPeer(options.trustedUpstream);

  // Read on each page load, so a brand folder's stylesheet can be added or
  // corrected without restarting; the page is small and loads once per visit.
  const index = () => {
    let html: string;
    try {
      html = readFileSync(indexPath, 'utf8');
    } catch {
      return new Response('Not found\n', { status: 404, headers: CLIENT_FRAME_HEADERS });
    }
    return new Response(renderIndex(html, instanceName, brandCss() !== null), {
      headers: { 'content-type': 'text/html; charset=utf-8', ...CLIENT_FRAME_HEADERS },
    });
  };

  return Bun.serve<CallBridge>({
    port: options.port ?? Number(process.env.PORT ?? 3000),
    ...(options.hostname ? { hostname: options.hostname } : {}),
    idleTimeout: 60,
    websocket: callBridge(apiOrigin),
    async fetch(request, server) {
      const url = new URL(request.url);
      if (
        url.pathname === `/api${CALL_UPSTREAM_PATH}` &&
        request.headers.get('upgrade')?.toLowerCase() === 'websocket'
      ) {
        const authorization = request.headers.get(SPEECH_ENGINE_AUTH_HEADER);
        if (!authorization) return new Response('Not a call.\n', { status: 401 });
        return server.upgrade(request, { data: { authorization, waiting: [], held: 0 } })
          ? undefined
          : new Response('The call could not connect.\n', { status: 400 });
      }
      if (
        url.pathname === '/api' ||
        url.pathname.startsWith('/api/') ||
        discoveryPath(url.pathname)
      ) {
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
          headers: { allow: 'GET, HEAD', ...CLIENT_FRAME_HEADERS },
        });
      }

      const { pathname } = url;
      const target = resolveInside(root, pathname);

      // Malformed, or pointing outside the bundle. Not a deep link.
      if (target === null)
        return new Response('Not found\n', { status: 404, headers: CLIENT_FRAME_HEADERS });

      if (target === indexPath) return index();

      // The installation's own icons, logo, manifest and colours, ahead of the bundle's.
      if (brandRoot) {
        // Judged by the file the path names, not its spelling: `/brand.css/`
        // and `//brand.css` name the same file, and only a checked one is served.
        if (relative(root, target).split(sep).join('/') === 'brand.css') {
          const css = brandCss();
          return css === null
            ? new Response('Not found\n', { status: 404, headers: CLIENT_FRAME_HEADERS })
            : new Response(css, {
                headers: {
                  'content-type': BRAND_TYPES.css ?? '',
                  'x-content-type-options': 'nosniff',
                  // Not a hashed name: a changed file is fetched again.
                  'cache-control': 'no-cache',
                  ...CLIENT_FRAME_HEADERS,
                },
              });
        }
        const branded = brandFile(brandRoot, pathname);
        const bytes = branded
          ? brandBytes(
              branded,
              relative(brandRoot, branded).split(sep).join('/'),
              BRAND_FILE_MAX_BYTES,
            )
          : null;
        if (branded && bytes) {
          const type = BRAND_TYPES[branded.slice(branded.lastIndexOf('.') + 1).toLowerCase()];
          return new Response(bytes, {
            headers: {
              ...(type ? { 'content-type': type } : {}),
              'x-content-type-options': 'nosniff',
              'cache-control': 'no-cache',
              ...CLIENT_FRAME_HEADERS,
              ...(type === BRAND_TYPES.svg ? { 'content-security-policy': BRAND_SVG_POLICY } : {}),
            },
          });
        }
      }

      if (target !== root && isFile(target)) {
        return new Response(Bun.file(target), { headers: CLIENT_FRAME_HEADERS });
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
    brandDir: process.env.MELETE_WEB_BRAND_DIR || undefined,
    instanceName: process.env.MELETE_INSTANCE_NAME,
  });
  process.stdout.write(`melete web client listening on :${server.port}\n`);
}
