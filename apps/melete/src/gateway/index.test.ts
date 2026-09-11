import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import { connect as connectTls } from 'node:tls';
import {
  createModelGateway,
  fakeProvider,
  type GatewayBudget,
  GatewayError,
  type GatewayOptions,
  type GatewayPrincipal,
  type GatewayReservation,
  type GatewayReservationRequest,
  type GatewaySettlement,
  providersFromEnv,
} from './index.ts';
import { SecretRedactor, UsageCollector } from './metering.ts';

const principal: GatewayPrincipal = {
  jobId: 'job-test',
  attemptId: 'attempt-test',
  epoch: 1,
  revision: 1,
  maxRequests: 4,
  maxTokens: 20_000,
  allowedModels: [
    { provider: 'fake', model: 'fake-scripted' },
    { provider: 'openai', model: 'gpt-6-astra' },
    { provider: 'openai', model: 'fixture-chat' },
    { provider: 'anthropic', model: 'fixture-messages' },
  ],
};

class TestBudget implements GatewayBudget {
  reservations: GatewayReservationRequest[] = [];
  settlements: GatewaySettlement[] = [];
  outstanding = new Map<string, number>();
  spent = 0;
  failReserve = false;

  async reserve(request: GatewayReservationRequest): Promise<GatewayReservation> {
    if (this.failReserve) throw new GatewayError(409, 'stale_epoch');
    const reserved = [...this.outstanding.values()].reduce((sum, amount) => sum + amount, 0);
    if (
      this.reservations.length >= request.principal.maxRequests ||
      this.spent + reserved + request.estimatedTokens > request.principal.maxTokens
    ) {
      throw new GatewayError(429, 'budget_exceeded');
    }
    this.reservations.push(request);
    this.outstanding.set(request.requestId, request.estimatedTokens);
    return { id: request.requestId };
  }

  async settle(reservation: GatewayReservation, settlement: GatewaySettlement): Promise<void> {
    this.spent += settlement.usage?.totalTokens ?? this.outstanding.get(reservation.id) ?? 0;
    this.outstanding.delete(reservation.id);
    this.settlements.push(settlement);
  }
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function start(overrides: Partial<GatewayOptions> = {}) {
  const budget = new TestBudget();
  const server = createModelGateway({
    authenticate: async (token) => {
      if (token !== 'attempt-capability') throw new GatewayError(401, 'invalid_capability');
      return principal;
    },
    budget,
    providers: [
      ...providersFromEnv({
        OPENAI_API_KEY: 'real-openai-secret',
        ANTHROPIC_API_KEY: 'real-anthropic-secret',
      }),
      fakeProvider,
    ],
    defaultProvider: 'fake',
    ...overrides,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP listener');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (
    path: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer melete-surrogate-test',
        'x-api-key': 'melete-surrogate-test',
        'x-melete-capability': 'attempt-capability',
        ...headers,
      },
      body: JSON.stringify({ model: 'fake-scripted', max_tokens: 100, ...body }),
    });
  return { base, port: address.port, budget, post };
}

