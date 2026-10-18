/**
 * The MCP Apps extension (`io.modelcontextprotocol/ui`), from the client's
 * side: which tools carry a page, how the page is read from the server, and
 * what the page may reach once it is drawn.
 *
 * A server marks a tool with `_meta.ui.resourceUri` (an earlier draft used the
 * flat key `ui/resourceUri`; both are read). The page is a `ui://` resource of
 * type `text/html;profile=mcp-app`, read with `resources/read`, and may declare
 * in its own `_meta.ui.csp` the domains it loads from (`resourceDomains`),
 * connects to (`connectDomains`) and frames (`frameDomains`). Melete keeps
 * only the declared origins the connection allows: the server's own origin
 * and the operator's `pages.origins`. A page that declares nothing reaches
 * nothing.
 */
import {
  type JsonObject,
  jsonObject,
  MCP_APP_MIME_TYPE,
  PAGE_LIMITS,
  pageOrigin,
} from '@melete/contracts';

export type PageDomains = { connect: string[]; resource: string[]; frame: string[] };

/** A page as the server gave it, before Melete keeps it. */
export type PageSource = {
  resourceUri: string;
  html: string;
  /** What the page declared, before the connection's allow-list. */
  declared: PageDomains;
};

const UI_URI = /^ui:\/\/[^\s]{1,500}$/;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The page a tool definition names, or null when it names none or names one badly. */
export function toolPageUri(definition: unknown): string | null {
  const meta = record(record(definition)?._meta);
  if (!meta) return null;
  const nested = record(meta.ui)?.resourceUri;
  const flat = meta['ui/resourceUri'];
  const uri = typeof nested === 'string' ? nested : typeof flat === 'string' ? flat : null;
  return uri && UI_URI.test(uri) ? uri : null;
}

/** Whether the server offers a tool to its page only (`_meta.ui.visibility` without `model`). */
export function appOnly(definition: unknown): boolean {
  const visibility = record(record(record(definition)?._meta)?.ui)?.visibility;
  return Array.isArray(visibility) && !visibility.includes('model');
}

/** Whether a resource's declared type is the MCP Apps page type, however it is spaced or cased. */
export function isAppMimeType(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normal = value.toLowerCase().replace(/\s+/g, '');
  return normal === MCP_APP_MIME_TYPE;
}

/** The origin a CSP source names, when it is one a page may be allowed. */
function declaredOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 300) return null;
  const parsed = pageOrigin.safeParse(value.replace(/\/+$/, ''));
  return parsed.success ? parsed.data : null;
}

function domainList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const origins = new Set<string>();
  for (const item of value.slice(0, PAGE_LIMITS.domains_max * 4)) {
    const origin = declaredOrigin(item);
    if (origin) origins.add(origin);
    if (origins.size >= PAGE_LIMITS.domains_max) break;
  }
  return [...origins];
}

/** The page's declared domains, from the resource's `_meta.ui.csp`. */
export function declaredDomains(meta: unknown): PageDomains {
  const csp = record(record(record(meta)?.ui)?.csp);
  return {
    connect: domainList(csp?.connectDomains),
    resource: domainList(csp?.resourceDomains),
    frame: domainList(csp?.frameDomains),
  };
}

/** What a page may use: only declared origins the connection allows. */
export function allowedDomains(declared: PageDomains, allowed: readonly string[]): PageDomains {
  const keep = (list: string[]) => list.filter((origin) => allowed.includes(origin));
  return {
    connect: keep(declared.connect),
    resource: keep(declared.resource),
    frame: keep(declared.frame),
  };
}

/** Origins a connection's pages may use: its server's own, and what the operator added. */
export function connectionOrigins(endpointUrl: string, extra: readonly string[] = []): string[] {
  const own = declaredOrigin(new URL(endpointUrl).origin);
  return [...new Set([...(own ? [own] : []), ...extra])];
}

/**
 * Reads a page from the server and checks it is one: the resource asked for,
 * of the MCP Apps type, with text (or base64) no larger than a page may be.
 */
export async function readPageResource(
  request: (method: string, params: JsonObject) => Promise<unknown>,
  uri: string,
): Promise<PageSource> {
  const answer = jsonObject.parse(await request('resources/read', { uri }));
  const contents = answer.contents;
  if (!Array.isArray(contents) || contents.length === 0)
    throw new Error('The page resource has no contents');
  const first = record(contents[0]);
  if (!first || first.uri !== uri) throw new Error('The server answered with another resource');
  if (!isAppMimeType(first.mimeType)) throw new Error('The resource is not an MCP Apps page');
  let html: string;
  if (typeof first.text === 'string') html = first.text;
  else if (typeof first.blob === 'string') {
    if (first.blob.length > Math.ceil((PAGE_LIMITS.html_max_bytes * 4) / 3) + 4)
      throw new Error('The page is too large');
    html = Buffer.from(first.blob, 'base64').toString('utf8');
  } else throw new Error('The page resource has no text');
  if (Buffer.byteLength(html) > PAGE_LIMITS.html_max_bytes)
    throw new Error('The page is too large');
  return { resourceUri: uri, html, declared: declaredDomains(first._meta) };
}

const sources = (list: readonly string[], base: string) =>
  list.length ? `${base} ${list.join(' ')}` : base;

/**
 * The policy a page is served with. `sandbox` without `allow-same-origin`
 * gives the document an opaque origin, whoever frames it and however it is
 * opened: it holds no cookie of Melete's and can read nothing of Melete's
 * page. It runs its own inline script, reaches only the origins it declared
 * and the connection allows, opens no window, submits no form anywhere, and
 * may be framed only by Melete.
 */
export function pagePolicy(domains: PageDomains): string {
  return [
    'sandbox allow-scripts allow-forms',
    "default-src 'none'",
    sources(domains.resource, "script-src 'unsafe-inline'"),
    sources(domains.resource, "style-src 'unsafe-inline'"),
    sources(domains.resource, 'img-src data: blob:'),
    sources(domains.resource, 'font-src data:'),
    sources(domains.resource, 'media-src data: blob:'),
    domains.connect.length ? `connect-src ${domains.connect.join(' ')}` : "connect-src 'none'",
    domains.frame.length ? `frame-src ${domains.frame.join(' ')}` : "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/** The prefix every page policy starts with; the isolation check looks for it. */
export const PAGE_POLICY_PREFIX = 'sandbox allow-scripts allow-forms; ';
