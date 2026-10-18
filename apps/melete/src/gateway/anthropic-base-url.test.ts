import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { loadEnv } from '../env.ts';
import { configuredProviders } from './configured.ts';
import { createModelGateway } from './index.ts';
import { PriceTable } from './prices.ts';
import { settledCost } from './spending.ts';
import type { GatewayPrincipal, GatewaySettlement, GatewaySpending } from './types.ts';

/**
 * Anthropic reached through a gateway the operator runs on their own machine
 * or network: the address is private, the model behind it is Anthropic's.
 */
const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.close();
});

const PRIMARY = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
const BACKUP = { provider: 'anthropic', model: 'claude-haiku-4-5' };

const principal: GatewayPrincipal = {
  privacy: { kind: 'job' },
  jobId: 'job_gateway',
  attemptId: 'att_gateway',
  epoch: 1,
  revision: 1,
  maxRequests: 10,
  maxTokens: 50_000,
  allowedModels: [PRIMARY, BACKUP],
  routes: { fallback: [BACKUP] },
};

async function start(reply: (model: string) => Response) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const admitted: { provider: string; model: string; local?: boolean }[] = [];
  const settlements: GatewaySettlement[] = [];
  const spending: GatewaySpending = {
    async admit(_principal, call) {
      if (call) admitted.push(call);
    },
    async record(_principal, settlement) {
      settlements.push(settlement);
    },
  };
  const env = loadEnv({
    MELETE_DEFAULT_PROVIDER: 'anthropic',
    MELETE_DEFAULT_MODEL: PRIMARY.model,
    ANTHROPIC_API_KEY: 'anthropic-key',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:4610',
  });
  const server = createModelGateway({
    authenticate: async () => principal,
    budget: { reserve: async () => ({ id: randomUUID() }), settle: async () => {} },
    // Built the way every service gateway builds its providers.
    providers: configuredProviders(env, () => {}),
    defaultProvider: 'anthropic',
    privacy: false,
    spending,
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      sent.push({ url: request.url, body });
      return reply(String(body.model));
    },
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
  const post = () =>
    fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'melete-surrogate-test',
        'x-melete-capability': 'attempt',
      },
      body: JSON.stringify({
        model: PRIMARY.model,
        max_tokens: 200,
        system: `You are Melete. ${'Read the evidence carefully. '.repeat(200)}`,
        messages: [{ role: 'user', content: 'Remember I take tea.' }],
      }),
    });
  return { sent, admitted, settlements, post };
}

const answer = (model: string) =>
  Response.json({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'Noted.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
  });

test('calls go to the gateway, and are metered and cached as Anthropic calls', async () => {
  const gateway = await start(answer);
  const response = await gateway.post();
  expect(response.status).toBe(200);
  expect(gateway.sent.map((call) => call.url)).toEqual(['http://127.0.0.1:4610/v1/messages']);
  // A private address does not make Anthropic the person's own model: the call
  // counts against the spending caps at Anthropic's price.
  expect(gateway.admitted).toEqual([expect.objectContaining({ ...PRIMARY, local: false })]);
  const [settlement] = gateway.settlements;
  if (!settlement) throw new Error('expected a settlement');
  expect(settlement.servedLocally).toBeUndefined();
  // A million tokens each way at the default Sonnet price: $3 in, $15 out.
  expect(settledCost(new PriceTable(), settlement)).toBe(18);
  // Prompt caching is placed as for Anthropic itself.
  expect(JSON.stringify(gateway.sent[0]?.body)).toContain('cache_control');
});

test('a failing call through the gateway still moves to the operator’s fallback', async () => {
  const gateway = await start((model) =>
    model === PRIMARY.model ? new Response('overloaded', { status: 529 }) : answer(model),
  );
  const response = await gateway.post();
  expect(response.status).toBe(200);
  expect(gateway.sent.map((call) => call.body.model)).toEqual([PRIMARY.model, BACKUP.model]);
});
