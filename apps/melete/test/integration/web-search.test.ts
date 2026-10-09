/**
 * Web search end to end against a real database: a conversation searches
 * through the broker with the model's own search (metered on the job, through
 * the gateway), with the keyless search when the model has none, and with a
 * configured key ahead of both. A private space or a sensitive conversation
 * sends nothing anywhere. A default web connection from an earlier release
 * gains the tool.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { agentResponse, type CapabilityClaims, type JsonObject } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { BrokerFault } from '../../src/broker/errors.ts';
import { recordId } from '../../src/broker/records.ts';
import { openSearchGateway, SEARCH_BUDGET_REFUSED } from '../../src/broker/search-gateway.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { ensureBuiltinConnections } from '../../src/connectors/builtin.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { createWebConnector, databasePublicReads } from '../../src/connectors/web.ts';
import { type WebSearch, webSearchFromEnv } from '../../src/connectors/web-search.ts';
import { session } from '../../src/db/auth-schema.ts';
import { action, connection, owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { actionSources } from '../../src/experience/projectors.ts';
import { actionPhrase } from '../../src/experience/tools.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { PrivacyRouter, SEARCH_KEPT_PRIVATE } from '../../src/privacy/router.ts';
import { PostgresPrivacyStore } from '../../src/privacy/store.ts';
import { freshAgent } from '../helpers/agents.ts';
import { defaultBudget, rejectionOf } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const SLOW = 30_000;

const DDG_PAGE = `<div class="result results_links web-result">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fweather.example%2Flisbon&amp;rut=1">Lisbon weather</a>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Sunny, 24°C.</a></div>`;

const MESSAGES_REPLY = {
  id: 'msg_1',
  model: 'claude-sonnet-4-5',
  role: 'assistant',
  content: [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'q' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: [
        {
          type: 'web_search_result',
          url: 'https://rents.example/lisbon',
          title: 'Lisbon rents 2026',
          encrypted_content: 'opaque',
        },
      ],
    },
    {
      type: 'text',
      text: 'Rents average €1,500.',
      citations: [
        {
          type: 'web_search_result_location',
          url: 'https://rents.example/lisbon',
          title: 'Lisbon rents 2026',
          cited_text: 'The average is €1,500.',
        },
      ],
    },
  ],
  usage: { input_tokens: 900, output_tokens: 120, server_tool_use: { web_search_requests: 1 } },
};

const spaceId = newId('sp');
const ownerId = newId('own');
const webConnection = recordId('conn');
/** Every keyless request, by host; every native upstream request; every search-API request. */
const keylessHosts: string[] = [];
const upstream: Request[] = [];
const apiRequests: Request[] = [];

const store = handle ? new PostgresPrivacyStore(handle.sql, () => undefined) : null;
const privacy = store ? new PrivacyRouter({ store, cacheMs: 0 }) : null;
const gateway =
  handle && privacy
    ? await openSearchGateway({
        sql: handle.sql,
        providers: [
          {
            name: 'anthropic',
            baseUrl: 'https://api.anthropic.com/v1/',
            apiKey: 'sk-ant-test',
            protocols: ['messages'],
          },
        ],
        privacy,
        fetch: async (outbound) => {
          upstream.push(outbound);
          return Response.json(MESSAGES_REPLY);
        },
      })
    : null;
const get = async (url: URL) => {
  keylessHosts.push(url.hostname);
  return { status: 200, body: DDG_PAGE };
};
const searches = {
  default: webSearchFromEnv({}, { native: gateway?.backend, get }),
  keyed: webSearchFromEnv(
    { BRAVE_SEARCH_API_KEY: 'brave-test-key' },
    {
      native: gateway?.backend,
      get,
      fetch: async (outbound) => {
        apiRequests.push(outbound);
        return Response.json({
          web: {
            results: [{ title: 'Brave result', url: 'https://brave.example/', description: 'b' }],
          },
        });
      },
    },
  ),
};
let active: WebSearch = searches.default;

const broker =
  handle && privacy
    ? new BrokerService({
        sql: handle.sql,
        connectors: new ConnectorRegistry().register(
          webConnection,
          createWebConnector({
            publicReads: databasePublicReads({ sql: handle.sql, connectionId: webConnection }),
            search: { backends: [], search: (request) => active.search(request) },
            searchPrivacy: ({ jobId, query, tx }) => privacy.outsideSearchRefusal(jobId, query, tx),
          }),
        ),
      })
    : null;

