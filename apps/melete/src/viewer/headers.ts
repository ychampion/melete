/**
 * The headers every response that carries someone else's page is served
 * with: a published app's files, and anything else shown framed inside
 * Melete. They are set here and nowhere else.
 *
 * `Content-Security-Policy: sandbox` gives the document an opaque origin,
 * whether Melete frames it or a browser opens it on its own, so its scripts
 * cannot read Melete's cookies, storage or API. The rest of the policy keeps
 * the page inside its own files: it can fetch nothing, post no form, and load
 * scripts, styles, images and fonts only from where its own files are.
 *
 * A route serving such content goes through `isolated`, which refuses to
 * send a success that lacks the policy: a missing header is a 500, never the
 * page.
 */
import type { MiddlewareHandler } from 'hono';

/** Where an app's files are served, below the API's own address. */
export const VIEW_PREFIX = '/apps/view/';

/** A read of a framed app's file: the one request here that carries no session. */
export const viewPath = (method: string, path: string): boolean =>
  (method === 'GET' || method === 'HEAD') && path.startsWith(VIEW_PREFIX);

/**
 * What a browser says it is loading (`Sec-Fetch-Dest`) when it opens a file
 * as a page of its own, or embeds one as a plugin. A page opened on its own
 * has no frame around it to keep it from navigating itself elsewhere.
 */
const PAGE_OF_ITS_OWN = new Set(['document', 'embed', 'object']);

/**
 * Whether a request for framed content may be answered: the browser says
 * what it is loading, and it is not a page of its own. A request that does
 * not say is refused too: every browser that can run an app says.
 */
export function framedRequest(destination: string | null | undefined): boolean {
  return typeof destination === 'string' && destination !== '' && !PAGE_OF_ITS_OWN.has(destination);
}

/** What the page may still do inside its frame. No same-origin, popups or top navigation. */
export const VIEW_SANDBOX = 'allow-scripts allow-forms allow-downloads';

/**
 * The policy. `'self'` names where the page's own files are served from:
 * browsers match it against the response's own address even though the
 * document's origin is opaque, which the browser proof checks.
 */
export const VIEW_POLICY = [
  `sandbox ${VIEW_SANDBOX}`,
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

/** The script types: a sandboxed page fetches a module script in CORS mode, with `Origin: null`. */
const SCRIPT_TYPES = new Set(['text/javascript', 'application/javascript']);

const essence = (contentType: string) => contentType.split(';')[0]?.trim().toLowerCase() ?? '';

/** The isolation headers for a response of this type. */
export function viewHeaders(contentType: string): Headers {
  const headers = new Headers({
    'content-security-policy': VIEW_POLICY,
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, no-store',
    'x-dns-prefetch-control': 'off',
  });
  // A module script loads only with this. It carries nothing a stranger could
  // use: no credentials go with it, and the token in the address is the gate.
  if (SCRIPT_TYPES.has(essence(contentType))) headers.set('access-control-allow-origin', '*');
  return headers;
}

/** Whether a response carries the isolation policy, exactly as it is set here. */
export function isIsolated(headers: Headers): boolean {
  return headers.get('content-security-policy') === VIEW_POLICY;
}

const NOT_SERVED = 'This page could not be shown safely, so it was not shown.';

/**
 * The response as it may leave: with the policy, and never with a cookie.
 *
 * - A success without the policy is replaced by a 500. Its body is never sent.
 * - A refusal or error (this service's own JSON) is sent with the policy added,
 *   so even that cannot run as Melete if a browser opens it.
 */
export function sealView(response: Response): Response {
  if (response.ok && !isIsolated(response.headers)) {
    return new Response(`${NOT_SERVED}\n`, {
      status: 500,
      headers: viewHeaders('text/plain; charset=utf-8'),
    });
  }
  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  if (!isIsolated(headers)) {
    const isolation = viewHeaders(headers.get('content-type') ?? 'text/plain; charset=utf-8');
    for (const [name, value] of isolation) headers.set(name, value);
    headers.delete('access-control-allow-origin');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Middleware for every route that serves framed content. Registered before
 * any other middleware, it runs last on the way out, after the route, the
 * error handler and everything else, so it sees exactly what would be sent.
 */
export const isolated: MiddlewareHandler = async (c, next) => {
  await next();
  const sealed = sealView(c.res);
  // Assigning over a response merges the old one's headers into the new, set-cookie
  // included; clearing it first makes the sealed response the whole answer.
  c.res = undefined;
  c.res = sealed;
};
