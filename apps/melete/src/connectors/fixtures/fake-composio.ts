/**
 * A loopback stand-in for Composio's REST API (v3.1), for tests only: auth
 * configs, sign-in links with a consent page that stands in for the person,
 * connected accounts, tool router sessions and their tool runs, the toolkit
 * and tool catalog, usage, and trigger instances. Google's tools are answered
 * by the account's upstream, which is usually `fake-google.ts`: each tool is
 * the Google API request it stands for, sent to the fake's own address with
 * its access token, as Composio sends it with the account's token. Answers
 * take the shapes Composio's tool schemas give. Proxy execute is still served,
 * only so a test can see that nothing uses it. No real service is contacted.
 */
import { randomBytes } from 'node:crypto';
import { addGoogleTools, type ToolAnswer } from './fake-composio-tools.ts';
import type { FakeGoogle } from './fake-google.ts';

/** One tool of a fake app: what the catalog says of it, and how it answers. */
export type FakeAppTool = {
  slug: string;
  toolkit: string;
  description: string;
  readOnly: boolean;
  run(args: Record<string, unknown>, account: string): ToolAnswer | Promise<ToolAnswer>;
};

/** One toolkit as the fake catalog lists it. */
export type FakeToolkit = {
  slug: string;
  name: string;
  managed: boolean;
  noAuth?: boolean;
};

/** The catalog the fake starts with: managed apps, one that is not, and Google's parts. */
export const FAKE_TOOLKITS: FakeToolkit[] = [
  { slug: 'gmail', name: 'Gmail', managed: true },
  { slug: 'googlecalendar', name: 'Google Calendar', managed: true },
  { slug: 'googledrive', name: 'Google Drive', managed: true },
  { slug: 'slack', name: 'Slack', managed: true },
  { slug: 'notion', name: 'Notion', managed: true },
  { slug: 'weather_tool', name: 'Weather Tool', managed: false, noAuth: true },
  { slug: 'spotify', name: 'Spotify', managed: false },
  { slug: 'acme_crm', name: 'Acme CRM', managed: true },
];

/** Answers a request to a real API address, as that API would. */
export type Upstream = (url: URL, init: RequestInit) => Promise<Response>;

export type FakeComposioAccount = {
  id: string;
  user_id: string;
  toolkit: string;
  auth_config_id: string;
  status: string;
  is_disabled: boolean;
  callback_url: string | null;
  upstream: Upstream;
};

export type FakeComposio = {
  baseUrl: string;
  apiKey: string;
  accounts: Map<string, FakeComposioAccount>;
  authConfigs: Map<string, { id: string; toolkit: string; is_composio_managed: boolean }>;
  /** Every proxied request: the account, method and address it asked for. None is expected. */
  proxyCalls: { account: string; method: string; endpoint: string }[];
  /** Every tool run in a session: the session's account, the tool and its arguments. */
  executions: { account: string; tool: string; args: Record<string, unknown> }[];
  /** Sessions opened, by id: the user, toolkit and account each was opened for, and the whole request. */
  sessions: Map<string, { user: string; toolkit: string; account: string; request: unknown }>;
  /** Trigger instances, by id. */
  triggers: Map<string, { slug: string; account: string; config: unknown; enabled: boolean }>;
  /** What the usage summary reports, by entity. */
  usage: Record<string, number>;
  /** Tools of fake apps, by slug, beside Google's. */
  appTools: Map<string, FakeAppTool>;
  toolkits: FakeToolkit[];
  /** The next tool runs answer with this HTTP status before running, or hang until aborted. */
  failNext: Array<number | 'hang'>;
  /** Forget every session, as Composio does when one expires. */
  dropSessions(): void;
  /** Accounts revoked and deleted, in order. */
  removed: string[];
  /** Who the next sign-in links to; set before the consent page is opened. */
  signInAs(upstream: Upstream): void;
  /** Answer the next consent pages as declined. */
  decline: boolean;
  /** Accounts whose reads Composio answers with a server error, as in an outage. */
  unreadable: Set<string>;
  /** Accounts whose revoking and deleting Composio answers with a server error. */
  unremovable: Set<string>;
  stop(): Promise<void>;
};

