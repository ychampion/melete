import { afterEach, expect, test } from 'bun:test';
import type { SearchRequest } from '../connectors/web-search.ts';
import { SearchRefused } from '../connectors/web-search.ts';
import { isProviderSearchTool } from '../gateway/index.ts';
import {
  type GatewayBudget,
  GatewayError,
  type GatewayProvider,
  type GatewaySettlement,
} from '../gateway/types.ts';
import { PrivacyRouter } from '../privacy/router.ts';
import { MemoryPrivacyStore } from '../privacy/store.ts';
import { openSearchGateway, SEARCH_BUDGET_REFUSED, SEARCH_MAX_USES } from './search-gateway.ts';

const providers: GatewayProvider[] = [
  {
    name: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1/',
    apiKey: 'sk-ant-real-key',
    protocols: ['messages'],
  },
  {
    name: 'openai',
    baseUrl: 'https://api.openai.com/v1/',
    apiKey: 'sk-openai-real-key',
    protocols: ['chat/completions', 'responses'],
  },
];

const request: SearchRequest = {
  query: 'rent prices in Lisbon 2026',
  maxResults: 5,
  jobId: 'job_1',
  spaceId: 'spc_1',
  attemptId: 'att_1',
  actionId: 'act_1',
};

const MESSAGES_REPLY = {
  id: 'msg_1',
  model: 'claude-sonnet-4-5',
  role: 'assistant',
  content: [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: [
        {
          type: 'web_search_result',
          url: 'https://idealista.example/lisbon',
          title: 'Lisbon rents',
          encrypted_content: 'opaque',
        },
        {
          type: 'web_search_result',
          url: 'https://news.example/rents',
          title: 'Rents rise',
          encrypted_content: 'opaque',
        },
      ],
    },
    {
      type: 'text',
      text: 'Average rent is about €1,500 a month.',
      citations: [
        {
          type: 'web_search_result_location',
          url: 'https://news.example/rents',
          title: 'Rents rise',
          cited_text: 'Rents in Lisbon averaged €1,500.',
        },
      ],
    },
  ],
  usage: { input_tokens: 900, output_tokens: 120, server_tool_use: { web_search_requests: 1 } },
};

const RESPONSES_REPLY = {
  id: 'resp_1',
  model: 'gpt-5.1',
  output: [
    {
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'search', sources: [{ type: 'url', url: 'https://a.example/x' }] },
    },
    {
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: 'Here is what I found.',
          annotations: [{ type: 'url_citation', url: 'https://b.example/y', title: 'Y page' }],
        },
      ],
    },
  ],
  usage: { input_tokens: 500, output_tokens: 80, total_tokens: 580 },
};

type Recorded = { reserved: number; settled: GatewaySettlement[] };
const recordingBudget = (record: Recorded) => (): GatewayBudget => ({
  async reserve() {
    record.reserved += 1;
    return { id: `res_${record.reserved}` };
  },
  async settle(_reservation, settlement) {
    record.settled.push(settlement);
  },
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function open(options: {
  model: { provider: string; model: string } | null;
  reply?: unknown;
  status?: number;
  privacy?: PrivacyRouter | false;
  defaultModel?: { provider: string; model: string; search?: boolean };
}) {
  const upstream: Request[] = [];
  const bodies: Record<string, unknown>[] = [];
  const record: Recorded = { reserved: 0, settled: [] };
  const gateway = await openSearchGateway({
    sql: undefined as never,
    providers,
    privacy: options.privacy ?? false,
    budget: recordingBudget(record),
    attemptModel: async () => options.model,
    ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
    fetch: async (outbound) => {
      upstream.push(outbound);
      bodies.push((await outbound.clone().json()) as Record<string, unknown>);
      return Response.json(options.reply ?? {}, { status: options.status ?? 200 });
    },
  });
  closers.push(gateway.close);
  return { gateway, upstream, bodies, record };
}

test('a Claude model searches with its own search tool through the gateway, metered and with sources', async () => {
  const { gateway, upstream, bodies, record } = await open({
    model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    reply: MESSAGES_REPLY,
  });
  const found = await gateway.backend.search(request);
  expect(found).toEqual({
    backend: 'native',
    model: 'anthropic/claude-sonnet-4-5',
    answer: 'Average rent is about €1,500 a month.',
    searches: 1,
    results: [
      {
        title: 'Rents rise',
        url: 'https://news.example/rents',
        snippet: 'Rents in Lisbon averaged €1,500.',
      },
      { title: 'Lisbon rents', url: 'https://idealista.example/lisbon', snippet: '' },
    ],
  });
  expect(upstream[0]?.url).toBe('https://api.anthropic.com/v1/messages');
  // The real key is the gateway's; the caller only ever had a surrogate.
  expect(upstream[0]?.headers.get('x-api-key')).toBe('sk-ant-real-key');
  expect(bodies[0]).toMatchObject({
    model: 'claude-sonnet-4-5',
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: SEARCH_MAX_USES }],
  });
  expect(JSON.stringify(bodies[0])).toContain('rent prices in Lisbon 2026');
  expect(record.reserved).toBe(1);
  expect(record.settled[0]).toMatchObject({
    provider: 'anthropic',
    status: 'succeeded',
    usage: { inputTokens: 900, outputTokens: 120 },
  });
});

