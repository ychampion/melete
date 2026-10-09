/**
 * The connector catalog and its sign-ins, as the mock plays them. Starting a
 * sign-in answers with an address on the mock itself that stands in for the
 * app's consent page; opening it approves the sign-in, and the next status
 * read connects the app with the tools its catalog entry names.
 */
import {
  ACCOUNT_CATALOG,
  accountSignInRequest,
  accountSignInStart,
  accountSignInStatus,
  asksFirst,
  CONNECTION_KIND_DESCRIPTORS,
  type ConnectionCatalogEntry,
  type ConnectionKindDescriptor,
  connectionKindListResponse,
  ID_PREFIXES,
  MCP_CATALOG,
  type McpCatalogEntry,
  managedSignInRequest,
  managedSignInStart,
  mcpCatalogConfig,
  mcpCatalogEntry,
  mcpConnectedClientList,
  mcpSignInRequest,
  mcpSignInStart,
  mcpSignInStatus,
} from '@melete/contracts';
import type { Hono } from 'hono';
import { newId, type Store } from './store.ts';

const COVERS: Record<ConnectionKindDescriptor['kind'], ConnectionCatalogEntry['covers'][number]> = {
  mail: 'mail',
  caldav: 'calendar',
  ics: 'calendar',
  mcp: 'tools',
  mcp_stdio: 'tools',
  sandbox: 'execution',
  command_line: 'execution',
};

/** What the service's catalog says about a Google sign-in through Composio. */
const COMPOSIO_NOTE =
  'Composio handles this sign-in and keeps the Google access. Your mail, calendar and Drive reach Melete through Composio.';

/** Everything the mock offers to connect: account sign-ins, catalog apps, then forms. */
export function mockCatalog(options: { composio?: boolean } = {}): ConnectionCatalogEntry[] {
  return [
    ...ACCOUNT_CATALOG.map(
      (entry): ConnectionCatalogEntry =>
        options.composio && entry.provider === 'google'
          ? {
              id: entry.id,
              title: entry.title,
              description: entry.description,
              covers: [...entry.covers],
              connect: {
                method: 'managed_sign_in',
                provider: 'google',
                via: 'composio',
                start: '/managed-sign-ins',
                note: COMPOSIO_NOTE,
              },
              available: true,
            }
          : {
              id: entry.id,
              title: entry.title,
              description: entry.description,
              covers: [...entry.covers],
              connect: {
                method: 'sign_in',
                provider: entry.provider,
                start: `/${entry.provider}-sign-ins`,
                issuer: entry.issuer,
                scopes: entry.scopes.map((scope) => ({ ...scope })),
              },
              available: true,
            },
    ),
    ...MCP_CATALOG.map(
      (entry): ConnectionCatalogEntry => ({
        id: entry.id,
        title: entry.title,
        description: entry.description,
        covers: ['tools'],
        connect: {
          method: 'mcp_sign_in',
          url: entry.url,
          suggested_id: entry.id,
          start: '/mcp-sign-ins',
          tools: entry.tools.map((tool) => ({
            label: tool.label,
            effect_class: tool.effect_class,
            asks_first: asksFirst(tool.effect_class),
          })),
        },
        available: true,
        ...(entry.warning ? { warning: entry.warning } : {}),
      }),
    ),
    ...CONNECTION_KIND_DESCRIPTORS.map(
      (kind): ConnectionCatalogEntry => ({
        id: kind.id,
        title: kind.title,
        description: kind.description,
        covers: [COVERS[kind.kind]],
        connect: { method: 'form', kind_id: kind.id },
        available: true,
      }),
    ),
  ];
}