/** Sends a real Google API address to a fake Google, with a token it accepts. */
export function googleUpstream(google: FakeGoogle): Upstream {
  const token = google.accessToken();
  const bases: [string, string][] = [
    ['https://gmail.googleapis.com/gmail/v1/users/me', google.endpoints.gmail],
    ['https://www.googleapis.com/calendar/v3/calendars/primary', google.endpoints.calendar],
    ['https://www.googleapis.com/drive/v3', google.endpoints.drive],
  ];
  return async (url, init) => {
    const address = `${url.origin}${url.pathname}`;
    const found = bases.find(([real]) => address === real || address.startsWith(`${real}/`));
    if (!found) return Response.json({ error: { code: 404 } }, { status: 404 });
    const target = new URL(`${found[1]}${address.slice(found[0].length)}${url.search}`);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    return fetch(target, { ...init, headers });
  };
}

export async function startFakeComposio(
  options: { upstream?: Upstream; apiKey?: string } = {},
): Promise<FakeComposio> {
  const apiKey = options.apiKey ?? `fake-composio-${randomBytes(8).toString('hex')}`;
  const accounts = new Map<string, FakeComposioAccount>();
  const authConfigs = new Map<
    string,
    { id: string; toolkit: string; is_composio_managed: boolean }
  >();
  const state = {
    proxyCalls: [] as FakeComposio['proxyCalls'],
    executions: [] as FakeComposio['executions'],
    removed: [] as string[],
    next: options.upstream ?? null,
    decline: false,
    unreadable: new Set<string>(),
    unremovable: new Set<string>(),
  };
  const error = (status: number, slug: string) =>
    Response.json(
      { error: { message: 'composio says no', code: status, slug, status } },
      { status },
    );

  const sessions: FakeComposio['sessions'] = new Map();
  const triggers: FakeComposio['triggers'] = new Map();
  const usage: Record<string, number> = {};
  const appTools = new Map<string, FakeAppTool>();
  const toolkits = [...FAKE_TOOLKITS];
  const failNext: FakeComposio['failNext'] = [];
  addGoogleTools(appTools, (account) => accounts.get(account)?.upstream);
  appTools.set('SLACK_LIST_CHANNELS', {
    slug: 'SLACK_LIST_CHANNELS',
    toolkit: 'slack',
    description: 'List the channels in the workspace.',
    readOnly: true,
    run: () => ({ ok: true, data: { channels: [{ id: 'C1', name: 'general' }] } }),
  });
  appTools.set('SLACK_SEND_MESSAGE', {
    slug: 'SLACK_SEND_MESSAGE',
    toolkit: 'slack',
    description: 'Send a message to a channel.',
    readOnly: false,
    run: (args) =>
      typeof args.channel === 'string'
        ? { ok: true, data: { ok: true, channel: args.channel, ts: '1700000000.000100' } }
        : { ok: false, error: 'channel is required' },
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request): Promise<Response> => {
      const url = new URL(request.url);
      const at = url.pathname;
      // Stands in for the person on the provider's consent screen.
      const consent = /^\/consent\/([^/]+)$/.exec(at);
      if (consent) {
        const account = accounts.get(consent[1] ?? '');
        if (!account?.callback_url) return new Response('not found', { status: 404 });
        account.status = state.decline ? 'FAILED' : 'ACTIVE';
        const back = new URL(account.callback_url);
        back.searchParams.set('status', state.decline ? 'failed' : 'success');
        back.searchParams.set('connected_account_id', account.id);
        return new Response(null, { status: 302, headers: { location: back.href } });
      }
      if (request.headers.get('x-api-key') !== apiKey) return error(401, 'Unauthorized');
      const api = '/api/v3.1';
      if (!at.startsWith(api)) return error(404, 'NotFound');
      const rest = at.slice(api.length);
      if (rest === '/auth_configs' && request.method === 'GET') {
        const toolkit = url.searchParams.get('toolkit_slug');
        return Response.json({
          items: [...authConfigs.values()]
            .filter((config) => !toolkit || config.toolkit === toolkit)
            .map((config) => ({
              id: config.id,
              toolkit: { slug: config.toolkit },
              is_composio_managed: config.is_composio_managed,
              status: 'ENABLED',
            })),
          next_cursor: null,
        });
      }
      if (rest === '/auth_configs' && request.method === 'POST') {
        const body = (await request.json()) as { toolkit?: { slug?: string } };
        const toolkit = body.toolkit?.slug ?? '';
        const id = `ac_${randomBytes(6).toString('hex')}`;
        authConfigs.set(id, { id, toolkit, is_composio_managed: true });
        return Response.json(
          {
            toolkit: { slug: toolkit },
            auth_config: { id, auth_scheme: 'OAUTH2', is_composio_managed: true },
          },
          { status: 201 },
        );
      }
      if (rest === '/connected_accounts/link' && request.method === 'POST') {
        const body = (await request.json()) as {
          auth_config_id?: string;
          user_id?: string;
          callback_url?: string;
        };
        const config = authConfigs.get(body.auth_config_id ?? '');
        if (!config || !body.user_id) return error(400, 'AuthConfig_NotFound');
        if (!state.next) return error(500, 'NoUpstream');
        const id = `ca_${randomBytes(6).toString('hex')}`;
        accounts.set(id, {
          id,
          user_id: body.user_id,
          toolkit: config.toolkit,
          auth_config_id: config.id,
          status: 'INITIATED',
          is_disabled: false,
          callback_url: body.callback_url ?? null,
          upstream: state.next,
        });
        return Response.json(
          {
            link_token: `lt_${id}`,
            redirect_url: `${url.origin}/consent/${id}`,
            expires_at: new Date(Date.now() + 600_000).toISOString(),
            connected_account_id: id,
          },
          { status: 201 },
        );
      }
      const revoke = /^\/connected_accounts\/([^/]+)\/revoke$/.exec(rest);
      if (revoke && request.method === 'POST') {
        const account = accounts.get(revoke[1] ?? '');
        if (!account) return error(404, 'ConnectedAccount_NotFound');
        if (state.unremovable.has(account.id)) return error(503, 'ServiceUnavailable');
        account.status = 'REVOKED';
        return Response.json({ success: true });
      }
      const one = /^\/connected_accounts\/([^/]+)$/.exec(rest);
      if (one) {
        const account = accounts.get(one[1] ?? '');
        if (!account) return error(404, 'ConnectedAccount_NotFound');
        if (request.method === 'GET' && state.unreadable.has(account.id))
          return error(503, 'ServiceUnavailable');
        if (request.method === 'DELETE') {
          if (state.unremovable.has(account.id)) return error(503, 'ServiceUnavailable');
          accounts.delete(account.id);
          state.removed.push(account.id);
          return Response.json({ success: true });
        }
        return Response.json({
          id: account.id,
          user_id: account.user_id,
          status: account.status,
          is_disabled: account.is_disabled,
          status_reason: null,
          toolkit: { slug: account.toolkit },
          auth_config: {
            id: account.auth_config_id,
            auth_scheme: 'OAUTH2',
            is_composio_managed: true,
            is_disabled: false,
          },
        });
      }
      if (rest === '/toolkits' && request.method === 'GET') {
        const search = (url.searchParams.get('search') ?? '').toLowerCase();
        const limit = Number(url.searchParams.get('limit') ?? 50);
        return Response.json({
          items: toolkits
            .filter(
              (kit) =>
                !search ||
                kit.slug.includes(search.replace(/ /g, '_')) ||
                kit.name.toLowerCase().includes(search),
            )
            .slice(0, limit)
            .map((kit) => ({
              slug: kit.slug,
              name: kit.name,
              no_auth: kit.noAuth === true,
              composio_managed_auth_schemes: kit.managed ? ['OAUTH2'] : [],
              meta: {
                description: `Everything in ${kit.name}.`,
                logo: `https://logos.example/${kit.slug}.png`,
                categories: [{ id: 'productivity', name: 'Productivity' }],
              },
            })),
          next_cursor: null,
        });
      }
      if (rest === '/tools' && request.method === 'GET') {
        const toolkit = url.searchParams.get('toolkit_slug') ?? '';
        const slugs = url.searchParams.get('tool_slugs')?.split(',') ?? null;
        const query = (url.searchParams.get('query') ?? '').toLowerCase();
        const limit = Number(url.searchParams.get('limit') ?? 10);
        const words = query.split(/\s+/).filter(Boolean);
        return Response.json({
          items: [...appTools.values()]
            .filter((tool) => tool.toolkit === toolkit)
            .filter((tool) =>
              slugs
                ? slugs.includes(tool.slug)
                : !words.length ||
                  words.some((word) =>
                    `${tool.slug} ${tool.description}`.toLowerCase().includes(word),
                  ),
            )
            .slice(0, limit)
            .map((tool) => ({
              slug: tool.slug,
              name: tool.slug,
              description: tool.description,
              toolkit: { slug: tool.toolkit },
              tags: tool.readOnly ? ['readOnlyHint'] : ['destructiveHint'],
              input_parameters: { type: 'object', properties: {} },
            })),
        });
      }
      if (rest === '/tool_router/session' && request.method === 'POST') {
        const body = (await request.json()) as {
          user_id?: string;
          toolkits?: { enable?: string[] };
          connected_accounts?: Record<string, string[]>;
          workbench?: { enable?: boolean };
          proxy_execute?: { enable?: boolean };
          manage_connections?: { enable?: boolean };
        };
        const toolkit = body.toolkits?.enable?.[0] ?? '';
        const account = body.connected_accounts?.[toolkit]?.[0] ?? '';
        // Anything beyond a plain tool call is refused here, so a test sees it asked for.
        if (
          body.workbench?.enable !== false ||
          body.proxy_execute?.enable !== false ||
          body.manage_connections?.enable !== false
        )
          return error(400, 'ToolRouter_ExtrasNotExpected');
        const id = `trs_${randomBytes(6).toString('hex')}`;
        sessions.set(id, { user: body.user_id ?? '', toolkit, account, request: body });
        usage.sessions = (usage.sessions ?? 0) + 1;
        return Response.json(
          {
            session_id: id,
            mcp: { type: 'http', url: `https://mcp.example/${id}` },
            tool_router_tools: [],
          },
          { status: 201 },
        );
      }
      const session = /^\/tool_router\/session\/([^/]+)(\/execute)?$/.exec(rest);
      if (session) {
        const found = sessions.get(session[1] ?? '');
        if (!found) return error(404, 'ToolRouterV2_SessionNotFound');
        if (request.method === 'DELETE' && !session[2]) {
          sessions.delete(session[1] ?? '');
          return Response.json({ deleted: true });
        }
        if (request.method !== 'POST' || !session[2]) return error(404, 'NotFound');
        const body = (await request.json()) as {
          tool_slug?: string;
          arguments?: Record<string, unknown>;
        };
        const account = accounts.get(found.account);
        if (!account || account.status !== 'ACTIVE' || account.is_disabled)
          return error(400, 'ToolRouterV2_NoActiveConnection');
        const fault = failNext.shift();
        if (fault === 'hang') {
          await new Promise<void>((resolve) =>
            request.signal.addEventListener('abort', () => resolve()),
          );
          return error(504, 'Timeout');
        }
        if (fault !== undefined) return error(fault, fault >= 500 ? 'ServerError' : 'BadRequest');
        const tool = appTools.get(body.tool_slug ?? '');
        if (!tool || tool.toolkit !== found.toolkit) return error(400, 'ToolRouterV2_ToolNotFound');
        const args = body.arguments ?? {};
        state.executions.push({ account: account.id, tool: tool.slug, args });
        usage.tool_calls = (usage.tool_calls ?? 0) + 1;
        const answer = await tool.run(args, account.id);
        return Response.json({
          result_type: answer.ok ? 'completed' : 'failed',
          data: answer.ok ? answer.data : {},
          error: answer.ok ? null : answer.error,
          log_id: `log_${randomBytes(4).toString('hex')}`,
        });
      }
      if (rest === '/project/usage/summary' && request.method === 'POST') {
        return Response.json({
          entities: Object.fromEntries(
            Object.entries(usage).map(([name, quantity]) => [
              name,
              { unit: 'count', total_quantity: String(quantity), event_count: quantity },
            ]),
          ),
        });
      }
      const upsert = /^\/trigger_instances\/([A-Z0-9_]+)\/upsert$/.exec(rest);
      if (upsert && request.method === 'POST') {
        const body = (await request.json()) as {
          connected_account_id?: string;
          trigger_config?: unknown;
        };
        if (!accounts.has(body.connected_account_id ?? ''))
          return error(400, 'ConnectedAccount_NotFound');
        const id = `ti_${randomBytes(6).toString('hex')}`;
        triggers.set(id, {
          slug: upsert[1] ?? '',
          account: body.connected_account_id ?? '',
          config: body.trigger_config,
          enabled: true,
        });
        return Response.json({ trigger_id: id });
      }
      const manage = /^\/trigger_instances\/manage\/([^/]+)$/.exec(rest);
      if (manage) {
        const trigger = triggers.get(manage[1] ?? '');
        if (!trigger) return error(404, 'Trigger_NotFound');
        if (request.method === 'DELETE') {
          triggers.delete(manage[1] ?? '');
          return Response.json({ deleted: true });
        }
        const body = (await request.json()) as { status?: string };
        trigger.enabled = body.status === 'enable';
        return Response.json({ status: 'success' });
      }
      if (rest === '/tools/execute/proxy' && request.method === 'POST') {
        const body = (await request.json()) as {
          connected_account_id?: string;
          endpoint?: string;
          method?: string;
          body?: unknown;
          parameters?: { name: string; value: string; type: string }[];
        };
        const account = accounts.get(body.connected_account_id ?? '');
        if (!account) return error(404, 'ConnectedAccount_NotFound');
        if (account.status !== 'ACTIVE' || account.is_disabled)
          return error(400, 'ConnectedAccount_Inactive');
        const target = new URL(body.endpoint ?? '');
        const headers = new Headers();
        for (const parameter of body.parameters ?? []) {
          if (parameter.type === 'query')
            target.searchParams.append(parameter.name, parameter.value);
          else headers.set(parameter.name, parameter.value);
        }
        const method = body.method ?? 'GET';
        state.proxyCalls.push({ account: account.id, method, endpoint: target.href });
        if (body.body !== undefined) headers.set('content-type', 'application/json');
        const answered = await account.upstream(target, {
          method,
          headers,
          ...(body.body === undefined ? {} : { body: JSON.stringify(body.body) }),
        });
        const text = await answered.text();
        let data: unknown = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = text;
        }
        const answerHeaders: Record<string, string> = {};
        answered.headers.forEach((value, name) => {
          answerHeaders[name] = value;
        });
        return Response.json({ data, status: answered.status, headers: answerHeaders });
      }
      return error(404, 'NotFound');
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiKey,
    accounts,
    authConfigs,
    get proxyCalls() {
      return state.proxyCalls;
    },
    get executions() {
      return state.executions;
    },
    sessions,
    triggers,
    usage,
    appTools,
    toolkits,
    failNext,
    dropSessions() {
      sessions.clear();
    },
    get removed() {
      return state.removed;
    },
    signInAs(upstream) {
      state.next = upstream;
    },
    get decline() {
      return state.decline;
    },
    set decline(value) {
      state.decline = value;
    },
    unreadable: state.unreadable,
    unremovable: state.unremovable,
    stop: async () => {
      await server.stop(true);
    },
  };
}
