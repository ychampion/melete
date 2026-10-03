import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createModelGateway } from './index.ts';
import type {
  GatewayPrincipal,
  GatewayProvider,
  GatewaySettlement,
  GatewaySpending,
} from './types.ts';

const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.close();
});

const ANTHROPIC: GatewayProvider = {
  name: 'anthropic',
  baseUrl: 'https://api.anthropic.com/v1/',
  apiKey: 'test-key',
  protocols: ['messages'],
};
const MODEL = 'claude-opus-5-5-retry-test';

const principal: GatewayPrincipal = {
  privacy: { kind: 'job' },
  jobId: 'job_retry',
  attemptId: 'att_retry',
  epoch: 1,
  revision: 1,
  maxRequests: 10,
  maxTokens: 20_000,
  allowedModels: [{ provider: 'anthropic', model: MODEL }],
};

test('a schema refused by the provider is retried with cache controls, and spending holds once at a time', async () => {
  const sent: Record<string, unknown>[] = [];
  const settlements: GatewaySettlement[] = [];
  let held = 0;
  let mostHeld = 0;
  let admitted = 0;
  const spending: GatewaySpending = {
    async admit(_principal, call) {
      admitted++;
      if (call) held++;
      mostHeld = Math.max(mostHeld, held);
    },
    async record(_principal, settlement) {
      held--;
      settlements.push(settlement);
    },
  };
  const server = createModelGateway({
    authenticate: async () => principal,
    budget: { reserve: async () => ({ id: randomUUID() }), settle: async () => {} },
    providers: [ANTHROPIC],
    defaultProvider: 'anthropic',
    privacy: false,
    spending,
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      sent.push(body);
      const config = body.output_config as Record<string, unknown> | undefined;
      if (config?.format)
        return Response.json(
          {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'output_config.format: schema is too complex',
            },
          },
          { status: 400 },
        );
      return Response.json({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [{ type: 'text', text: '{"ok":true}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    },
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
  const system = `You are Melete. ${'Read the evidence carefully. '.repeat(200)}`;
  const response = await fetch(`http://127.0.0.1:${address.port}/providers/anthropic/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'melete-surrogate-test',
      'x-melete-capability': 'attempt',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 200,
      system,
      messages: [{ role: 'user', content: 'Remember I take tea.' }],
      output_config: {
        format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false } },
      },
    }),
  });
  expect(response.status).toBe(200);
  expect(sent).toHaveLength(2);
  // The retry is the same request without the schema, with its cache controls placed again.
  expect(sent[0]).toHaveProperty('output_config');
  expect(sent[1]).not.toHaveProperty('output_config');
  expect(sent[1]?.messages).toEqual(sent[0]?.messages);
  for (const body of sent) expect(JSON.stringify(body)).toContain('cache_control');
  // Each attempt is admitted and recorded once; the refused one's hold is let go
  // before the retry takes its own, so the call is never held twice.
  expect(admitted).toBe(2);
  expect(mostHeld).toBe(1);
  expect(held).toBe(0);
  expect(settlements.map((settlement) => settlement.structured)).toEqual(['refused', 'stripped']);
  expect(settlements[0]?.status).toBe('failed');
  expect(settlements[0]?.usage).toBeNull();
});
