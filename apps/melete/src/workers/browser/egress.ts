import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { BrowserContext, Frame, Request, Route } from 'playwright';
import { isPublicAddress, type ResolvedAddress } from '../../connectors/web.ts';
import type { LiveNetworkBudget, LiveNotify, LiveSiteScope } from './live-protocol.ts';

export type BrowserNetworkPolicy = {
  public_compartment: boolean;
  allowed_domains: string[];
};

export type BrowserNetworkMode = 'navigate' | 'reversible' | 'commit' | 'human';

/** A person's live channel: any method inside the takeover's site scope, nothing outside it. */
export type BrowserHumanWindow = {
  scope: Pick<LiveSiteScope, 'admits' | 'follow'>;
  budget: LiveNetworkBudget;
  notice: LiveNotify;
};

export type BrowserCommitBinding = {
  url: string;
  method: 'POST';
  body_sha256: string;
};

export type BrowserNetworkResponse = {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
};

export type BrowserNetworkTransport = (
  url: URL,
  address: ResolvedAddress,
  options: {
    method: string;
    headers: Record<string, string>;
    body: Buffer | null;
    signal: AbortSignal;
    maxBytes: number;
    maxHeaderBytes: number;
    timeoutMs: number;
  },
) => Promise<BrowserNetworkResponse>;

export type BrowserNetworkOptions = {
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  transport?: BrowserNetworkTransport;
  /** Test dependency only: literal loopback origins, never configuration or tool input. */
  fixtureOrigins?: readonly string[];
  maxRequests?: number;
  maxRedirects?: number;
  maxBytes?: number;
  maxRequestBytes?: number;
  maxHeaderBytes?: number;
  timeoutMs?: number;
};

export class BrowserNetworkError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserNetworkError';
  }
}

/** A checked redirect must become a fresh controller navigation, with a new epoch check. */
export class BrowserRedirect extends BrowserNetworkError {
  constructor(
    readonly target_url: string,
    readonly status: number,
    readonly after_commit: boolean,
  ) {
    super('browser_redirect', 'browser document redirect requires a fresh controller navigation');
    this.name = 'BrowserRedirect';
  }
}

const READ_METHODS = new Set(['GET', 'HEAD']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'alt-svc',
]);

function networkError(code: string, message: string): never {
  throw new BrowserNetworkError(code, message);
}

function positiveLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid browser network limit');
  return limit;
}