const token = randomBytes(32).toString('base64url');
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      sql: handle.sql,
      checkDatabase: async () => 'ok',
    })
  : null;

/** An agent made the way a person makes one; every conversation has one. */
let agentId: string | undefined;
async function conversationAgent(): Promise<string> {
  if (agentId) return agentId;
  if (!app) throw new Error('Postgres unavailable');
  const made = await app.request('/agents', {
    method: 'POST',
    headers: { Cookie: `melete_session=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(freshAgent()),
  });
  expect(made.status).toBe(200);
  agentId = agentResponse.parse(await made.json()).agent.id;
  return agentId;
}

if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'web-search@example.test' });
  await handle.sql`insert into principal (id, email, password_hash)
    select id, email, password_hash from owner where id = ${ownerId}`;
  await handle.db
    .insert(space)
    .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
  await handle.db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 600_000),
  });
  await handle.sql`insert into connection (id, space_id, provider, label, scopes, configuration)
    values (${webConnection}, ${spaceId}, 'web', 'Web', '["web.fetch","web.search"]'::jsonb,
      '{"builtin":"web"}'::jsonb)`;
}

/** A conversation's own limits: a turn has room for real work. */
const turnBudget = { ...defaultBudget, max_output_tokens: 400_000 };

/** A running conversation on `model`, and the claims its runtime holds. */
async function conversation(
  model: { provider: string; model: string },
  budget = turnBudget,
): Promise<CapabilityClaims> {
  if (!handle) throw new Error('Postgres unavailable');
  const jobId = recordId('job');
  const attemptId = recordId('att');
  const agent = await conversationAgent();
  await handle.sql`insert into job (id, space_id, principal_id, title, objective, kind, agent_id,
      state, lease_epoch, budget, constraints)
    values (${jobId}, ${spaceId}, ${ownerId}, 'Look something up', 'Search the web', 'chat',
      ${agent}, 'running', 1, ${JSON.stringify(budget)}::jsonb,
      ${JSON.stringify({ public_compartment: false, allowed_domains: [] })}::jsonb)`;
  await handle.sql`insert into attempt (id, job_id, epoch, runtime_version, provider, model)
    values (${attemptId}, ${jobId}, 1, 'fake', ${model.provider}, ${model.model})`;
  return {
    job_id: jobId,
    attempt_id: attemptId,
    space_id: spaceId,
    principal_id: ownerId,
    membership_generation: 0,
    epoch: 1,
    revision: 0,
    scopes: ['web.fetch', 'web.search'],
    budget: {
      max_actions: defaultBudget.max_actions,
      max_output_tokens: budget.max_output_tokens,
      max_usd_est: budget.max_usd_est,
    },
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

async function searchAs(claims: CapabilityClaims, payload: JsonObject) {
  if (!broker || !handle) throw new Error('Postgres unavailable');
  const proposal = await broker.propose(claims, {
    kind: 'web.search',
    connection_id: webConnection,
    payload,
  });
  if (proposal.status === 'admitted') await broker.dispatch(proposal.action_id);
  const [row] = await handle.db.select().from(action).where(eq(action.id, proposal.action_id));
  if (!row) throw new Error('action missing');
  return row;
}

const CLAUDE = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
const NO_SEARCH = { provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-v4p1-flash' };

withDb('web search', () => {
  // A search's privacy check runs inside the admission that holds the event
  // order lock; any statement it sent to the pool instead fails the suite.
  const guard = process.env.MELETE_EVENT_LOCK_GUARD;
  beforeAll(() => {
    process.env.MELETE_EVENT_LOCK_GUARD = 'throw';
  });
  afterAll(async () => {
    if (guard === undefined) delete process.env.MELETE_EVENT_LOCK_GUARD;
    else process.env.MELETE_EVENT_LOCK_GUARD = guard;
    await gateway?.close();
    await handle?.close();
  }, 30_000);

  test(
    'a Claude conversation searches with its own search tool, metered on the job, with sources in the trail',
    async () => {
      if (!handle) throw new Error('Postgres unavailable');
      active = searches.default;
      const claims = await conversation(CLAUDE);
      const before = { upstream: upstream.length, keyless: keylessHosts.length };
      const row = await searchAs(claims, { query: 'rent prices in Lisbon 2026' });
      expect(row.status).toBe('succeeded');
      const detail = (row.receipt as { detail: Record<string, unknown> }).detail;
      expect(detail).toMatchObject({
        query: 'rent prices in Lisbon 2026',
        backend: 'native',
        model: 'anthropic/claude-sonnet-4-5',
        searches: 1,
        answer: 'Rents average €1,500.',
        sources: ['https://rents.example/lisbon'],
      });
      expect(upstream.length).toBe(before.upstream + 1);
      expect(keylessHosts.length).toBe(before.keyless);
      const body = (await upstream.at(-1)?.clone().json()) as { tools?: unknown };
      expect(body.tools).toEqual([
        { type: 'web_search_20250305', name: 'web_search', max_uses: 2 },
      ]);
      // Metered: the whole call (its search results are input) on the token
      // budget, and one search's fee on the spending estimate, both under this
      // action; the request and its receipt are in the job's ledger.
      const ledger = await handle.sql`select kind, reserved::float8 as reserved,
          settled::float8 as settled from budget_ledger
        where job_id = ${claims.job_id} and action_id = ${row.id}
          and kind in ('tokens', 'usd_est') order by kind`;
      expect([...ledger]).toEqual([
        { kind: 'tokens', reserved: 15_000, settled: 1_020 },
        { kind: 'usd_est', reserved: 0.02, settled: 0.01 },
      ]);
      const notices = await handle.sql`select payload from event
        where job_id = ${claims.job_id} and type = 'notice'
          and payload->>'phase' in ('search_request', 'search_receipt') order by seq`;
      expect(notices.map((notice) => notice.payload.phase)).toEqual([
        'search_request',
        'search_receipt',
      ]);
      expect(notices[1]?.payload).toMatchObject({
        action_id: row.id,
        status: 'succeeded',
        usage: { input_tokens: 900, output_tokens: 120 },
        privacy: { route: 'cloud' },
      });
      const [attempt] = await handle.sql`select usage from attempt where id = ${claims.attempt_id}`;
      expect(attempt?.usage).toMatchObject({
        output_tokens: 120,
        search_requests: 1,
        web_searches: 1,
        usd_est: 0.01,
      });
      // The trail: "Searched the web for …", with each result as a source.
      const [web] = await handle.db
        .select()
        .from(connection)
        .where(eq(connection.id, webConnection));
      if (!web) throw new Error('connection missing');
      expect(actionPhrase(row, 'Web').done).toBe(
        'Searched the web for “rent prices in Lisbon 2026”',
      );
      expect(actionSources(row, web)).toEqual([
        expect.objectContaining({
          kind: 'page',
          title: 'Lisbon rents 2026',
          url: 'https://rents.example/lisbon',
        }),
      ]);
    },
    SLOW,
  );

  test(
    'a model with no search of its own uses the keyless search, with no key configured',
    async () => {
      active = searches.default;
      const claims = await conversation(NO_SEARCH);
      const before = { upstream: upstream.length, keyless: keylessHosts.length };
      const row = await searchAs(claims, { query: 'weather in Lisbon' });
      expect(row.status).toBe('succeeded');
      expect((row.receipt as { detail: Record<string, unknown> }).detail).toMatchObject({
        backend: 'duckduckgo',
        sources: ['https://weather.example/lisbon'],
      });
      expect(upstream.length).toBe(before.upstream);
      expect(keylessHosts.slice(before.keyless)).toEqual(['html.duckduckgo.com']);
    },
    SLOW,
  );

  test(
    'a configured search key takes precedence over the model’s own search',
    async () => {
      active = searches.keyed;
      const claims = await conversation(CLAUDE);
      const before = { upstream: upstream.length, api: apiRequests.length };
      const row = await searchAs(claims, { query: 'weather in Lisbon' });
      expect((row.receipt as { detail: Record<string, unknown> }).detail).toMatchObject({
        backend: 'brave',
        sources: ['https://brave.example/'],
      });
      expect(apiRequests.length).toBe(before.api + 1);
      expect(upstream.length).toBe(before.upstream);
      active = searches.default;
    },
    SLOW,
  );

  test(
    'a native search over the job’s spending limit is refused, not moved to the keyless search',
    async () => {
      active = searches.default;
      const before = { upstream: upstream.length, keyless: keylessHosts.length };
      const claims = await conversation(CLAUDE, { ...turnBudget, max_usd_est: 0.005 });
      const row = await searchAs(claims, { query: 'weather in Lisbon' });
      expect(row.status).toBe('failed');
      expect((row.reconciliation as { reason?: string } | null)?.reason).toBe(
        SEARCH_BUDGET_REFUSED,
      );
      expect(upstream.length).toBe(before.upstream);
      expect(keylessHosts.length).toBe(before.keyless);
    },
    SLOW,
  );

  test(
    'a private space or a sensitive conversation sends the query nowhere',
    async () => {
      if (!handle || !store) throw new Error('Postgres unavailable');
      active = searches.default;
      const before = { upstream: upstream.length, keyless: keylessHosts.length };
      const sensitive = await conversation(CLAUDE);
      await store.updateConversation(sensitive.job_id, spaceId, { sensitive: 'health' });
      const refused = await rejectionOf(searchAs(sensitive, { query: 'clinics near me' }));
      expect(refused).toBeInstanceOf(BrokerFault);
      expect((refused as BrokerFault).code).toBe('scope_denied');
      expect((refused as BrokerFault).message).toBe(SEARCH_KEPT_PRIVATE);
      // Nothing is recorded as tried, but the conversation shows the search was held back.
      expect(
        await handle.db.select().from(action).where(eq(action.jobId, sensitive.job_id)),
      ).toEqual([]);
      const traces = await handle.sql`select attempt_id, payload from event
        where job_id = ${sensitive.job_id} and type = 'notice' and payload->>'kind' = 'tool_trace'`;
      expect(traces).toHaveLength(1);
      expect(traces[0]?.attempt_id).toBe(sensitive.attempt_id);
      expect(traces[0]?.payload.call).toMatchObject({
        kind: 'web',
        title: 'Search held back: this chat is private',
        status: 'done',
        input_summary: null,
        output_summary: {
          text: 'Nothing was sent to a search service, because this conversation is private.',
        },
      });
      expect(JSON.stringify(traces[0]?.payload)).not.toContain('clinics');

      await store.saveSettings(spaceId, { private_space: true }, null);
      try {
        for (const model of [CLAUDE, NO_SEARCH]) {
          const claims = await conversation(model);
          const error = await rejectionOf(searchAs(claims, { query: 'weather in Lisbon' }));
          expect((error as BrokerFault).code).toBe('scope_denied');
        }
      } finally {
        await store.saveSettings(spaceId, {}, null);
      }
      expect(upstream.length).toBe(before.upstream);
      expect(keylessHosts.length).toBe(before.keyless);
    },
    SLOW,
  );

  test(
    'a default web connection from an earlier release gains web.search; a removed one does not',
    async () => {
      if (!handle) throw new Error('Postgres unavailable');
      const older = newId('sp');
      const removed = newId('sp');
      for (const id of [older, removed])
        await handle.db.insert(space).values({ id, name: 'Older', gitPath: `/spaces/${id}` });
      await handle.sql`insert into connection (id, space_id, provider, label, scopes, configuration, status)
        values (${recordId('conn')}, ${older}, 'web', 'Web', '["web.fetch"]'::jsonb, '{"builtin":"web"}'::jsonb, 'active'),
          (${recordId('conn')}, ${removed}, 'web', 'Web', '["web.fetch"]'::jsonb, '{"builtin":"web"}'::jsonb, 'revoked')`;
      const environment = {
        cellIsolated: false,
        speechConfigured: false,
        transcriptionConfigured: false,
      };
      await ensureBuiltinConnections(handle.sql, environment);
      await ensureBuiltinConnections(handle.sql, environment);
      const rows = await handle.sql`select space_id, scopes, status from connection
        where provider = 'web' and space_id in (${older}, ${removed})`;
      const bySpace = Object.fromEntries(rows.map((row) => [row.space_id, row]));
      expect(bySpace[older]?.scopes).toEqual(['web.fetch', 'web.search', 'web.weather']);
      expect(bySpace[removed]?.scopes).toEqual(['web.fetch']);
      expect(rows.length).toBe(2);
    },
    SLOW,
  );
});
