/**
 * A loopback stand-in for Composio's REST API (v3.1), for tests only: auth
 * configs, sign-in links with a consent page that stands in for the person,
 * connected accounts, and proxy execute. A proxied request is answered by the
 * account's upstream, which is usually `fake-google.ts`: the real Google
 * address is mapped onto the fake's own, and its access token added, as
 * Composio adds the account's token. No real service is ever contacted.
 */
import { randomBytes } from 'node:crypto';
import type { FakeGoogle } from './fake-google.ts';

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
  /** Every proxied request: the account, method and address it asked for. */
  proxyCalls: { account: string; method: string; endpoint: string }[];
  /** Accounts revoked and deleted, in order. */
  removed: string[];
  /** Who the next sign-in links to; set before the consent page is opened. */
  signInAs(upstream: Upstream): void;
  /** Answer the next consent pages as declined. */
  decline: boolean;
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
    removed: [] as string[],
    next: options.upstream ?? null,
    decline: false,
  };
  const error = (status: number, slug: string) =>
    Response.json({ error: { message: 'refused', code: status, slug, status } }, { status });

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
        account.status = 'REVOKED';
        return Response.json({ success: true });
      }
      const one = /^\/connected_accounts\/([^/]+)$/.exec(rest);
      if (one) {
        const account = accounts.get(one[1] ?? '');
        if (!account) return error(404, 'ConnectedAccount_NotFound');
        if (request.method === 'DELETE') {
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
    stop: async () => {
      await server.stop(true);
    },
  };
}
