/**
 * A small client for Composio's REST API (v3.1), for the few calls Melete
 * makes there: start a sign-in link, read a connected account, send one
 * request through a connected account (proxy execute), and remove an account.
 *
 * The project key travels in the `x-api-key` header and nowhere else. No
 * request or answer body is ever logged or put in an error: a failure is a
 * `ComposioFault` with a fixed kind, the HTTP status and Composio's own error
 * slug when it gave one. Every call has a deadline and every answer a size
 * limit.
 */
import { boundedJson, ResponseTooLarge } from './signed-in.ts';

/** The toolkits Melete signs in to through Composio. */
export const COMPOSIO_TOOLKITS = ['gmail', 'googlecalendar', 'googledrive'] as const;
export type ComposioToolkit = (typeof COMPOSIO_TOOLKITS)[number];

export type ComposioFaultKind =
  /** The project key was refused: the operator's setting, not the person's account. */
  | 'key_refused'
  /** The connected account is gone, inactive or not this project's. */
  | 'account_unavailable'
  | 'rate_limited'
  /** Composio refused the request as it was written. */
  | 'refused'
  /** Composio did not answer, timed out, or answered with a server error. */
  | 'unavailable'
  /** The answer was not the shape the API documents, or was too large. */
  | 'invalid_answer';

export class ComposioFault extends Error {
  constructor(
    readonly kind: ComposioFaultKind,
    readonly status: number | null = null,
    /** Composio's error slug, a fixed code; never its message. */
    readonly slug: string | null = null,
    readonly retryAfter: number | null = null,
  ) {
    super(`composio_${kind}${status === null ? '' : `_${status}`}`);
    this.name = 'ComposioFault';
  }
}

export type ComposioAccountStatus =
  | 'INITIALIZING'
  | 'INITIATED'
  | 'ACTIVE'
  | 'FAILED'
  | 'EXPIRED'
  | 'INACTIVE'
  | 'REVOKED'
  | (string & {});

export type ComposioAccount = {
  id: string;
  userId: string;
  status: ComposioAccountStatus;
  toolkit: string;
  authConfigId: string | null;
  /** True when Composio switched the account off. */
  disabled: boolean;
};

export type ComposioProxyRequest = {
  connectedAccountId: string;
  /** An absolute address at the toolkit's own API. */
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  parameters?: { name: string; value: string; type: 'header' | 'query' }[];
};

export type ComposioProxyAnswer = {
  /** The status the toolkit's API answered with. */
  status: number;
  data: unknown;
  headers: Record<string, string>;
};

