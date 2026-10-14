import { expect, test } from 'bun:test';
import type { GatewayProvider } from '../gateway/types.ts';
import { MemoryError, type MemorySql } from './db.ts';
import { EXTRACTION_FORMAT } from './extract.ts';
import { openMemoryGateway } from './gateway.ts';

/** Just enough of the database for the gateway's call ledger, with `used` calls already made today. */
function ledger(used: number): MemorySql {
  const sql = Object.assign(
    async (strings: TemplateStringsArray) =>
      strings.join('?').includes('count(*)') ? [{ calls: used }] : [],
    { begin: async (work: (tx: unknown) => Promise<unknown>) => work(sql) },
  );
  return sql as unknown as MemorySql;
}

const FIREWORKS: GatewayProvider = {
  name: 'fireworks',
  baseUrl: 'https://api.fireworks.ai/inference/v1/',
  apiKey: 'test-key',
  protocols: ['chat/completions'],
};
const ANSWER = '{"proposals":[]}';

async function readWith(used: number, dailyCalls: number | undefined) {
  const memory = await openMemoryGateway({
    sql: ledger(used),
    provider: FIREWORKS.name,
    model: 'accounts/x/models/y',
    providers: [FIREWORKS],
    dailyCalls,
    privacy: false,
    fetch: async () =>
      Response.json({
        id: 'chat_1',
        object: 'chat.completion',
        model: 'm',
        choices: [
          { index: 0, message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 40, total_tokens: 80 },
      }),
  });
  try {
    return await memory.gateway
      .chat(
        {
          messages: [
            { role: 'system', content: 'Read the evidence into proposals.' },
            { role: 'user', content: '{"evidence":{"text":"I am vegetarian."}}' },
          ],
          max_tokens: 2000,
          signal: AbortSignal.timeout(10_000),
          format: EXTRACTION_FORMAT,
        },
        { ownerId: 'own_test', spaceId: 'sp_test', workId: 'work_test', sourceJobId: null },
      )
      .catch((error: unknown) => error);
  } finally {
    await memory.close();
  }
}

const codeOf = (error: unknown) => (error instanceof MemoryError ? error.code : String(error));

test('with no daily limit set, memory keeps reading on a busy day', async () => {
  expect(await readWith(5000, undefined)).toBe(ANSWER);
});

test('a daily limit the operator sets still stops reads once it is spent', async () => {
  expect(codeOf(await readWith(200, 200))).toBe('memory_daily_budget');
  expect(await readWith(199, 200)).toBe(ANSWER);
});