/** Adds a catalog app's connection the way the service installs one, and remembers which app it is. */
export function addCatalogConnection(
  store: Store,
  spaceId: string,
  entry: McpCatalogEntry,
  health: 'ok' | 'failing' = 'ok',
): string {
  const id = newId(ID_PREFIXES.connection);
  const now = store.now().toISOString();
  store.connections.set(id, {
    id,
    space_id: spaceId,
    provider: 'mcp',
    label: entry.title,
    secret_ref: newId(ID_PREFIXES.secret),
    scopes: mcpCatalogConfig(entry, entry.url).allowed_scopes,
    status: 'active',
    health,
    setup_state: 'connected',
    generation: 0,
    last_checked_at: now,
    created_at: now,
  });
  store.connectionCatalog.set(id, entry.id);
  return id;
}

type Pending = {
  spaceId: string;
  /** A catalog app's id, or an account provider. */
  what: { catalog: McpCatalogEntry } | { account: 'google' | 'microsoft' };
  approved: boolean;
  connected?: string[];
  expiresAt: number;
};

export function mountMockSignIns(
  app: Hono,
  store: Store,
  spaceId: string,
  options: { composio?: boolean } = {},
) {
  const pending = new Map<string, Pending>();
  const origin = (url: string) => new URL(url).origin;

  app.get('/connection-kinds', () =>
    Response.json(
      connectionKindListResponse.parse({
        kinds: CONNECTION_KIND_DESCRIPTORS,
        catalog: mockCatalog(options),
      }),
    ),
  );

  const begin = (what: Pending['what'], space: string) => {
    const id = newId('signin');
    const expiresAt = store.now().getTime() + 15 * 60_000;
    pending.set(id, { spaceId: space, what, approved: false, expiresAt });
    return { id, expires_at: new Date(expiresAt).toISOString() };
  };

  /** Connects what an approved sign-in was for, once. */
  const finish = (entry: Pending): string[] => {
    if (entry.connected) return entry.connected;
    if ('catalog' in entry.what)
      entry.connected = [addCatalogConnection(store, entry.spaceId, entry.what.catalog)];
    else {
      const now = store.now().toISOString();
      const names =
        entry.what.account === 'google'
          ? (['Gmail', 'Google Calendar'] as const)
          : (['Outlook', 'Outlook Calendar'] as const);
      entry.connected = (['imap', 'caldav'] as const).map((provider, index) => {
        const id = newId(ID_PREFIXES.connection);
        store.connections.set(id, {
          id,
          space_id: entry.spaceId,
          provider,
          label: names[index] ?? provider,
          secret_ref: newId(ID_PREFIXES.secret),
          scopes:
            provider === 'imap'
              ? ['email.search', 'email.read', 'email.draft', 'email.send']
              : ['calendar.list', 'calendar.create'],
          status: 'active',
          health: 'ok',
          setup_state: 'connected',
          generation: 0,
          last_checked_at: now,
          created_at: now,
        });
        return id;
      });
    }
    return entry.connected;
  };

  const status = (id: string) => {
    const entry = pending.get(id);
    if (!entry) return null;
    if (!entry.approved) return { state: 'pending' as const, entry };
    return { state: 'connected' as const, entry, ids: finish(entry) };
  };

  app.post('/mcp-sign-ins', async (c) => {
    const parsed = mcpSignInRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || !('catalog_id' in parsed.data))
      return Response.json(
        { error: { code: 'invalid_request', message: 'The mock connects catalog apps only.' } },
        { status: 400 },
      );
    const entry = mcpCatalogEntry(parsed.data.catalog_id);
    if (!entry)
      return Response.json(
        { error: { code: 'catalog_unknown', message: 'There is no app by that name to connect.' } },
        { status: 404 },
      );
    const started = begin({ catalog: entry }, parsed.data.space_id ?? spaceId);
    return Response.json(
      mcpSignInStart.parse({
        sign_in_id: started.id,
        authorize_url: `${origin(c.req.url)}/mock-consent/${started.id}`,
        redirect_uri: `${origin(c.req.url)}/oauth/callback`,
        expires_at: started.expires_at,
        issuer: origin(entry.url),
        scopes: [],
      }),
      { status: 201 },
    );
  });

  app.get('/mcp-sign-ins/:id', (c) => {
    const found = status(c.req.param('id'));
    if (!found)
      return Response.json(
        { error: { code: 'not_found', message: 'No sign-in by that id.' } },
        { status: 404 },
      );
    return Response.json(
      mcpSignInStatus.parse(
        found.state === 'pending'
          ? { state: 'pending', expires_at: new Date(found.entry.expiresAt).toISOString() }
          : { state: 'connected', connection_id: found.ids[0] },
      ),
    );
  });

  for (const account of ['google', 'microsoft'] as const) {
    const entry = ACCOUNT_CATALOG.find((item) => item.provider === account);
    app.post(`/${account}-sign-ins`, async (c) => {
      const parsed = accountSignInRequest.safeParse(await c.req.json().catch(() => ({})));
      const started = begin({ account }, (parsed.success && parsed.data.space_id) || spaceId);
      return Response.json(
        accountSignInStart.parse({
          sign_in_id: started.id,
          authorize_url: `${origin(c.req.url)}/mock-consent/${started.id}`,
          redirect_uri: `${origin(c.req.url)}/oauth/${account}/callback`,
          expires_at: started.expires_at,
          issuer: entry?.issuer,
          scopes: entry?.scopes.map((scope) => ({ ...scope })) ?? [],
        }),
        { status: 201 },
      );
    });
    app.get(`/${account}-sign-ins/:id`, (c) => {
      const found = status(c.req.param('id'));
      if (!found)
        return Response.json(
          { error: { code: 'not_found', message: 'No sign-in by that id.' } },
          { status: 404 },
        );
      return Response.json(
        accountSignInStatus.parse(
          found.state === 'pending'
            ? { state: 'pending', expires_at: new Date(found.entry.expiresAt).toISOString() }
            : { state: 'connected', connection_ids: found.ids },
        ),
      );
    });
  }

  // Google through Composio: one consent page stands in for both of its pages.
  app.post('/managed-sign-ins', async (c) => {
    const parsed = managedSignInRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      return Response.json(
        { error: { code: 'invalid_request', message: 'Name the provider.' } },
        { status: 400 },
      );
    const started = begin({ account: 'google' }, parsed.data.space_id ?? spaceId);
    return Response.json(
      managedSignInStart.parse({
        sign_in_id: started.id,
        authorize_url: `${origin(c.req.url)}/mock-consent/${started.id}`,
        expires_at: started.expires_at,
        issuer: origin(c.req.url),
        via: 'composio',
        connects: parsed.data.documents ? ['documents'] : ['mail', 'calendar'],
      }),
      { status: 201 },
    );
  });
  app.get('/managed-sign-ins/:id', (c) => {
    const found = status(c.req.param('id'));
    if (!found)
      return Response.json(
        { error: { code: 'not_found', message: 'No sign-in by that id.' } },
        { status: 404 },
      );
    return Response.json(
      accountSignInStatus.parse(
        found.state === 'pending'
          ? { state: 'pending', expires_at: new Date(found.entry.expiresAt).toISOString() }
          : { state: 'connected', connection_ids: found.ids },
      ),
    );
  });

  // The mock has no assistants of its own connected; Settings lists none.
  app.get('/mcp/clients', () => Response.json(mcpConnectedClientList.parse({ clients: [] })));

  // Stands in for the app's consent page: opening it is the person approving.
  app.get('/mock-consent/:id', (c) => {
    const entry = pending.get(c.req.param('id'));
    if (entry) entry.approved = true;
    const title = entry
      ? 'catalog' in entry.what
        ? entry.what.catalog.title
        : entry.what.account === 'google'
          ? 'Google'
          : 'Microsoft'
      : '';
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${entry ? 'Connected' : 'Not found'}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${entry ? `${title} is connected` : 'That sign-in has expired'}</h1><p>You can close this tab.</p></body></html>`,
      entry ? 200 : 404,
    );
  });
}