export type ComposioOptions = {
  apiKey: string;
  /** `https://backend.composio.dev` unless replaced. */
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const API = '/api/v3.1';
const DEFAULT_TIMEOUT_MS = 20_000;
/** Account and link answers are small. */
const SMALL_ANSWER_BYTES = 64 * 1024;
/**
 * A proxied answer carries the toolkit's own JSON inside Composio's. The
 * largest Melete asks for is one raw message (256 KiB, base64url in JSON).
 */
export const PROXY_ANSWER_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function secondsOf(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export class ComposioClient {
  private readonly fetcher: typeof fetch;
  private readonly base: string;
  /** The managed auth config found or made for each toolkit, once per process. */
  private readonly configs = new Map<string, Promise<string>>();

  constructor(private readonly options: ComposioOptions) {
    this.fetcher = options.fetch ?? fetch;
    const url = new URL(options.baseUrl);
    if (url.username || url.password || !['https:', 'http:'].includes(url.protocol))
      throw new Error('COMPOSIO_BASE_URL must be an http(s) address without credentials');
    this.base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  }

  /** One call; a fault for anything but a 2xx, with no body read into it. */
  private async call(
    method: string,
    path: string,
    init: { body?: unknown; query?: URLSearchParams; limit?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const url = `${this.base}${API}${path}${init.query ? `?${init.query}` : ''}`;
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          accept: 'application/json',
          'x-api-key': this.options.apiKey,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        redirect: 'error',
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
    } catch {
      throw new ComposioFault('unavailable');
    }
    if (response.ok) {
      try {
        return await boundedJson(response, init.limit ?? SMALL_ANSWER_BYTES);
      } catch (error) {
        if (error instanceof ResponseTooLarge) throw new ComposioFault('invalid_answer', 200);
        throw new ComposioFault('invalid_answer', response.status);
      }
    }
    // Only the error's fixed slug is kept from the body, never its message.
    const retryAfter = secondsOf(response.headers.get('retry-after'));
    const body = (await boundedJson(response, SMALL_ANSWER_BYTES).catch(() => null)) as {
      error?: { slug?: unknown };
    } | null;
    const rawSlug = text(body?.error?.slug);
    const slug = rawSlug && /^[A-Za-z0-9_.-]{1,80}$/.test(rawSlug) ? rawSlug : null;
    const status = response.status;
    if (status === 401) throw new ComposioFault('key_refused', status, slug);
    if (status === 403) throw new ComposioFault('key_refused', status, slug);
    if (status === 429) throw new ComposioFault('rate_limited', status, slug, retryAfter);
    if (status === 404 || status === 410)
      throw new ComposioFault('account_unavailable', status, slug);
    if (status >= 500) throw new ComposioFault('unavailable', status, slug, retryAfter);
    // Composio names an account it will not act for in its slug.
    if (slug && /connected.?account|inactive|expired|revoked|disabled/i.test(slug))
      throw new ComposioFault('account_unavailable', status, slug);
    throw new ComposioFault('refused', status, slug);
  }

  /**
   * Start a sign-in: the browser goes to `redirectUrl`, and Composio sends it
   * back to `callbackUrl` with `status` and `connected_account_id` added.
   */
  async link(input: { authConfigId: string; userId: string; callbackUrl: string }): Promise<{
    redirectUrl: string;
    connectedAccountId: string;
    expiresAt: string | null;
  }> {
    const answer = (await this.call('POST', '/connected_accounts/link', {
      body: {
        auth_config_id: input.authConfigId,
        user_id: input.userId,
        callback_url: input.callbackUrl,
      },
    })) as Record<string, unknown> | null;
    const redirectUrl = text(answer?.redirect_url);
    const connectedAccountId = text(answer?.connected_account_id);
    if (
      !redirectUrl ||
      !URL.canParse(redirectUrl) ||
      !['https:', 'http:'].includes(new URL(redirectUrl).protocol) ||
      !connectedAccountId ||
      !ID.test(connectedAccountId)
    )
      throw new ComposioFault('invalid_answer');
    return { redirectUrl, connectedAccountId, expiresAt: text(answer?.expires_at) };
  }

  /** A connected account as Composio holds it now. */
  async account(id: string, signal?: AbortSignal): Promise<ComposioAccount> {
    if (!ID.test(id)) throw new ComposioFault('account_unavailable');
    const answer = (await this.call('GET', `/connected_accounts/${id}`, {
      ...(signal ? { signal } : {}),
    })) as Record<string, unknown> | null;
    const toolkit = text((answer?.toolkit as { slug?: unknown } | undefined)?.slug);
    const status = text(answer?.status);
    const userId = text(answer?.user_id);
    const accountId = text(answer?.id);
    if (!toolkit || !status || userId === null || accountId !== id)
      throw new ComposioFault('invalid_answer');
    return {
      id: accountId,
      userId,
      status,
      toolkit,
      authConfigId: text((answer?.auth_config as { id?: unknown } | undefined)?.id),
      disabled: answer?.is_disabled === true,
    };
  }

  /**
   * Take the account away for good: its grant is revoked at the provider
   * where Composio can, then the account is deleted. One already gone is
   * taken as removed.
   */
  async removeAccount(id: string): Promise<void> {
    if (!ID.test(id)) return;
    try {
      await this.call('POST', `/connected_accounts/${id}/revoke`, { body: {} });
    } catch (error) {
      // A toolkit with nothing to revoke, or an account already gone, still gets deleted.
      if (!(error instanceof ComposioFault) || error.kind === 'key_refused') throw error;
    }
    try {
      await this.call('DELETE', `/connected_accounts/${id}`);
    } catch (error) {
      if (error instanceof ComposioFault && error.kind === 'account_unavailable') return;
      throw error;
    }
  }

  /** One request to the toolkit's own API, signed by Composio for the account. */
  async proxy(request: ComposioProxyRequest, signal?: AbortSignal): Promise<ComposioProxyAnswer> {
    if (!ID.test(request.connectedAccountId)) throw new ComposioFault('account_unavailable');
    const answer = (await this.call('POST', '/tools/execute/proxy', {
      body: {
        connected_account_id: request.connectedAccountId,
        endpoint: request.endpoint,
        method: request.method,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(request.parameters?.length ? { parameters: request.parameters } : {}),
      },
      limit: PROXY_ANSWER_BYTES,
      ...(signal ? { signal } : {}),
    })) as Record<string, unknown> | null;
    const status = answer?.status;
    if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599)
      throw new ComposioFault('invalid_answer');
    const headers: Record<string, string> = {};
    const raw = answer?.headers;
    if (raw && typeof raw === 'object' && !Array.isArray(raw))
      for (const [name, value] of Object.entries(raw))
        if (typeof value === 'string') headers[name.toLowerCase()] = value;
    return { status, data: answer?.data ?? null, headers };
  }

  /**
   * The auth config a toolkit signs in with: the one the operator named, or
   * the project's Composio-managed one, made when there is none.
   */
  authConfig(toolkit: ComposioToolkit, configured?: string): Promise<string> {
    if (configured) return Promise.resolve(configured);
    let found = this.configs.get(toolkit);
    if (!found) {
      found = this.findOrMakeConfig(toolkit);
      // A failure is asked again next time rather than remembered.
      found.catch(() => this.configs.delete(toolkit));
      this.configs.set(toolkit, found);
    }
    return found;
  }

  private async findOrMakeConfig(toolkit: ComposioToolkit): Promise<string> {
    const listed = (await this.call('GET', '/auth_configs', {
      query: new URLSearchParams({
        toolkit_slug: toolkit,
        is_composio_managed: 'true',
        limit: '50',
      }),
    })) as { items?: unknown } | null;
    const items = Array.isArray(listed?.items) ? listed.items : [];
    for (const item of items as Record<string, unknown>[]) {
      const id = text(item.id);
      const slug = text((item.toolkit as { slug?: unknown } | undefined)?.slug);
      if (
        id &&
        ID.test(id) &&
        slug === toolkit &&
        item.is_composio_managed === true &&
        item.status !== 'DISABLED'
      )
        return id;
    }
    const made = (await this.call('POST', '/auth_configs', {
      body: { toolkit: { slug: toolkit }, auth_config: { type: 'use_composio_managed_auth' } },
    })) as { auth_config?: { id?: unknown } } | null;
    const id = text(made?.auth_config?.id);
    if (!id || !ID.test(id)) throw new ComposioFault('invalid_answer');
    return id;
  }
}