describe('model gateway effect boundary', () => {
  test('streams the fake tool conversation end to end and records actual model and usage', async () => {
    const { post, budget } = await start();
    const first = await post('/v1/chat/completions', {
      stream: true,
      messages: [{ role: 'user', content: 'Send the scripted message.' }],
    });
    expect(first.status).toBe(200);
    const stream = await first.text();
    expect(stream).toContain('test.send');
    expect(stream).toContain('call_scripted_1');
    expect(stream).toContain('[DONE]');
    const next = await post('/v1/chat/completions', {
      stream: true,
      messages: [
        { role: 'user', content: 'Send the scripted message.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_scripted_1',
              type: 'function',
              function: { name: 'test.send', arguments: '{"message":"scripted hello"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_scripted_1', content: '{"receipt":"recorded"}' },
      ],
    });
    expect(await next.text()).toContain('recorded receipt');
    expect(budget.reservations).toHaveLength(2);
    expect(budget.settlements).toHaveLength(2);
    expect(budget.settlements[0]).toMatchObject({
      provider: 'fake',
      modelRequested: 'fake-scripted',
      modelActual: 'fake-scripted-v1',
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      status: 'succeeded',
    });
    expect(budget.spent).toBe(45);
    expect(budget.outstanding.size).toBe(0);
  });

  test('rejects missing capability, missing surrogate, wrong model, arbitrary paths and methods', async () => {
    const { base, post, budget } = await start();
    expect((await post('/v1/chat/completions', {}, { 'x-melete-capability': '' })).status).toBe(
      401,
    );
    expect(
      (await post('/v1/chat/completions', {}, { authorization: 'Bearer a-real-runtime-key' }))
        .status,
    ).toBe(401);
    expect((await post('/v1/chat/completions', { model: 'not-authorized' })).status).toBe(403);
    expect((await post('/v1/files', {})).status).toBe(404);
    expect((await fetch(`${base}/v1/chat/completions`)).status).toBe(405);
    expect(budget.reservations).toHaveLength(0);
  });

  test('reserves before injecting credentials and strips capability and caller headers', async () => {
    let observed: Request | undefined;
    const { post, budget } = await start({
      fetch: async (request) => {
        expect(budget.reservations).toHaveLength(1);
        observed = request;
        return Response.json({
          model: 'served-model',
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        });
      },
    });
    const result = await post(
      '/providers/openai/v1/chat/completions',
      { model: 'fixture-chat' },
      { cookie: 'secret-cookie', 'x-forwarded-host': 'evil.invalid' },
    );
    expect(result.status).toBe(200);
    expect(observed?.headers.get('authorization')).toBe('Bearer real-openai-secret');
    expect(observed?.headers.get('x-melete-capability')).toBeNull();
    expect(observed?.headers.get('cookie')).toBeNull();
    expect(observed?.headers.get('x-forwarded-host')).toBeNull();
    expect(observed?.redirect).toBe('error');
    expect(budget.settlements[0]?.modelActual).toBe('served-model');
    expect(await result.text()).not.toContain('real-openai-secret');
  });

  test('stale epoch and concurrent budget exhaustion stop requests before transport', async () => {
    const { post, budget } = await start({
      authenticate: async () => ({ ...principal, maxRequests: 1 }),
    });
    budget.failReserve = true;
    expect((await post('/v1/chat/completions', {})).status).toBe(409);
    budget.failReserve = false;
    const results = await Promise.all([
      post('/v1/chat/completions', {}),
      post('/v1/chat/completions', {}),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 429]);
    expect(budget.reservations).toHaveLength(1);
  });

  test('enforces output and input token estimates and rejects multiplied or unmetered input', async () => {
    const { post, budget } = await start({
      authenticate: async () => ({ ...principal, maxTokens: 600 }),
    });
    expect((await post('/v1/chat/completions', { max_tokens: 601 })).status).toBe(429);
    expect(
      (await post('/v1/chat/completions', { messages: [{ content: 'x'.repeat(700) }] })).status,
    ).toBe(429);
    expect((await post('/v1/chat/completions', { n: 2 })).status).toBe(400);
    expect(
      (
        await post('/v1/chat/completions', {
          messages: [
            { content: [{ type: 'image_url', image_url: { url: 'https://evil.invalid' } }] },
          ],
        })
      ).status,
    ).toBe(400);
    expect(budget.reservations).toHaveLength(0);
  });

  test('Astra requires Responses and Anthropic drops sampling controls without rewriting history', async () => {
    const seen: Record<string, unknown>[] = [];
    const { post } = await start({
      fetch: async (request) => {
        seen.push((await request.json()) as Record<string, unknown>);
        if (request.url.endsWith('/messages')) {
          expect(request.headers.get('x-api-key')).toBe('real-anthropic-secret');
          return Response.json({
            model: 'fixture-messages',
            content: [],
            usage: { input_tokens: 5, output_tokens: 2 },
          });
        }
        return Response.json({
          model: 'gpt-6-astra',
          output: [],
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        });
      },
    });
    expect(
      (await post('/providers/openai/v1/chat/completions', { model: 'gpt-6-astra' })).status,
    ).toBe(400);
    expect(
      (await post('/providers/openai/v1/responses', { model: 'gpt-6-astra', input: 'hello' }))
        .status,
    ).toBe(200);
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'next' },
    ];
    expect(
      (
        await post('/v1/messages', {
          model: 'fixture-messages',
          messages,
          temperature: 0.2,
          top_p: 0.8,
          top_k: 5,
        })
      ).status,
    ).toBe(200);
    expect(seen[1]?.messages).toEqual(messages);
    expect(seen[1]).not.toHaveProperty('temperature');
    expect(seen[1]).not.toHaveProperty('top_p');
    expect(seen[1]).not.toHaveProperty('top_k');
  });

  test('provider failures redact credentials and missing usage remains charged', async () => {
    const { post, budget } = await start({
      fetch: async () => new Response('Bearer real-openai-secret', { status: 401 }),
    });
    const response = await post('/providers/openai/v1/chat/completions', { model: 'fixture-chat' });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('real-openai-secret');
    expect(budget.settlements[0]).toMatchObject({ status: 'failed', usage: null, httpStatus: 401 });
    expect(budget.spent).toBe(budget.reservations[0]?.estimatedTokens ?? -1);
  });

  test('a truncated SSE stream stays unknown and keeps the reservation charged', async () => {
    const { post, budget } = await start({
      fetch: async () =>
        new Response('data: {"model":"served","choices":[]}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
    });
    await post('/providers/openai/v1/chat/completions', { model: 'fixture-chat', stream: true })
      .then((response) => response.text())
      .catch(() => 'connection closed');
    expect(budget.settlements[0]).toMatchObject({
      status: 'unknown',
      usage: null,
      modelActual: 'served',
    });
    expect(budget.spent).toBe(budget.reservations[0]?.estimatedTokens ?? -1);
  });

  test('absolute-form proxy requests only admit configured inference endpoints', async () => {
    const { port, budget } = await start();
    const result = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () =>
        socket.write(
          'POST https://api.openai.com/v1/files HTTP/1.1\r\nHost: api.openai.com\r\nx-melete-capability: attempt-capability\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        ),
      );
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();
      });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    expect(result).toContain('403 Forbidden');
    expect(budget.reservations).toHaveLength(0);
  });
});

