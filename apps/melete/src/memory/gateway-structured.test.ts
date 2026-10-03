import { expect, test } from 'bun:test';
import { openAiCompatibleProvider } from '../gateway/providers.ts';
import type { GatewayProvider } from '../gateway/types.ts';
import { MemoryError, type MemorySql } from './db.ts';
import { EXTRACTION_FORMAT } from './extract.ts';
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

const FIREWORKS: GatewayProvider = {
  name: 'fireworks',
  baseUrl: 'https://api.fireworks.ai/inference/v1/',
  apiKey: 'test-key',
  protocols: ['chat/completions'],
};
const ANTHROPIC: GatewayProvider = {
  name: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1/',
  apiKey: 'test-key',
  protocols: ['messages'],
};

const ANSWER = '{"proposals":[]}';

const completion = (content: string, finish: string) =>
  Response.json({
    id: 'chat_1',
    object: 'chat.completion',
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
    usage: { prompt_tokens: 40, completion_tokens: 40, total_tokens: 80 },
  });
const message = (text: string, stop: string) =>
  Response.json({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text }],
    stop_reason: stop,
    usage: { input_tokens: 40, output_tokens: 40 },
  });

async function read(
  target: { provider: GatewayProvider; model: string },
  upstream: (body: Record<string, unknown>) => Response,
) {
  const sent: Record<string, unknown>[] = [];
  const memory = await openMemoryGateway({
    sql: ledger(),
    provider: target.provider.name,
    model: target.model,
    providers: [target.provider],
    dailyCalls: 10,
    privacy: false,
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      sent.push(body);
      return upstream(body);
    },
  });
  try {
    const reply = await memory.gateway
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
    return { reply, sent };
  } finally {
    await memory.close();
  }
}

const codeOf = (error: unknown) => (error instanceof MemoryError ? error.code : String(error));

test('a provider with structured outputs is sent the schema, and its document is the answer', async () => {
  const { reply, sent } = await read({ provider: FIREWORKS, model: 'accounts/x/models/y' }, () =>
    completion(ANSWER, 'stop'),
  );
  expect(reply).toBe(ANSWER);
  expect(sent[0]?.response_format).toEqual({
    type: 'json_schema',
    json_schema: { name: 'memory_extraction', schema: EXTRACTION_FORMAT.schema, strict: true },
  });
});

test('Anthropic is sent the schema in output_config', async () => {
  const { reply, sent } = await read({ provider: ANTHROPIC, model: 'claude-opus-5-5' }, () =>
    message(ANSWER, 'end_turn'),
  );
  expect(reply).toBe(ANSWER);
  expect(sent[0]?.output_config).toEqual({
    format: { type: 'json_schema', schema: EXTRACTION_FORMAT.schema },
  });
  expect(sent[0]).not.toHaveProperty('response_format');
});

test('an endpoint without known structured outputs is asked as before, with no schema', async () => {
  const compatible = openAiCompatibleProvider('https://models.example.test/v1/', 'test-key');
  const { reply, sent } = await read({ provider: compatible, model: 'local-model' }, () =>
    completion(ANSWER, 'stop'),
  );
  expect(reply).toBe(ANSWER);
  expect(sent[0]).not.toHaveProperty('response_format');
  expect(sent[0]).not.toHaveProperty('output_config');
});

test('the old failure: an answer cut off at the output limit is never read, even when it parses', async () => {
  // Recorded: the budget ran out right after the opening of an empty list.
  const chat = await read({ provider: FIREWORKS, model: 'accounts/x/models/y' }, () =>
    completion('{"proposals":[]}', 'length'),
  );
  expect(codeOf(chat.reply)).toBe('extraction_cut_off');
  const messages = await read({ provider: ANTHROPIC, model: 'claude-opus-5-5' }, () =>
    message('{"proposals":[{"op":"add","domain_key":"diet', 'max_tokens'),
  );
  expect(codeOf(messages.reply)).toBe('extraction_cut_off');
});

test('a refused answer is named as one', async () => {
  const { reply } = await read({ provider: ANTHROPIC, model: 'claude-opus-5-5' }, () =>
    message('', 'refusal'),
  );
  expect(codeOf(reply)).toBe('extraction_answer_refused');
});
