/**
 * A small client for Composio's REST API (v3.1), for the calls Melete makes
 * there: start a sign-in link, read and remove a connected account, find or
 * make an auth config, list toolkits and their tools, open a tool router
 * session and run one tool in it, read the project's own usage numbers, and
 * keep the trigger instances that tell Melete when an account changed.
 *
 * Tools run only inside a session (`/tool_router/session/{id}/execute`), which
 * Composio counts as one plain tool call. Nothing here sends a proxied
 * request, runs Composio's sandbox or uses its paid instant tools: a session is
 * opened with each of those switched off.
 *
 * The project key travels in the `x-api-key` header and nowhere else. No
 * request or answer body is ever logged or put in an error: a failure is a
 * `ComposioFault` with a fixed kind, the HTTP status and Composio's own error
 * slug when it gave one. Every call has a deadline and every answer a size
 * limit.
 */
import { boundedJson, ResponseTooLarge } from './signed-in.ts';

/** The Google toolkits Melete's own mail, calendar and Drive connectors run through. */
export const COMPOSIO_TOOLKITS = ['gmail', 'googlecalendar', 'googledrive'] as const;
export type ComposioToolkit = (typeof COMPOSIO_TOOLKITS)[number];

/** A toolkit's slug at Composio. */
export const TOOLKIT_SLUG = /^[a-z0-9][a-z0-9_]{0,63}$/;
/** A tool's slug at Composio. */
export const TOOL_SLUG = /^[A-Z0-9][A-Z0-9_]{0,127}$/;
/** Composio's own meta and helper tools, and its own toolkits: never run, never offered. */
export const COMPOSIO_OWN_TOOL = /^COMPOSIO_/;
export const COMPOSIO_OWN_TOOLKIT = /^composio/;

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
  /** The answer was not the shape the API documents. */
  | 'invalid_answer'
  /** The answer was larger than the call allows. */
  | 'too_large';

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

  /**
   * Whether the request may have been carried out: anything but an answer
   * Composio gave before doing anything (a 4xx). A request that timed out, or
   * whose answer was lost or unreadable, may have run, and is counted as run.
   */
  get mayHaveRun(): boolean {
    // Refused here, before any request was sent.
    if (this.kind === 'refused' && this.status === null) return false;
    return this.status === null || this.status >= 500 || (this.status >= 200 && this.status < 300);
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

/** One toolkit as the catalog shows it. */
export type ComposioToolkitInfo = {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  /** Whether Composio offers its own sign-in for it, so no OAuth app of the operator's is needed. */
  managedAuth: boolean;
  /** Whether it needs no sign-in at all. */
  noAuth: boolean;
  categories: string[];
};

/** One tool of a toolkit, with what the model needs to call it. */
export type ComposioToolInfo = {
  slug: string;
  toolkit: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Composio marks the tool as only reading. */
  readOnly: boolean;
  /** Composio marks the tool as destroying something. */
  destructive: boolean;
};

/** What running one tool came back with. */
export type ComposioToolResult = {
  /** The tool ran and succeeded. */
  ok: boolean;
  data: unknown;
  /** The tool's own error message, when it failed. Shown to the agent, never logged. */
  error: string | null;
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
/** A list of toolkits or tools carries schemas: larger, still bounded. */
const LIST_ANSWER_BYTES = 8 * 1024 * 1024;
/**
 * A tool's answer carries the app's own JSON inside Composio's. The largest a
 * connector reads is a page of calendar events or Drive changes (2 MiB); this
 * leaves room for Composio's wrapping, and each connector then holds the
 * answer to its own limit.
 */
export const TOOL_ANSWER_BYTES = 4 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function secondsOf(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

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
        if (error instanceof ResponseTooLarge) throw new ComposioFault('too_large', 200);
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
    if (
      slug &&
      /connected.?account|no.?active.?connection|inactive|expired|revoked|disabled/i.test(slug)
    )
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
    const answer = record(
      await this.call('POST', '/connected_accounts/link', {
        body: {
          auth_config_id: input.authConfigId,
          user_id: input.userId,
          callback_url: input.callbackUrl,
        },
      }),
    );
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
    const answer = record(
      await this.call('GET', `/connected_accounts/${id}`, { ...(signal ? { signal } : {}) }),
    );
    const toolkit = text(record(answer?.toolkit)?.slug);
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
      authConfigId: text(record(answer?.auth_config)?.id),
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

  /**
   * Open a tool router session for one connected account and its toolkit.
   * Everything that could cost more than a plain tool call is switched off:
   * Composio's sandbox (workbench), proxied requests, instant tools, and the
   * session's own connection manager. Sessions themselves are free.
   */
  async openSession(input: {
    userId: string;
    toolkit: string;
    connectedAccountId: string;
    signal?: AbortSignal;
  }): Promise<string> {
    if (!TOOLKIT_SLUG.test(input.toolkit) || !ID.test(input.connectedAccountId))
      throw new ComposioFault('refused');
    const answer = record(
      await this.call('POST', '/tool_router/session', {
        body: {
          user_id: input.userId,
          toolkits: { enable: [input.toolkit] },
          connected_accounts: { [input.toolkit]: [input.connectedAccountId] },
          manage_connections: { enable: false },
          workbench: { enable: false },
          proxy_execute: { enable: false },
          instant: false,
          search: { enable: false },
        },
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );
    const id = text(answer?.session_id);
    if (!id || !ID.test(id)) throw new ComposioFault('invalid_answer');
    return id;
  }

  /** Close a session; one already gone is taken as closed. */
  async closeSession(id: string): Promise<void> {
    if (!ID.test(id)) return;
    try {
      await this.call('DELETE', `/tool_router/session/${id}`);
    } catch (error) {
      if (error instanceof ComposioFault && error.kind === 'account_unavailable') return;
      throw error;
    }
  }

  /** Run one tool in a session. One call Composio counts as one tool call. */
  async execute(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ComposioToolResult> {
    // Composio's own tools (`COMPOSIO_MULTI_EXECUTE_TOOL`, the workbench, ...) run
    // in a session too, and one of them can make several billed calls; only an
    // app's own tool is ever run.
    if (!ID.test(sessionId) || !TOOL_SLUG.test(tool) || COMPOSIO_OWN_TOOL.test(tool))
      throw new ComposioFault('refused');
    const answer = record(
      await this.call('POST', `/tool_router/session/${sessionId}/execute`, {
        body: { tool_slug: tool, arguments: args },
        limit: TOOL_ANSWER_BYTES,
        ...(signal ? { signal } : {}),
      }),
    );
    if (!answer) throw new ComposioFault('invalid_answer', 200);
    const kind = text(answer.result_type);
    const error = text(answer.error);
    // A session that would ask the person first is never opened; such an answer is a failure.
    const ok = kind === 'completed' || (kind === null && !error && answer.successful !== false);
    return { ok, data: answer.data ?? null, error: ok ? null : (error ?? 'tool_failed') };
  }

  /** Toolkits, a page at a time; `search` matches a name, slug or description. */
  async toolkits(
    input: { search?: string; cursor?: string; limit?: number } = {},
  ): Promise<{ items: ComposioToolkitInfo[]; next: string | null }> {
    const query = new URLSearchParams({ limit: String(input.limit ?? 50), sort_by: 'usage' });
    if (input.search) query.set('search', input.search.slice(0, 120));
    if (input.cursor) query.set('cursor', input.cursor);
    const answer = record(await this.call('GET', '/toolkits', { query, limit: LIST_ANSWER_BYTES }));
    const items: ComposioToolkitInfo[] = [];
    for (const raw of Array.isArray(answer?.items) ? answer.items : []) {
      const item = record(raw);
      const slug = text(item?.slug);
      const name = text(item?.name);
      if (!item || !slug || !TOOLKIT_SLUG.test(slug) || !name) continue;
      const meta = record(item.meta);
      const managed = Array.isArray(item.composio_managed_auth_schemes)
        ? item.composio_managed_auth_schemes
        : [];
      const logo = text(meta?.logo);
      items.push({
        slug,
        name: name.slice(0, 80),
        description: (text(meta?.description) ?? '').slice(0, 400),
        logo: logo && /^https:\/\//.test(logo) ? logo : null,
        managedAuth: managed.length > 0,
        noAuth: item.no_auth === true,
        categories: (Array.isArray(meta?.categories) ? meta.categories : [])
          .map((category) => text(record(category)?.name))
          .filter((name): name is string => Boolean(name))
          .slice(0, 5),
      });
    }
    const next = text(answer?.next_cursor);
    return { items, next: next && next.length <= 512 ? next : null };
  }

  /**
   * Tools of one toolkit: the ones `slugs` names, or those matching `query`.
   * A listing, not a tool call: Composio does not count it.
   */
  async tools(input: {
    toolkit: string;
    query?: string;
    slugs?: readonly string[];
    limit?: number;
    signal?: AbortSignal;
  }): Promise<ComposioToolInfo[]> {
    if (!TOOLKIT_SLUG.test(input.toolkit)) throw new ComposioFault('refused');
    const query = new URLSearchParams({
      toolkit_slug: input.toolkit,
      limit: String(input.limit ?? 10),
    });
    if (input.slugs?.length) query.set('tool_slugs', input.slugs.join(','));
    else if (input.query) query.set('query', input.query.slice(0, 200));
    const answer = record(
      await this.call('GET', '/tools', {
        query,
        limit: LIST_ANSWER_BYTES,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );
    const tools: ComposioToolInfo[] = [];
    for (const raw of Array.isArray(answer?.items) ? answer.items : []) {
      const item = record(raw);
      const slug = text(item?.slug);
      const toolkit = text(record(item?.toolkit)?.slug) ?? input.toolkit;
      if (!item || !slug || !TOOL_SLUG.test(slug) || toolkit !== input.toolkit) continue;
      const tags = (Array.isArray(item.tags) ? item.tags : []).filter(
        (tag): tag is string => typeof tag === 'string',
      );
      tools.push({
        slug,
        toolkit,
        name: (text(item.name) ?? slug).slice(0, 120),
        description: (text(item.description) ?? '').slice(0, 1000),
        inputSchema: record(item.input_parameters) ?? { type: 'object', properties: {} },
        readOnly: tags.includes('readOnlyHint'),
        destructive: tags.includes('destructiveHint'),
      });
    }
    return tools;
  }

  /**
   * The project's own usage over a window, by Composio's metering entity
   * (`tool_calls`, `sessions`, ...). Composio marks this as experimental; an
   * answer it cannot read is a fault, never a zero.
   */
  async usage(from: number, to: number): Promise<Record<string, number>> {
    const answer = record(
      await this.call('POST', '/project/usage/summary', { body: { from, to } }),
    );
    const entities = record(answer?.entities);
    if (!entities) throw new ComposioFault('invalid_answer', 200);
    const totals: Record<string, number> = {};
    for (const [name, raw] of Object.entries(entities)) {
      const entity = record(raw);
      const quantity = Number(text(entity?.total_quantity) ?? entity?.event_count);
      if (/^[a-z_]{1,64}$/.test(name) && Number.isFinite(quantity) && quantity >= 0)
        totals[name] = Math.ceil(quantity);
    }
    return totals;
  }

  /** Make (or keep) a trigger instance for one connected account; its id. */
  async upsertTrigger(
    slug: string,
    input: { connectedAccountId: string; config: Record<string, unknown> },
  ): Promise<string> {
    if (!TOOL_SLUG.test(slug) || !ID.test(input.connectedAccountId))
      throw new ComposioFault('refused');
    const answer = record(
      await this.call('POST', `/trigger_instances/${slug}/upsert`, {
        body: { connected_account_id: input.connectedAccountId, trigger_config: input.config },
      }),
    );
    const id = text(answer?.trigger_id);
    if (!id || !ID.test(id)) throw new ComposioFault('invalid_answer');
    return id;
  }

  /** Switch a trigger instance on or off; off, it sends no more events. */
  async setTrigger(id: string, status: 'enable' | 'disable'): Promise<void> {
    if (!ID.test(id)) throw new ComposioFault('refused');
    await this.call('PATCH', `/trigger_instances/manage/${id}`, { body: { status } });
  }

  /** Delete a trigger instance; one already gone is taken as deleted. */
  async deleteTrigger(id: string): Promise<void> {
    if (!ID.test(id)) return;
    try {
      await this.call('DELETE', `/trigger_instances/manage/${id}`);
    } catch (error) {
      if (error instanceof ComposioFault && error.kind === 'account_unavailable') return;
      throw error;
    }
  }

  /**
   * The auth config a toolkit signs in with: the one the operator named, or
   * the project's Composio-managed one, made when there is none.
   */
  authConfig(toolkit: string, configured?: string): Promise<string> {
    if (configured) return Promise.resolve(configured);
    if (!TOOLKIT_SLUG.test(toolkit)) return Promise.reject(new ComposioFault('refused'));
    let found = this.configs.get(toolkit);
    if (!found) {
      found = this.findOrMakeConfig(toolkit);
      // A failure is asked again next time rather than remembered.
      found.catch(() => this.configs.delete(toolkit));
      this.configs.set(toolkit, found);
    }
    return found;
  }

  private async findOrMakeConfig(toolkit: string): Promise<string> {
    const listed = record(
      await this.call('GET', '/auth_configs', {
        query: new URLSearchParams({
          toolkit_slug: toolkit,
          is_composio_managed: 'true',
          limit: '50',
        }),
      }),
    );
    const items = Array.isArray(listed?.items) ? listed.items : [];
    for (const raw of items) {
      const item = record(raw);
      const id = text(item?.id);
      const slug = text(record(item?.toolkit)?.slug);
      if (
        item &&
        id &&
        ID.test(id) &&
        slug === toolkit &&
        item.is_composio_managed === true &&
        item.status !== 'DISABLED'
      )
        return id;
    }
    const made = record(
      await this.call('POST', '/auth_configs', {
        body: { toolkit: { slug: toolkit }, auth_config: { type: 'use_composio_managed_auth' } },
      }),
    );
    const id = text(record(made?.auth_config)?.id);
    if (!id || !ID.test(id)) throw new ComposioFault('invalid_answer');
    return id;
  }
}