function hostname(url: URL): string {
  return url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function parseUrl(raw: string): URL {
  if (raw.length > 16_384) networkError('url_not_allowed', 'browser URL exceeds the size limit');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return networkError('url_not_allowed', 'browser URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    networkError('url_not_allowed', 'only HTTP(S) browser URLs without credentials are allowed');
  }
  return url;
}

function attribute(value: string): string {
  return value.replace(/[&"'<>]/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** The document a top-level navigation leaves; undefined for every other request. */
async function topNavigation(request: Request): Promise<{ initiator?: string } | undefined> {
  if (!request.isNavigationRequest()) return undefined;
  let frame: Frame;
  try {
    frame = request.frame();
  } catch {
    return undefined;
  }
  if (frame.parentFrame()) return undefined;
  const current = frame.url();
  if (/^https?:/i.test(current)) return { initiator: current };
  // A popup's first document is started by the page that opened it.
  const opener = await frame
    .page()
    .opener()
    .catch(() => null);
  return { initiator: opener?.url() };
}

function fixtureOrigin(raw: string): string {
  const url = parseUrl(raw);
  const name = hostname(url);
  if (
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !((isIP(name) === 4 && name.startsWith('127.')) || name === '::1')
  ) {
    throw new Error('browser fixture origins must be exact literal loopback origins');
  }
  return url.origin;
}

/** Headers cannot smuggle a second request or select another relay destination. */
function relayHeaders(
  input: Record<string, string | string[]>,
  maxBytes: number,
  request: boolean,
): Record<string, string> {
  const result: Record<string, string> = {};
  const denied = new Set(HOP_HEADERS);
  if (request) denied.add('host');
  for (const [key, raw] of Object.entries(input)) {
    if (key.toLowerCase() === 'connection') {
      for (const value of Array.isArray(raw) ? raw : [raw]) {
        for (const token of value.split(',')) denied.add(token.trim().toLowerCase());
      }
    }
  }
  let size = 0;
  for (const [key, raw] of Object.entries(input)) {
    const name = key.toLowerCase();
    const values = Array.isArray(raw) ? raw : [raw];
    if (!/^[!#$%&'*+.^_`|~\da-z-]+$/.test(name)) {
      networkError('invalid_headers', 'browser network header name is invalid');
    }
    for (const value of values) {
      if (/[\r\n\0]/.test(value)) {
        networkError('invalid_headers', 'browser network header value is invalid');
      }
      size += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    }
    if (size > maxBytes) networkError('headers_too_large', 'browser headers exceed the size limit');
    if (denied.has(name)) continue;
    if (name === 'location' && values.length !== 1) {
      networkError('invalid_redirect', 'browser response has ambiguous redirect locations');
    }
    // Playwright uses a newline for multiple Set-Cookie values; ordinary headers use commas.
    result[name] = values.join(name === 'set-cookie' ? '\n' : ', ');
  }
  return result;
}

/** Node resolves only the already checked address; Host and TLS SNI retain the URL host. */
export const pinnedBrowserRequest: BrowserNetworkTransport = (url, address, options) =>
  new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const name = hostname(url);
    const req = request(
      url,
      {
        agent: false,
        method: options.method,
        signal: options.signal,
        maxHeaderSize: options.maxHeaderBytes,
        servername: isIP(name) ? undefined : name,
        lookup: (_name, lookupOptions, callback) =>
          lookupOptions.all
            ? callback(null, [address])
            : callback(null, address.address, address.family),
        headers: {
          ...options.headers,
          ...(options.body ? { 'content-length': String(options.body.length) } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            response.destroy(
              new BrowserNetworkError(
                'response_too_large',
                'browser response exceeds the size limit',
              ),
            );
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once('error', reject);
        response.once('end', () => {
          const headers: BrowserNetworkResponse['headers'] = {};
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            const key = response.rawHeaders[index]?.toLowerCase();
            const value = response.rawHeaders[index + 1];
            if (key === undefined || value === undefined) continue;
            const previous = headers[key];
            headers[key] =
              previous === undefined
                ? value
                : [...(Array.isArray(previous) ? previous : [previous]), value];
          }
          resolve({ status: response.statusCode ?? 502, headers, body: Buffer.concat(chunks) });
        });
      },
    );
    const timer = setTimeout(
      () =>
        req.destroy(
          new BrowserNetworkError('request_timeout', 'browser network request timed out'),
        ),
      options.timeoutMs,
    );
    req.once('upgrade', (_response, socket) => {
      socket.destroy();
      reject(new BrowserNetworkError('websocket_denied', 'browser protocol upgrades are denied'));
    });
    req.once('close', () => clearTimeout(timer));
    req.once('error', reject);
    req.end(options.body);
  });

type Operation = {
  mode: BrowserNetworkMode;
  human: BrowserHumanWindow | undefined;
  origin: string | undefined;
  commit: BrowserCommitBinding | undefined;
  guard: (() => void) | undefined;
  requests: number;
  mutations: number;
  pending: Set<Promise<void>>;
  abort: AbortController;
  error: Error | undefined;
  ending: boolean;
};

async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export type BrowserEgress = ReturnType<typeof createBrowserEgress>;

/**
 * One controller operation owns the network window. Late page scripts cannot inherit
 * an approval, and a second simultaneous POST cannot race the mutation counter.
 * The caller must block service workers and direct Chromium egress before install.
 */
export function createBrowserEgress(
  policy: BrowserNetworkPolicy,
  options: BrowserNetworkOptions = {},
) {
  const publicCompartment = policy.public_compartment;
  const domains = new Set(
    policy.allowed_domains.map((value) => value.toLowerCase().replace(/\.$/, '')),
  );
  const fixtures = new Set((options.fixtureOrigins ?? []).map(fixtureOrigin));
  const resolve =
    options.resolve ??
    (async (name: string) =>
      (await lookup(name, { all: true, verbatim: true })) as ResolvedAddress[]);
  const transport = options.transport ?? pinnedBrowserRequest;
  const maxRequests = positiveLimit(options.maxRequests, 128);
  const maxRedirects = positiveLimit(options.maxRedirects, 5);
  const maxBytes = positiveLimit(options.maxBytes, 8 * 1024 * 1024);
  const maxRequestBytes = positiveLimit(options.maxRequestBytes, 1024 * 1024);
  const maxHeaderBytes = positiveLimit(options.maxHeaderBytes, 32 * 1024);
  const timeoutMs = positiveLimit(options.timeoutMs, 10_000);
  let context: BrowserContext | undefined;
  let active: Operation | undefined;
  let closed = false;
  let commitDispatched = false;

  async function checkAddress(
    url: URL,
    signal: AbortSignal,
    human = false,
  ): Promise<ResolvedAddress> {
    const name = hostname(url);
    // A takeover's site scope starts from these domains and admits its hosts instead; the
    // public-address, DNS and pinning checks below apply to a person exactly as to automation.
    if (!human && !publicCompartment && !domains.has(name)) {
      networkError('domain_not_allowed', 'private-context browser cannot access this domain');
    }
    const family = isIP(name);
    const addresses = family
      ? [{ address: name, family: family as 4 | 6 }]
      : await untilAborted(resolve(name), signal);
    const fixture = fixtures.has(url.origin);
    if (
      !addresses.length ||
      addresses.some(
        (address) =>
          isIP(address.address) !== address.family ||
          (!fixture && !isPublicAddress(address.address)),
      )
    ) {
      networkError('non_public_address', 'browser URL resolves to a non-public address');
    }
    const pinned = addresses[0];
    if (!pinned) return networkError('non_public_address', 'browser URL did not resolve');
    return pinned;
  }

  function requireOperation(operation: Operation | undefined): asserts operation is Operation {
    if (closed) networkError('network_closed', 'browser network guard is closed');
    if (!operation || operation !== active || operation.ending) {
      networkError('network_idle', 'browser network requires an active controller operation');
    }
    if (operation.error) throw operation.error;
    if (operation.mode === 'reversible') {
      networkError(
        'network_reversible',
        'reversible browser input cannot dispatch network requests',
      );
    }
  }

  function admitRequest(
    operation: Operation,
    url: URL,
    request: Request,
    body: Buffer | null,
    headers: Record<string, string>,
    navigation: { initiator?: string } | undefined,
  ): void {
    const human = operation.human;
    if (human) {
      if (!human.budget.request()) {
        human.notice('live_budget');
        networkError('live_budget', 'the takeover has used its browser request budget');
      }
      const host = hostname(url);
      if (
        !human.scope.admits(host) &&
        (!navigation ||
          !['in_scope', 'admitted'].includes(human.scope.follow(url.href, navigation.initiator)))
      ) {
        human.notice('off_scope', host);
        networkError('off_scope', 'browser request is outside the takeover site scope');
      }
      return;
    }
    operation.requests += 1;
    if (operation.requests > maxRequests) {
      networkError('request_limit', 'browser operation exceeds the request limit');
    }
    const read = READ_METHODS.has(request.method());
    if (operation.mode === 'navigate' && !read) {
      networkError('mutation_requires_commit', 'browser mutation requires an approved submit');
    }
    if (operation.mode === 'commit') {
      if (url.origin !== operation.origin) {
        networkError('commit_origin', 'browser submit cannot leave the current page origin');
      }
      if (read) {
        networkError(
          'commit_read_type',
          'browser submit document reads require a fresh controller navigation',
        );
      } else {
        const commit = operation.commit;
        if (
          !commit ||
          request.method() !== commit.method ||
          url.href !== commit.url ||
          createHash('sha256')
            .update(body ?? Buffer.alloc(0))
            .digest('hex') !== commit.body_sha256 ||
          headers['content-type']?.split(';')[0]?.trim().toLowerCase() !==
            'application/x-www-form-urlencoded'
        ) {
          networkError(
            'commit_payload_mismatch',
            'browser submit request does not match the approved payload',
          );
        }
        operation.mutations += 1;
        if (operation.mutations > 1) {
          networkError('commit_budget', 'browser submit permits at most one mutation request');
        }
      }
    }
    let redirects = 0;
    for (let previous = request.redirectedFrom(); previous; previous = previous.redirectedFrom()) {
      redirects += 1;
      if (redirects > maxRedirects) {
        networkError('redirect_limit', 'browser redirect limit exceeded');
      }
    }
  }

  /**
   * Chromium does not route the next hop of a fulfilled redirect, so a person's checked document
   * redirect continues as a navigation from a no-store document that carries this hop's cookies.
   */
  async function humanRedirect(
    route: Route,
    request: Request,
    source: URL,
    target: URL,
    status: number,
    headers: Record<string, string>,
    human: BrowserHumanWindow,
    navigation: { initiator?: string } | undefined,
  ): Promise<void> {
    if (!navigation) {
      human.notice('redirect_refused');
      networkError(
        'subresource_redirect_unsupported',
        'browser subresource redirects are not supported',
      );
    }
    if (!READ_METHODS.has(request.method()) && [307, 308].includes(status)) {
      human.notice('redirect_refused');
      networkError('redirect_mutation', 'browser redirect cannot replay a mutation');
    }
    if (!['in_scope', 'admitted'].includes(human.scope.follow(target.href, source.href))) {
      human.notice('off_scope', hostname(target));
      networkError('off_scope', 'browser redirect is outside the takeover site scope');
    }
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        ...(headers['set-cookie'] ? { 'set-cookie': headers['set-cookie'] } : {}),
      },
      body: `<!doctype html><meta http-equiv="refresh" content="0;url=${attribute(target.href)}">`,
    });
  }

  async function relay(route: Route, operation: Operation | undefined): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const abortOperation = () => abort.abort(operation?.abort.signal.reason);
    operation?.abort.signal.addEventListener('abort', abortOperation, { once: true });
    try {
      requireOperation(operation);
      timer = setTimeout(
        () =>
          abort.abort(
            new BrowserNetworkError('request_timeout', 'browser network request timed out'),
          ),
        timeoutMs,
      );
      const request = route.request();
      const url = parseUrl(request.url());
      const body = request.postDataBuffer();
      if (body && body.length > maxRequestBytes) {
        networkError('request_too_large', 'browser request exceeds the size limit');
      }
      const headers = relayHeaders(
        await untilAborted(request.allHeaders(), abort.signal),
        maxHeaderBytes,
        true,
      );
      requireOperation(operation);
      const human = operation.human;
      const navigation = human
        ? await untilAborted(topNavigation(request), abort.signal)
        : undefined;
      requireOperation(operation);
      admitRequest(operation, url, request, body, headers, navigation);
      const address = await checkAddress(url, abort.signal, Boolean(human));
      requireOperation(operation);
      // DNS and header reads yielded after the input was planned. The controller
      // rechecks takeover here, synchronously adjacent to the actual dispatch.
      operation.guard?.();
      if (operation.mode === 'commit' && request.method() === 'POST') commitDispatched = true;
      const response = await untilAborted(
        transport(url, address, {
          method: request.method(),
          headers,
          body,
          signal: abort.signal,
          maxBytes,
          maxHeaderBytes,
          timeoutMs,
        }),
        abort.signal,
      );
      if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599) {
        networkError('invalid_response', 'browser relay received an unsupported response status');
      }
      if (response.body.length > maxBytes) {
        networkError('response_too_large', 'browser response exceeds the size limit');
      }
      if (human && !human.budget.transfer((body?.length ?? 0) + response.body.length)) {
        human.notice('live_budget');
        networkError('live_budget', 'the takeover has used its browser byte budget');
      }
      const responseHeaders = relayHeaders(response.headers, maxHeaderBytes, false);
      if (human && /^\s*attachment/i.test(responseHeaders['content-disposition'] ?? '')) {
        human.notice('download_refused');
        networkError('download_refused', 'browser downloads are refused during a takeover');
      }
      if (REDIRECT_STATUSES.has(response.status) && responseHeaders.location) {
        let target: URL;
        try {
          target = parseUrl(new URL(responseHeaders.location, url).href);
          await checkAddress(target, abort.signal, Boolean(human));
        } catch (error) {
          human?.notice('redirect_refused');
          throw error;
        }
        if (human) {
          await humanRedirect(
            route,
            request,
            url,
            target,
            response.status,
            responseHeaders,
            human,
            navigation,
          );
          return;
        }
        if (operation.mode === 'commit' && target.origin !== operation.origin) {
          networkError(
            'commit_origin',
            'browser submit redirect cannot leave the current page origin',
          );
        }
        if (!READ_METHODS.has(request.method()) && [307, 308].includes(response.status)) {
          networkError('redirect_mutation', 'browser submit redirect cannot replay a mutation');
        }
        if (request.resourceType() !== 'document') {
          networkError(
            'subresource_redirect_unsupported',
            'browser subresource redirects are not supported',
          );
        }
        if (
          (operation.mode === 'navigate' && READ_METHODS.has(request.method())) ||
          (operation.mode === 'commit' &&
            request.method() === 'POST' &&
            [302, 303].includes(response.status))
        ) {
          // Chromium can bypass Playwright routing on automatic redirect hops. The
          // dead proxy blocks that hop; fulfill preserves original-origin cookies,
          // and the controller follows this signal through a fresh guarded goto.
          operation.error = new BrowserRedirect(
            target.href,
            response.status,
            operation.mode === 'commit',
          );
        } else {
          networkError(
            'redirect_unsupported',
            'browser redirect requires an unsupported method transition',
          );
        }
      }
      await route.fulfill({
        status: response.status,
        headers: responseHeaders,
        body: response.body,
      });
    } catch (error) {
      // A person's refused request fails alone; it never ends the takeover's network window.
      if (operation && operation.mode !== 'human' && !operation.error) {
        operation.error =
          error instanceof Error ? error : new Error('browser network request failed');
      }
      await route.abort('blockedbyclient').catch(() => {});
    } finally {
      if (timer) clearTimeout(timer);
      operation?.abort.signal.removeEventListener('abort', abortOperation);
    }
  }

  return {
    get commitDispatched(): boolean {
      return commitDispatched;
    },

    get idle(): boolean {
      return Boolean(context) && !closed && !active;
    },

    async install(target: BrowserContext): Promise<void> {
      if (context || closed)
        networkError('network_closed', 'browser network guard cannot be installed twice');
      if (
        target.serviceWorkers().length ||
        target.pages().some((page) => page.url() !== 'about:blank')
      ) {
        networkError(
          'network_late_install',
          'browser network guard must be installed before browsing',
        );
      }
      context = target;
      await target.route('**/*', (route) => {
        const operation = active;
        const pending = relay(route, operation);
        operation?.pending.add(pending);
        void pending.finally(() => operation?.pending.delete(pending));
        return pending;
      });
      await target.routeWebSocket('**/*', async (socket) => {
        if (active?.human) active.human.notice('websocket_refused');
        else if (active && !active.error) {
          active.error = new BrowserNetworkError(
            'websocket_denied',
            'browser WebSockets are denied',
          );
        }
        await socket.close({ code: 1008, reason: 'browser WebSockets are denied' });
      });
    },

    async run<T>(
      mode: BrowserNetworkMode,
      operation: () => Promise<T>,
      commit?: BrowserCommitBinding,
      guard?: () => void,
      human?: BrowserHumanWindow,
    ): Promise<T> {
      if (!context || closed)
        networkError('network_closed', 'browser network guard is not available');
      if (active) networkError('network_busy', 'browser network operation is already running');
      if (!['navigate', 'reversible', 'commit', 'human'].includes(mode)) {
        networkError('invalid_mode', 'browser network operation mode is invalid');
      }
      if ((mode === 'human') !== Boolean(human)) {
        networkError('invalid_mode', 'a person holds the browser network only with a site scope');
      }
      if (mode === 'commit') commitDispatched = false;
      const pageUrl = context.pages()[0]?.url();
      const origin = pageUrl && /^https?:/.test(pageUrl) ? parseUrl(pageUrl).origin : undefined;
      let binding: BrowserCommitBinding | undefined;
      if (mode === 'commit') {
        if (commit?.method !== 'POST' || !/^[a-f\d]{64}$/.test(commit.body_sha256)) {
          networkError('commit_payload_mismatch', 'browser submit requires a bound POST payload');
        }
        const target = parseUrl(commit.url);
        target.hash = '';
        if (target.origin !== origin) {
          networkError('commit_origin', 'browser submit cannot leave the current page origin');
        }
        binding = { ...commit, url: target.href };
      }
      const current: Operation = {
        mode,
        human: mode === 'human' ? human : undefined,
        origin,
        commit: binding,
        guard,
        requests: 0,
        mutations: 0,
        pending: new Set(),
        abort: new AbortController(),
        error: undefined,
        ending: false,
      };
      active = current;
      try {
        const result = await operation();
        current.ending = true;
        while (current.pending.size) await Promise.all([...current.pending]);
        if (current.error) throw current.error;
        if (mode === 'commit' && current.mutations !== 1) {
          networkError(
            'commit_not_dispatched',
            'browser submit did not dispatch its approved request',
          );
        }
        return result;
      } catch (error) {
        current.ending = true;
        current.abort.abort(error);
        while (current.pending.size) await Promise.all([...current.pending]);
        throw current.error ?? error;
      } finally {
        current.ending = true;
        active = undefined;
      }
    },

    async close(): Promise<void> {
      closed = true;
      const operation = active;
      operation?.abort.abort(
        new BrowserNetworkError('network_closed', 'browser network guard is closed'),
      );
      // Keep the deny route installed: removing it would restore direct browser networking.
      if (operation) while (operation.pending.size) await Promise.all([...operation.pending]);
    },
  };
}
