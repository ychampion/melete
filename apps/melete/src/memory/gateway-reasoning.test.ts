import { expect, test } from 'bun:test';
import type { MemorySql } from './db.ts';
import { openMemoryGateway } from './gateway.ts';

/** Just enough of the database for the gateway's call ledger: nothing spent, nothing kept. */
function ledger(): MemorySql {
  const sql = Object.assign(
    async (strings: TemplateStringsArray) =>
      strings.join('?').includes('count(*)') ? [{ calls: 0 }] : [],
    { begin: async (work: (tx: unknown) => Promise<unknown>) => work(sql) },
  );
  return sql as unknown as MemorySql;
}

const FIREWORKS = {
  name: 'fireworks',
  baseUrl: 'https://api.fireworks.ai/inference/v1/',
  apiKey: 'test-key',
  protocols: ['chat/completions' as const],
};

const ANSWER = '{"proposals":[]}';

const completion = (content: string, finish: string) =>
  Response.json({
    id: 'chat_1',
    object: 'chat.completion',
    model: 'accounts/fireworks/models/reasoner',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
    usage: { prompt_tokens: 40, completion_tokens: 4000, total_tokens: 4040 },
  });

async function read(provider: (body: Record<string, unknown>) => Response) {
  const sent: Record<string, unknown>[] = [];
  const memory = await openMemoryGateway({
    sql: ledger(),
    provider: 'fireworks',
    model: 'accounts/fireworks/models/reasoner',
    providers: [FIREWORKS],
    dailyCalls: 10,
    privacy: false,
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      sent.push(body);
      return provider(body);
    },
  });
  try {
    const reply = await memory.gateway.chat(
      {
        messages: [
          { role: 'system', content: 'Return only JSON.' },
          { role: 'user', content: '{"evidence":{"text":"I am vegetarian."}}' },
        ],
        max_tokens: 4000,
        signal: AbortSignal.timeout(10_000),
      },
      { ownerId: 'own_test', spaceId: 'sp_test', workId: 'work_test', sourceJobId: null },
    );
    return { reply, sent };
  } finally {
    await memory.close();
  }
}

test('a reasoning model is asked to answer without thinking, so its output budget holds the answer', async () => {
  // Like a model that thinks by default: it spends the whole budget reasoning and says nothing.
  const { reply, sent } = await read((body) =>
    body.reasoning_effort === 'none' ? completion(ANSWER, 'stop') : completion('', 'length'),
  );
  expect(reply).toBe(ANSWER);
  expect(sent).toHaveLength(1);
});

test('a model that cannot stop thinking is asked again as it is', async () => {
  const { reply, sent } = await read((body) =>
    body.reasoning_effort === undefined
      ? completion(ANSWER, 'stop')
      : Response.json(
          {
            error: {
              message: 'This is a thinking-only model; reasoning_effort none is not supported.',
            },
          },
          { status: 400 },
        ),
  );
  expect(reply).toBe(ANSWER);
  expect(sent.map((body) => body.reasoning_effort)).toEqual(['none', undefined]);
});