test('an OpenAI model searches with the Responses web_search tool and its sources', async () => {
  const { gateway, upstream, bodies } = await open({
    model: { provider: 'openai', model: 'gpt-5.1' },
    reply: RESPONSES_REPLY,
  });
  const found = await gateway.backend.search(request);
  expect(found?.results.map((item) => item.url)).toEqual([
    'https://b.example/y',
    'https://a.example/x',
  ]);
  expect(found?.searches).toBe(1);
  expect(upstream[0]?.url).toBe('https://api.openai.com/v1/responses');
  expect(bodies[0]).toMatchObject({
    tools: [{ type: 'web_search', search_context_size: 'low' }],
    include: ['web_search_call.action.sources'],
  });
});

test('a model with no search of its own is passed over without a call', async () => {
  for (const model of [
    { provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-v4p1-flash' },
    { provider: 'google', model: 'gemini-2.5-pro' },
    { provider: 'fake', model: 'scripted' },
  ]) {
    const { gateway, upstream, record } = await open({ model });
    expect(await gateway.backend.search(request)).toBeNull();
    expect(upstream).toEqual([]);
    expect(record.reserved).toBe(0);
  }
  const unknown = await open({ model: null });
  expect(await unknown.gateway.backend.search(request)).toBeNull();
});

test('the operator can turn the default model’s own search off', async () => {
  const model = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
  const { gateway, upstream } = await open({ model, defaultModel: { ...model, search: false } });
  expect(await gateway.backend.search(request)).toBeNull();
  expect(upstream).toEqual([]);
});

test('a reply without sources, or a refused call, passes the search on', async () => {
  const empty = await open({
    model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    reply: { ...MESSAGES_REPLY, content: [{ type: 'text', text: 'I did not search.' }] },
  });
  await expect(empty.gateway.backend.search(request)).rejects.toThrow('no sources');
  const failing = await open({
    model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    status: 500,
  });
  const error = await failing.gateway.backend.search(request).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(SearchRefused);
});

test('in a private space the privacy router refuses the call, and nothing else may search', async () => {
  const store = new MemoryPrivacyStore();
  store.scopes.set('job_1', {
    spaceId: 'spc_1',
    conversationId: 'job_1',
    agentId: null,
    turnId: null,
  });
  await store.saveSettings('spc_1', { private_space: true }, null);
  const { gateway, upstream, record } = await open({
    model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    reply: MESSAGES_REPLY,
    privacy: new PrivacyRouter({ store }),
  });
  await expect(gateway.backend.search(request)).rejects.toBeInstanceOf(SearchRefused);
  expect(upstream).toEqual([]);
  expect(record.reserved).toBe(0);
});

test('only a provider’s own search tool is let through, no other built-in tool', () => {
  expect(isProviderSearchTool({ type: 'web_search' })).toBe(true);
  expect(isProviderSearchTool({ type: 'web_search_20250305', name: 'web_search' })).toBe(true);
  expect(isProviderSearchTool({ type: 'web_search_preview' })).toBe(true);
  for (const type of ['code_interpreter', 'computer_use_preview', 'file_search', 'web_search_x'])
    expect(isProviderSearchTool({ type })).toBe(false);
});

test('native results lose markup and credentials, like every other backend', async () => {
  const { gateway } = await open({
    model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    reply: {
      ...MESSAGES_REPLY,
      content: [
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [
            {
              type: 'web_search_result',
              url: 'https://user:pw@rents.example/a?token=abcdefghijklmnop1234567890&q=lisbon',
              title: '<b>Lisbon</b> &amp; rents',
            },
            { type: 'web_search_result', url: 'javascript:alert(1)', title: 'Bad' },
          ],
        },
      ],
    },
  });
  const found = await gateway.backend.search(request);
  expect(found?.results).toEqual([
    {
      title: 'Lisbon & rents',
      url: 'https://rents.example/a?token=%5Bredacted%5D&q=lisbon',
      snippet: '',
    },
  ]);
});

test('the provider’s search count is settled as the fee, and a budget refusal stops the search', async () => {
  const counted: number[] = [];
  const counting = await openSearchGateway({
    sql: undefined as never,
    providers,
    privacy: false,
    attemptModel: async () => ({ provider: 'anthropic', model: 'claude-sonnet-4-5' }),
    budget: () => ({
      reserve: async () => ({ id: 'res_1' }),
      settle: async () => {},
      searched: async (_call, searches) => {
        counted.push(searches);
      },
    }),
    fetch: async () => Response.json(MESSAGES_REPLY),
  });
  closers.push(counting.close);
  await counting.backend.search(request);
  expect(counted).toEqual([1]);

  const upstream: Request[] = [];
  const exhausted = await openSearchGateway({
    sql: undefined as never,
    providers,
    privacy: false,
    attemptModel: async () => ({ provider: 'anthropic', model: 'claude-sonnet-4-5' }),
    budget: () => ({
      reserve: async () => {
        throw new GatewayError(429, 'search_budget_exceeded');
      },
      settle: async () => {},
    }),
    fetch: async (outbound) => {
      upstream.push(outbound);
      return Response.json(MESSAGES_REPLY);
    },
  });
  closers.push(exhausted.close);
  const error = await exhausted.backend.search(request).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SearchRefused);
  expect((error as Error).message).toBe(SEARCH_BUDGET_REFUSED);
  expect(upstream).toEqual([]);
});
