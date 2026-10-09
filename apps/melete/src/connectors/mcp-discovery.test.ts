/**
 * Connecting apps without typing tool names, and saying what went wrong:
 * which catalog apps are ready with nothing set up, how a server added by its
 * address has its tools read and suggested, the sign-in that reads them after
 * signing in, and the words a failed connection is reported with.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  CONNECTION_CHECK_DETAIL,
  type ConnectionResponse,
  MCP_CATALOG,
  mcpDiscoveredConfig,
  mcpServerId,
  mcpToolAlias,
  suggestedEffect,
} from '@melete/contracts';
import { type FakeMcpAuth, startFakeMcpAuth } from './fixtures/fake-mcp-auth.ts';
import {
  discoverMcpServerTools,
  McpToolMissingError,
  mcpOpenFailure,
  mcpServerConfig,
  openMcpWorker,
} from './mcp.ts';
import { catalogAppMissing, RETURN_ADDRESS_MISSING } from './mcp-catalog-ready.ts';
import { McpSignInFailure } from './mcp-oauth.ts';
import { type McpSignInRequest, McpSignIns } from './mcp-sign-in.ts';

const servers: FakeMcpAuth[] = [];
const listeners: { stop(force?: boolean): unknown }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  for (const listener of listeners.splice(0)) listener.stop(true);
});

describe('which catalog apps are ready', () => {
  // Checked against each server on 2026-10-09: every one but GitHub names an
  // authorization server with a registration endpoint (RFC 7591); GitHub's
  // (github.com/login/oauth) has none.
  const registersItsOwnClients = ['notion', 'linear', 'atlassian', 'sentry', 'stripe'];

  test('an app whose server registers its own clients is ready with nothing set up', () => {
    for (const id of registersItsOwnClients) {
      const entry = MCP_CATALOG.find((item) => item.id === id);
      if (!entry) throw new Error(`${id} is missing from the catalog`);
      expect({ id, client: entry.client }).toEqual({ id, client: undefined });
      expect(catalogAppMissing(entry, 'http://localhost:3101/api/oauth/callback', false)).toBe(
        undefined,
      );
    }
  });

  test('GitHub alone waits for an app registered by whoever runs Melete, and says so plainly', () => {
    const waiting = MCP_CATALOG.filter((entry) =>
      catalogAppMissing(entry, 'https://melete.example.com/api/oauth/callback', false),
    ).map((entry) => entry.id);
    expect(waiting).toEqual(['github']);
    const github = MCP_CATALOG.find((entry) => entry.id === 'github');
    if (!github) throw new Error('GitHub is missing from the catalog');
    const missing = catalogAppMissing(
      github,
      'https://melete.example.com/api/oauth/callback',
      false,
    );
    expect(missing?.reason).toContain('only accepts apps registered with GitHub');
    expect(missing?.reason).not.toContain('GITHUB_MCP');
    // The setting is for whoever runs Melete, with the callback to register.
    expect(missing?.hint).toContain('GITHUB_MCP_CLIENT_ID and GITHUB_MCP_CLIENT_SECRET');
    expect(missing?.hint).toContain('https://melete.example.com/api/oauth/callback');
    expect(catalogAppMissing(github, 'https://melete.example.com/api/oauth/callback', true)).toBe(
      undefined,
    );
  });

  test('with nowhere for the browser to come back to, no app is ready, and the reason says why', () => {
    for (const entry of MCP_CATALOG)
      expect(catalogAppMissing(entry, null, true)?.reason).toBe(RETURN_ADDRESS_MISSING);
  });

  test('the browser returns to the public address, or else to where the person opened Melete', () => {
    const hooks = {
      authorize: async () => 'sp_fixture',
      existing: async () => {
        throw new Error('unused');
      },
      fetcherFor: async () => fetch,
      install: async () => ({}) as ConnectionResponse,
      renew: async () => ({}) as ConnectionResponse,
    };
    const configured = new McpSignIns({ ...hooks, publicUrl: 'https://melete.example.com/' });
    expect(configured.redirectUri('http://localhost:3101')).toBe(
      'https://melete.example.com/api/oauth/callback',
    );
    const unset = new McpSignIns(hooks);
    expect(unset.redirectUri()).toBeNull();
    expect(unset.redirectUri('http://127.0.0.1:13200')).toBe(
      'http://127.0.0.1:13200/api/oauth/callback',
    );
    expect(unset.redirectUri('https://melete.example.net')).toBe(
      'https://melete.example.net/api/oauth/callback',
    );
    // Plain http anywhere but this machine is not somewhere a sign-in may return.
    expect(unset.redirectUri('http://203.0.113.7:3101')).toBeNull();
    const unusable = new McpSignIns({ ...hooks, publicUrl: 'http://203.0.113.7:3101' });
    expect(unusable.redirectUri('http://localhost:3101')).toBe(
      'http://localhost:3101/api/oauth/callback',
    );
  });
});

describe('where a listed tool starts', () => {
  test('lookups read, money spends, a tool that destroys nothing is undoable, and the rest ask', () => {
    expect(suggestedEffect({ name: 'read_wiki_contents' })).toBe('read');
    expect(suggestedEffect({ name: 'list-pages' })).toBe('read');
    expect(suggestedEffect({ name: 'searchDocs' })).toBe('read');
    expect(
      suggestedEffect({ name: 'ask_wiki_question', annotations: { readOnlyHint: true } }),
    ).toBe('read');
    // A lookup's name does not outweigh a tool that says it destroys.
    expect(
      suggestedEffect({ name: 'get_and_delete', annotations: { destructiveHint: true } }),
    ).toBe('write_external');
    expect(suggestedEffect({ name: 'create_refund' })).toBe('spend');
    expect(suggestedEffect({ name: 'sendPayment' })).toBe('spend');
    expect(suggestedEffect({ name: 'save_note', annotations: { destructiveHint: false } })).toBe(
      'write_reversible',
    );
    expect(suggestedEffect({ name: 'post_message' })).toBe('write_external');
    expect(suggestedEffect({ name: 'getaway' })).toBe('write_external');
  });

  test('the person’s choices install as a valid policy, one grant per tool', () => {
    expect(mcpServerId('Deep Wiki!')).toBe('deep_wiki');
    expect(mcpToolAlias('notion-search')).toBe('notion_search');
    expect(mcpToolAlias('getJiraIssue')).toBe('get_jira_issue');
    expect(mcpToolAlias('2fa.check')).toBe('t_2fa_check');
    const config = mcpDiscoveredConfig('deepwiki', 'https://mcp.deepwiki.com/mcp', [
      { name: 'ask_wiki_question', effect_class: 'read' },
      { name: 'ask-wiki-question', effect_class: 'write_external' },
    ]);
    const { url, ...policy } = config;
    const parsed = mcpServerConfig.parse({ ...policy, endpoint: { transport: 'http', url } });
    expect(
      parsed.tools.map((tool) => [tool.alias, tool.required_scopes, tool.effect_class]),
    ).toEqual([
      ['ask_wiki_question', ['mcp_deepwiki.ask_wiki_question'], 'read'],
      ['ask_wiki_question_2', ['mcp_deepwiki.ask_wiki_question_2'], 'write_external'],
    ]);
  });
});

describe('reading a server’s tools by its address', () => {
  const tools = [
    { name: 'read_wiki_structure', description: 'List a wiki’s topics.' },
    { name: 'ask_wiki_question', annotations: { readOnlyHint: true } },
    { name: 'post_update' },
  ];

  test('a server that needs no sign-in lists its tools with their own hints', async () => {
    const server = await startFakeMcpAuth({ open: true, tools });
    servers.push(server);
    const found = await discoverMcpServerTools({ transport: 'http', url: server.mcpUrl });
    expect(found.map((tool) => [tool.name, suggestedEffect(tool)])).toEqual([
      ['read_wiki_structure', 'read'],
      ['ask_wiki_question', 'read'],
      ['post_update', 'write_external'],
    ]);
  });

  test('after signing in, the tools wait for the person, and only the ones kept are installed', async () => {
    const server = await startFakeMcpAuth({ tools });
    servers.push(server);
    const installed: (Extract<McpSignInRequest, { mcp: unknown }> & {
      credentials: Record<string, string>;
    })[] = [];
    const service = new McpSignIns({
      authorize: async (_actor, spaceId) => spaceId ?? 'sp_fixture',
      existing: async () => {
        throw new Error('unused');
      },
      fetcherFor: async () => fetch,
      discover: async (_space, url, credentials) =>
        (
          await discoverMcpServerTools(
            { transport: 'http', url },
            { accessToken: async () => credentials.access_token },
          )
        ).map((tool) => ({ name: tool.name, effect_class: suggestedEffect(tool) })),
      install: async (_actor, request) => {
        installed.push(request);
        return {
          connection: { id: 'conn_01J00000000000000000000002', label: request.label },
        } as unknown as ConnectionResponse;
      },
      renew: async () => ({}) as ConnectionResponse,
    });
    // No public address: the browser comes back to where the person opened Melete.
    const started = await service.start(
      'prn_owner',
      { label: 'Wiki', discover: { id: 'wiki', url: server.mcpUrl } },
      'http://localhost:3101',
    );
    expect(started.redirect_uri).toBe('http://localhost:3101/api/oauth/callback');
    const response = await fetch(started.authorize_url, { redirect: 'manual' });
    const back = new URL(response.headers.get('location') ?? '');
    const done = await service.complete('prn_owner', back.searchParams);
    expect(done).toEqual({
      ready: [
        { name: 'read_wiki_structure', effect_class: 'read' },
        { name: 'ask_wiki_question', effect_class: 'read' },
        { name: 'post_update', effect_class: 'write_external' },
      ],
    });
    expect((await service.status('prn_owner', started.sign_in_id))?.state).toBe('ready');
    expect(installed).toHaveLength(0);

    // Someone else cannot spend it, and a tool the server did not list is refused.
    const code = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: unknown) => (error instanceof McpSignInFailure ? error.code : String(error)),
      );
    expect(
      await code(
        service.installReady('prn_other', started.sign_in_id, [
          { name: 'post_update', effect_class: 'read' },
        ]),
      ),
    ).toBe('sign_in_not_found');
    expect(
      await code(
        service.installReady('prn_owner', started.sign_in_id, [
          { name: 'delete_everything', effect_class: 'read' },
        ]),
      ),
    ).toBe('tool_not_listed');

    await service.installReady('prn_owner', started.sign_in_id, [
      { name: 'ask_wiki_question', effect_class: 'read' },
      { name: 'post_update', effect_class: 'write_reversible' },
    ]);
    expect(installed).toHaveLength(1);
    expect(installed[0]?.label).toBe('Wiki');
    expect(installed[0]?.credentials.access_token).toBeTruthy();
    expect(installed[0]?.mcp.tools).toEqual([
      {
        name: 'ask_wiki_question',
        alias: 'ask_wiki_question',
        required_scopes: ['mcp_wiki.ask_wiki_question'],
        effect_class: 'read',
      },
      {
        name: 'post_update',
        alias: 'post_update',
        required_scopes: ['mcp_wiki.post_update'],
        effect_class: 'write_reversible',
      },
    ]);
    expect(await service.status('prn_owner', started.sign_in_id)).toEqual({
      state: 'connected',
      connection_id: 'conn_01J00000000000000000000002',
    });
    // Spent once.
    expect(
      await code(
        service.installReady('prn_owner', started.sign_in_id, [
          { name: 'post_update', effect_class: 'read' },
        ]),
      ),
    ).toBe('sign_in_not_found');
  });
});

describe('what a failed connection says', () => {
  const policy = (url: string, name: string) => ({
    id: 'wiki',
    audience: 'owner' as const,
    allowed_scopes: ['mcp_wiki.ask'],
    tools: [
      { name, alias: 'ask', required_scopes: ['mcp_wiki.ask'], effect_class: 'read' as const },
    ],
    endpoint: { transport: 'http' as const, url },
  });
  const why = (promise: Promise<unknown>) =>
    promise.then(
      () => 'opened',
      (error: unknown) => mcpOpenFailure(error),
    );

  test('a tool name the server does not have is named as that, not as a refused credential', async () => {
    // As with DeepWiki, whose tool is ask_wiki_question, not ask_question.
    const server = await startFakeMcpAuth({ open: true, tools: [{ name: 'ask_wiki_question' }] });
    servers.push(server);
    const failure = await openMcpWorker(policy(server.mcpUrl, 'ask_question'), {
      connectionId: 'conn_wiki',
      spaceId: 'sp_fixture',
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(McpToolMissingError);
    expect(mcpOpenFailure(failure)).toBe('tool_missing');
    expect(CONNECTION_CHECK_DETAIL.tool_missing).toContain('no longer has a tool');
    expect(CONNECTION_CHECK_DETAIL.tool_missing).not.toContain('credential');
  });

  test('nothing listening is unreachable, and a web page is not an MCP server', async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response('') });
    const port = closed.port;
    closed.stop(true);
    expect(
      await why(discoverMcpServerTools({ transport: 'http', url: `http://127.0.0.1:${port}/mcp` })),
    ).toBe('unreachable');

    const page = Bun.serve({
      port: 0,
      fetch: () =>
        new Response('<!doctype html><title>Docs</title>', {
          headers: { 'content-type': 'text/html' },
        }),
    });
    listeners.push(page);
    expect(
      await why(
        discoverMcpServerTools({ transport: 'http', url: `http://127.0.0.1:${page.port}/` }),
      ),
    ).toBe('not_mcp');

    const missing = Bun.serve({ port: 0, fetch: () => new Response('nope', { status: 404 }) });
    listeners.push(missing);
    expect(
      await why(
        discoverMcpServerTools({ transport: 'http', url: `http://127.0.0.1:${missing.port}/x` }),
      ),
    ).toBe('not_mcp');
    for (const code of ['unreachable', 'not_mcp'] as const)
      expect(CONNECTION_CHECK_DETAIL[code]).not.toContain('credential');
  });
});