describe('CONNECT is metered TLS termination', () => {
  test('denies arbitrary hosts and refuses allowed hosts without a trusted termination certificate', async () => {
    const { port } = await start();
    expect(await connectStatus(port, 'evil.invalid:443')).toContain('destination_denied');
    expect(await connectStatus(port, 'api.openai.com:444')).toContain('destination_denied');
    expect(await connectStatus(port, 'api.openai.com:443')).toContain('metered_endpoint_required');
  });

  test('allowed TLS CONNECT injects a key, meters each inner request, and rejects a different Host', async () => {
    const cert = readFileSync(new URL('./fixtures/test-only-cert.pem', import.meta.url));
    const key = readFileSync(new URL('./fixtures/test-only-key.pem', import.meta.url));
    const { port, budget } = await start({
      connectTls: (host) => (host === 'api.openai.com' ? { cert, key } : undefined),
      fetch: async (request) => {
        expect(request.url).toBe('https://api.openai.com/v1/chat/completions');
        expect(request.headers.get('authorization')).toBe('Bearer real-openai-secret');
        return Response.json({
          model: 'served-over-connect',
          choices: [],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        });
      },
    });
    const good = await requestThroughConnect(port, cert, 'api.openai.com');
    expect(good).toContain('200 OK');
    expect(good).toContain('served-over-connect');
    expect(budget.settlements[0]?.usage?.totalTokens).toBe(7);
    const wrongHost = await requestThroughConnect(port, cert, 'evil.invalid');
    expect(wrongHost).toContain('403 Forbidden');
    expect(budget.reservations).toHaveLength(1);
  });
});

describe('provider evidence parsing', () => {
  test('empty, invalid, and partial usage never release an unmetered reservation', () => {
    for (const usage of [
      {},
      { prompt_tokens: 3 },
      { prompt_tokens: -1, completion_tokens: 4 },
      { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 'unknown' },
      { prompt_tokens: 3, completion_tokens: 4, total_tokens: -1 },
      { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 4 },
    ]) {
      const collector = new UsageCollector(false);
      collector.feed(new TextEncoder().encode(JSON.stringify({ model: 'served', usage })));
      collector.finish();
      expect(collector.usage).toBeNull();
    }
  });

  test('captures chunk-split Responses and Anthropic usage including cached tokens', () => {
    const collector = new UsageCollector(true);
    const sse =
      'data: {"type":"message_start","message":{"model":"claude-served","usage":{"input_tokens":3,"cache_read_input_tokens":4,"cache_creation_input_tokens":2,"output_tokens":0}}}\r\n\r\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\ndata: {"type":"message_stop"}\n\n';
    for (const byte of new TextEncoder().encode(sse)) collector.feed(new Uint8Array([byte]));
    collector.finish();
    expect(collector.completed).toBe(true);
    expect(collector.modelActual).toBe('claude-served');
    expect(collector.usage).toEqual({
      inputTokens: 9,
      outputTokens: 5,
      cachedInputTokens: 4,
      totalTokens: 14,
    });
    const responses = new UsageCollector(true);
    responses.feed(
      new TextEncoder().encode(
        'data: {"type":"response.completed","response":{"model":"actual","usage":{"input_tokens":11,"output_tokens":2,"total_tokens":13}}}\n\n',
      ),
    );
    responses.finish();
    expect(responses.usage?.totalTokens).toBe(13);
    expect(responses.modelActual).toBe('actual');
  });

  test('redacts a known key even if split between chunks', () => {
    const redactor = new SecretRedactor(['real-key-secret']);
    const a = redactor.feed(new TextEncoder().encode('data: {"echo":"real-key-'));
    const b = redactor.feed(new TextEncoder().encode('secret"}\n\n'));
    const c = redactor.feed(new Uint8Array(), true);
    expect(a + b + c).toBe('data: {"echo":"[redacted]"}\n\n');
  });
});

function connectStatus(port: number, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () =>
      socket.write(
        `CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\nProxy-Authorization: Bearer attempt-capability\r\n\r\n`,
      ),
    );
    let data = '';
    socket.setTimeout(2000, () => socket.destroy(new Error('CONNECT timed out')));
    socket.on('data', (chunk) => {
      data += chunk.toString();
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

function requestThroughConnect(port: number, cert: Buffer, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () =>
      socket.write(
        'CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\nProxy-Authorization: Bearer attempt-capability\r\n\r\n',
      ),
    );
    socket.setTimeout(2000, () => socket.destroy(new Error('TLS CONNECT timed out')));
    socket.once('error', reject);
    socket.once('data', (chunk) => {
      if (!chunk.toString().startsWith('HTTP/1.1 200')) return reject(new Error(chunk.toString()));
      const tls = connectTls(
        { socket, servername: 'api.openai.com', ca: cert, ALPNProtocols: ['http/1.1'] },
        () => {
          const body = JSON.stringify({
            model: 'fixture-chat',
            messages: [{ role: 'user', content: 'hello' }],
            max_tokens: 100,
          });
          tls.write(
            `POST /v1/chat/completions HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer melete-surrogate-test\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
          );
        },
      );
      let data = '';
      tls.on('data', (bytes: Buffer) => {
        data += bytes.toString();
      });
      tls.on('end', () => resolve(data));
      tls.on('error', reject);
    });
  });
}
