import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import { modelSupportsVision } from '@melete/contracts';
import { readExtractionReply } from '../memory/extract.ts';
import {
  chunk,
  completion,
  eventStream,
  inlineReasoningChunks,
  nemotronModels,
  textChunks,
  tokenFactoryErrors,
  toolCalls,
  toolChunks,
} from './fixtures/nebius.ts';
import { createModelGateway, type GatewayOptions } from './index.ts';
import { NemotronReply } from './nebius.ts';
import { PriceTable } from './prices.ts';
import { providersFromEnv } from './providers.ts';
import { settledCost } from './spending.ts';
import { replyOf } from './structured.ts';
import type { GatewayPrincipal, GatewayReservationRequest, GatewaySettlement } from './types.ts';

const close: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of close.splice(0).reverse()) await stop();
});

/** Split bytes inside SSE lines, JSON escapes, and UTF-8 characters. */
function streamed(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at === bytes.length) return controller.close();
        const end = Math.min(bytes.length, at + ([1, 7, 29, 2, 101][at % 5] ?? 1));
        controller.enqueue(bytes.slice(at, end));
        at = end;
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

type Packet = {
  model: string;
  choices: {
    index: number;
    delta: {
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: {
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason: string | null;
  }[];
  usage?: unknown;
};

function readEvents(wire: string): Packet[] {
  expect(wire).toContain('data: [DONE]');
  return wire
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Packet);
}

const answerText = (events: Packet[]) =>
  events.flatMap((event) => event.choices.map((choice) => choice.delta.content ?? '')).join('');
const reasoningText = (events: Packet[]) =>
  events
    .flatMap((event) => event.choices.map((choice) => choice.delta.reasoning_content ?? ''))
    .join('');

async function start(
  reply: (body: Record<string, unknown>, index: number) => Response,
  options: Partial<GatewayOptions> = {},
) {
  const seen: { path: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const upstreamUrls: string[] = [];
  const settlements: GatewaySettlement[] = [];
  const spending: GatewaySettlement[] = [];
  const reservations: GatewayReservationRequest[] = [];
  const fake = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      seen.push({ path: new URL(request.url).pathname, headers: request.headers, body });
      return reply(body, seen.length - 1);
    },
  });
  close.push(() => fake.stop(true));
  const principal: GatewayPrincipal = {
    privacy: { kind: 'service', purpose: 'memory', spaceId: 'space_provider', sourceJobId: null },
    jobId: 'job_provider',
    attemptId: 'attempt_provider',
    epoch: 1,
    revision: 1,
    maxRequests: 10,
    maxTokens: 30_000,
    allowedModels: nemotronModels.map(({ id }) => ({ provider: 'nebius', model: id })),
  };
  const server: Server = createModelGateway({
    privacy: false,
    authenticate: async () => principal,
    providers: providersFromEnv({ NEBIUS_API_KEY: 'nebius-fixture-key' }),
    defaultProvider: 'nebius',
    vision: async (provider, model) => modelSupportsVision(provider, model),
    budget: {
      async reserve(request) {
        reservations.push(request);
        return { id: request.requestId };
      },
      async settle(_reservation, settlement) {
        settlements.push(settlement);
      },
    },
    spending: {
      async admit() {},
      async record(_principal, settlement) {
        spending.push(settlement);
      },
    },
    async fetch(request) {
      upstreamUrls.push(request.url);
      // Only transport is redirected. The built-in provider, authorization,
      // routing, metering, and response handling are the production path.
      return fetch(new Request(`${fake.url.origin}${new URL(request.url).pathname}`, request));
    },
    ...options,
  });
  close.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
  const post = (model: string, body: Record<string, unknown> = {}) =>
    fetch(`http://127.0.0.1:${address.port}/providers/nebius/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer melete-surrogate-provider',
        'x-melete-capability': 'provider-capability',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: 'Check the kettle.' }],
        ...body,
      }),
    });
  return { post, seen, upstreamUrls, settlements, spending, reservations, principal };
}

describe('Nemotron through the Token Factory provider', () => {
  for (const { id: model, costUsd } of nemotronModels) {
    test(`${model}: streams text, separates reasoning, and meters cached input and all output`, async () => {
      const gateway = await start(() => streamed(eventStream(model, textChunks(model))));
      const response = await gateway.post(model, { stream: true });
      expect(response.status).toBe(200);
      const events = readEvents(await response.text());
      expect(answerText(events)).toBe('Tea is ready. ☕');
      expect(reasoningText(events)).toBe(
        'Compare the kettle readings privately. The water is hot.',
      );
      expect(events.at(-1)?.choices).toEqual([]);
      expect(gateway.seen[0]?.body.stream_options).toEqual({ include_usage: true });
      expect(gateway.seen[0]?.body.max_tokens).toBe(4096);
      expect(gateway.upstreamUrls).toEqual([
        'https://api.tokenfactory.nebius.com/v1/chat/completions',
      ]);
      expect(gateway.seen[0]?.path).toBe('/v1/chat/completions');
      expect(gateway.seen[0]?.headers.get('authorization')).toBe('Bearer nebius-fixture-key');
      expect(gateway.seen[0]?.headers.has('x-melete-capability')).toBe(false);
      expect(gateway.settlements).toHaveLength(1);
      expect(gateway.settlements[0]).toMatchObject({
        provider: 'nebius',
        modelActual: model,
        status: 'succeeded',
        httpStatus: 200,
        usage: {
          inputTokens: 1000,
          outputTokens: 400,
          totalTokens: 1400,
          cachedInputTokens: 600,
          chargedInputTokens: 520,
        },
      });
      expect(gateway.spending).toEqual(gateway.settlements);
      const recorded = gateway.spending[0];
      if (!recorded) throw new Error('expected a recorded provider call');
      expect(settledCost(new PriceTable(), recorded)).toBe(costUsd);
      expect(JSON.stringify(gateway.settlements)).not.toContain('privately');
    });

    test(`${model}: keeps split inline thinking out of streamed answer text`, async () => {
      const gateway = await start(() => streamed(eventStream(model, inlineReasoningChunks(model))));
      const response = await gateway.post(model, { stream: true });
      const events = readEvents(await response.text());
      expect(answerText(events)).toBe('Tea is ready. ☕');
      expect(reasoningText(events)).toBe(
        'Compare the kettle readings privately. The water is hot.',
      );
      expect(gateway.settlements[0]?.usage?.outputTokens).toBe(400);
    });

    for (const parallel of [false, true]) {
      test(`${model}: preserves ${parallel ? 'parallel' : 'single'} tool calls with split arguments`, async () => {
        const gateway = await start(() =>
          streamed(eventStream(model, toolChunks(model, parallel))),
        );
        const tools = toolCalls.slice(0, parallel ? 2 : 1).map((call) => ({
          type: 'function',
          function: {
            name: call.function.name,
            description: 'Search saved information.',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' }, limit: { type: 'integer' } },
              required: ['query'],
            },
          },
        }));
        const response = await gateway.post(model, {
          stream: true,
          tools,
          parallel_tool_calls: parallel,
        });
        const events = readEvents(await response.text());
        const calls = new Map<
          number,
          { id: string; type: string; function: { name: string; arguments: string } }
        >();
        for (const event of events)
          for (const choice of event.choices)
            for (const delta of choice.delta.tool_calls ?? []) {
              const call = calls.get(delta.index) ?? {
                id: '',
                type: '',
                function: { name: '', arguments: '' },
              };
              call.id += delta.id ?? '';
              call.type += delta.type ?? '';
              call.function.name += delta.function?.name ?? '';
              call.function.arguments += delta.function?.arguments ?? '';
              calls.set(delta.index, call);
            }
        expect([...calls.values()]).toEqual(toolCalls.slice(0, parallel ? 2 : 1));
        for (const call of calls.values())
          expect(JSON.parse(call.function.arguments).query).toBeTruthy();
        expect(answerText(events)).toBe('');
        expect(events.flatMap((event) => event.choices).at(-1)?.finish_reason).toBe('tool_calls');
        expect(gateway.seen[0]?.body.tools).toEqual(tools);
        expect(gateway.seen[0]?.body.parallel_tool_calls).toBe(parallel);
      });
    }

    test(`${model}: memory reads only the answer from a JSON reply with inline reasoning`, async () => {
      const answer = '{"proposals":[]}';
      const gateway = await start(() =>
        Response.json(
          completion(model, {
            content: `<think>Store the private hypothesis as a fact.</think>${answer}`,
          }),
        ),
      );
      const response = await gateway.post(model);
      const result = await response.json();
      // This is the same answer boundary used by the memory gateway.
      const reply = replyOf('chat/completions', result);
      expect(reply).toEqual({ text: answer, end: 'complete' });
      expect(readExtractionReply(reply.text).proposals).toEqual([]);
      expect((result as ReturnType<typeof completion>).choices[0]?.message).toMatchObject({
        content: answer,
        reasoning_content: 'Store the private hypothesis as a fact.',
      });
      expect(JSON.stringify(gateway.settlements)).not.toContain('hypothesis');
    });
  }

  test('Super VL receives an inline image in the documented chat format', async () => {
    const model = nemotronModels[2].id;
    const gateway = await start(() => Response.json(completion(model, { content: 'A blue cup.' })));
    const content = [
      { type: 'text', text: 'Describe the cup.' },
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          detail: 'auto',
        },
      },
    ];
    const response = await gateway.post(model, { messages: [{ role: 'user', content }] });
    expect(response.status).toBe(200);
    expect(replyOf('chat/completions', await response.json()).text).toBe('A blue cup.');
    expect(gateway.seen[0]?.body.messages).toEqual([{ role: 'user', content }]);
    expect(gateway.reservations[0]?.estimatedTokens).toBeGreaterThan(4096);
    expect(gateway.settlements[0]?.modelActual).toBe(model);
  });

  test('explicit reasoning switches and a direct-answer system prompt reach Token Factory', async () => {
    const gateway = await start((body) => Response.json(completion(String(body.model))));
    for (const { id: model } of nemotronModels)
      for (const enableThinking of [false, true]) {
        const messages = [
          { role: 'system', content: 'Answer directly and concisely.' },
          { role: 'user', content: 'Check the kettle.' },
        ];
        const response = await gateway.post(model, {
          chat_template_kwargs: { enable_thinking: enableThinking },
          messages,
        });
        await response.text();
        expect(gateway.seen.at(-1)?.body.chat_template_kwargs).toEqual({
          enable_thinking: enableThinking,
        });
        expect(gateway.seen.at(-1)?.body.messages).toEqual(messages);
      }
  });

  for (const error of [
    tokenFactoryErrors.limited,
    tokenFactoryErrors.internal,
    tokenFactoryErrors.unavailable,
  ]) {
    test(`a ${error.status} refusal is retryable and a later call succeeds`, async () => {
      const model = nemotronModels[0].id;
      const gateway = await start((_body, index) =>
        index === 0
          ? Response.json(error.body, { status: error.status })
          : Response.json(completion(model)),
      );
      const refused = await gateway.post(model);
      expect(refused.status).toBe(error.status === 429 ? 429 : 502);
      expect(await refused.json()).toEqual({
        error: {
          code: error.status === 429 ? 'provider_rate_limited' : 'provider_down',
          message: error.status === 429 ? 'provider_rate_limited' : 'provider_down',
        },
      });
      const retried = await gateway.post(model);
      expect(retried.status).toBe(200);
      expect(replyOf('chat/completions', await retried.json()).text).toBe('Tea is ready. ☕');
      expect(gateway.reservations).toHaveLength(2);
      expect(gateway.settlements.map((settlement) => settlement.status)).toEqual([
        'failed',
        'succeeded',
      ]);
      expect(gateway.settlements[0]?.failure).toBe(
        error.status === 429 ? 'rate_limited' : 'provider_down',
      );
    });

    test(`a ${error.status} refusal retries with the configured Nemotron fallback`, async () => {
      const primary = nemotronModels[0].id;
      const backup = nemotronModels[1].id;
      const gateway = await start((body, index) =>
        index === 0
          ? Response.json(error.body, { status: error.status })
          : Response.json(completion(String(body.model))),
      );
      gateway.principal.routes = { fallback: [{ provider: 'nebius', model: backup }] };
      const response = await gateway.post(primary);
      expect(response.status).toBe(200);
      expect(replyOf('chat/completions', await response.json()).text).toBe('Tea is ready. ☕');
      expect(gateway.seen.map((call) => call.body.model)).toEqual([primary, backup]);
      expect(
        gateway.settlements.map((call) => [call.modelRequested, call.status, call.route]),
      ).toEqual([
        [primary, 'failed', undefined],
        [backup, 'succeeded', 'fallback'],
      ]);
      expect(gateway.reservations).toHaveLength(2);
    });
  }

  test('context overflow returns a clear compaction error without trying another model', async () => {
    const model = nemotronModels[0].id;
    const error = tokenFactoryErrors.context;
    const gateway = await start(() => Response.json(error.body, { status: error.status }));
    gateway.principal.routes = { fallback: [{ provider: 'nebius', model: nemotronModels[1].id }] };
    const response = await gateway.post(model);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: 'provider_context_too_long' } });
    expect(gateway.seen).toHaveLength(1);
    expect(gateway.settlements[0]).toMatchObject({
      status: 'failed',
      failure: 'context_too_long',
      httpStatus: 400,
    });
  });

  for (const finishReason of ['length', 'stop']) {
    test(`an opening think tag that never closes before a ${finishReason} finish stays separate from the answer`, async () => {
      const model = nemotronModels[0].id;
      const gateway = await start(() =>
        streamed(
          eventStream(model, [
            chunk(model, { content: '<think>Still comparing ' }),
            chunk(model, { content: 'readings.' }),
            chunk(model, {}, finishReason),
          ]),
        ),
      );
      const response = await gateway.post(model, { stream: true });
      const events = readEvents(await response.text());
      expect(answerText(events)).toBe('');
      expect(reasoningText(events)).toBe('Still comparing readings.');
      expect(events.flatMap((event) => event.choices).at(-1)?.finish_reason).toBe(finishReason);
    });
  }

  test('a closing think tag in the middle of an answer stays answer text', async () => {
    const model = nemotronModels[1].id;
    const gateway = await start(() =>
      streamed(
        eventStream(model, [
          chunk(model, { content: 'Compare readings.' }),
          chunk(model, { content: '</thi' }),
          chunk(model, { content: 'nk>Tea is ready. ☕' }),
          chunk(model, {}, 'stop'),
        ]),
      ),
    );
    const response = await gateway.post(model, { stream: true });
    const events = readEvents(await response.text());
    expect(answerText(events)).toBe('Compare readings.</think>Tea is ready. ☕');
    expect(reasoningText(events)).toBe('');
    // Text that does not open with a think tag is sent on at once.
    expect(events[0]?.choices[0]?.delta.content).toBe('Compare readings.');
  });

  test('an opening think tag in the middle of an answer stays answer text', async () => {
    const model = nemotronModels[0].id;
    const gateway = await start(() =>
      streamed(
        eventStream(model, [
          chunk(model, { content: 'Wrap notes in ' }),
          chunk(model, { content: '<think>' }),
          chunk(model, { content: ' tags.' }),
          chunk(model, {}, 'stop'),
        ]),
      ),
    );
    const response = await gateway.post(model, { stream: true });
    const events = readEvents(await response.text());
    expect(answerText(events)).toBe('Wrap notes in <think> tags.');
    expect(reasoningText(events)).toBe('');
  });

  test('a JSON reply whose think tag never closes keeps reasoning out of the memory answer', async () => {
    const model = nemotronModels[0].id;
    const content = '<think>Still comparing readings.';
    const gateway = await start(() => Response.json(completion(model, { content }, 'length')));
    const response = await gateway.post(model);
    expect(replyOf('chat/completions', await response.json())).toEqual({
      text: '',
      end: 'cut_off',
    });
  });

  test('stream events that are not JSON objects pass through unchanged', async () => {
    const model = nemotronModels[0].id;
    const events = eventStream(model, textChunks(model));
    const gateway = await start(() => streamed(`: keep-alive\r\n\r\ndata: [1,2]\r\n\r\n${events}`));
    const response = await gateway.post(model, { stream: true });
    expect(response.status).toBe(200);
    const wire = await response.text();
    expect(wire.startsWith(': keep-alive\r\n\r\ndata: [1,2]\r\n\r\n')).toBe(true);
    const parsed = readEvents(wire.replace('data: [1,2]', ''));
    expect(answerText(parsed)).toBe('Tea is ready. ☕');
  });

  test('text that is not a JSON object is left as the provider sent it', () => {
    for (const body of ['not json', '[1,2]', '"text"'])
      expect(new NemotronReply().json(body)).toBe(body);
    for (const event of ['data: not json\r\n\r\n', 'data: {"partial\n\n', 'data: 7\n\n'])
      expect(new NemotronReply().push(event)).toBe(event);
  });

  test('the reasoning alias is kept separate from answer text', async () => {
    const model = nemotronModels[0].id;
    const gateway = await start(() =>
      streamed(
        eventStream(model, [
          chunk(model, { reasoning: 'Privately compare readings.' }),
          chunk(model, { content: 'Tea is ready. ☕' }),
          chunk(model, {}, 'stop'),
        ]),
      ),
    );
    const response = await gateway.post(model, { stream: true });
    const events = readEvents(await response.text());
    expect(answerText(events)).toBe('Tea is ready. ☕');
    expect(reasoningText(events)).toBe('Privately compare readings.');
  });

  test('an in-stream server error followed by DONE cannot become a successful answer', async () => {
    const model = nemotronModels[0].id;
    const gateway = await start(() =>
      streamed(`data: ${JSON.stringify(tokenFactoryErrors.internal.body)}\n\ndata: [DONE]\n\n`),
    );
    const response = await gateway.post(model, { stream: true });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'provider_down' } });
    expect(gateway.settlements).toHaveLength(1);
    expect(gateway.settlements[0]).toMatchObject({
      status: 'unknown',
      failure: 'provider_down',
      usage: null,
    });
  });

  for (const thinking of [undefined, false, true]) {
    test(`content with no reasoning fields streams as it arrives (enable_thinking ${thinking})`, async () => {
      const model = nemotronModels[0].id;
      const gateway = await start(() =>
        streamed(
          eventStream(model, [
            chunk(model, { role: 'assistant', content: '' }),
            chunk(model, { content: 'Tea ' }),
            chunk(model, { content: 'is ready. ☕' }),
            chunk(model, {}, 'stop'),
          ]),
        ),
      );
      const response = await gateway.post(model, {
        stream: true,
        ...(thinking === undefined ? {} : { chat_template_kwargs: { enable_thinking: thinking } }),
      });
      const events = readEvents(await response.text());
      expect(answerText(events)).toBe('Tea is ready. ☕');
      expect(reasoningText(events)).toBe('');
      expect(
        events
          .flatMap((event) => event.choices)
          .filter((choice) => choice.delta.content)
          .map((choice) => [choice.delta.content, choice.finish_reason]),
      ).toEqual([
        ['Tea ', null],
        ['is ready. ☕', null],
      ]);
    });
  }

  test('an answer cut off at the output limit with no reasoning fields is still the answer', async () => {
    const model = nemotronModels[1].id;
    const gateway = await start(() =>
      streamed(
        eventStream(model, [
          chunk(model, { content: 'The kettle reads ' }),
          chunk(model, { content: 'ninety' }),
          chunk(model, {}, 'length'),
        ]),
      ),
    );
    const response = await gateway.post(model, { stream: true });
    const events = readEvents(await response.text());
    expect(answerText(events)).toBe('The kettle reads ninety');
    expect(reasoningText(events)).toBe('');
    expect(events[0]?.choices[0]?.delta.content).toBe('The kettle reads ');
  });

  test('thinking tags quoted in the final answer remain literal answer text', async () => {
    const model = nemotronModels[0].id;
    const answer = 'Use `<think>` and `</think>` as literal delimiters.';
    const gateway = await start(() =>
      streamed(
        eventStream(model, [
          chunk(model, { content: '<think>Privately choose an example.</think>' }),
          chunk(model, { content: answer }),
          chunk(model, {}, 'stop'),
        ]),
      ),
    );
    const response = await gateway.post(model, { stream: true });
    const events = readEvents(await response.text());
    expect(answerText(events)).toBe(answer);
    expect(reasoningText(events)).toBe('Privately choose an example.');
  });

  test('explicit inline reasoning is still separated when a stream ignores the off switch', async () => {
    const model = nemotronModels[0].id;
    const gateway = await start(() => streamed(eventStream(model, inlineReasoningChunks(model))));
    const response = await gateway.post(model, {
      stream: true,
      chat_template_kwargs: { enable_thinking: false },
    });
    const events = readEvents(await response.text());
    expect(answerText(events)).toBe('Tea is ready. ☕');
    expect(reasoningText(events)).toBe('Compare the kettle readings privately. The water is hot.');
  });

  test('explicit inline reasoning is still separated when a JSON reply ignores the off switch', async () => {
    const model = nemotronModels[0].id;
    const gateway = await start(() =>
      Response.json(
        completion(model, {
          content: '<think>Unexpected private reasoning.</think>{"proposals":[]}',
        }),
      ),
    );
    const response = await gateway.post(model, {
      chat_template_kwargs: { enable_thinking: false },
    });
    const reply = replyOf('chat/completions', await response.json());
    expect(reply.text).toBe('{"proposals":[]}');
    expect(readExtractionReply(reply.text).proposals).toEqual([]);
  });

  for (const [finishReason, end] of [
    ['stop', 'complete'],
    ['length', 'cut_off'],
    ['content_filter', 'refused'],
  ] as const) {
    test(`a JSON ${finishReason} finish preserves answer classification and separate reasoning`, async () => {
      const model = nemotronModels[1].id;
      const gateway = await start(() =>
        Response.json(
          completion(
            model,
            {
              content: 'Tea is ready. ☕',
              reasoning_content: 'Private comparison.',
            },
            finishReason,
          ),
        ),
      );
      const response = await gateway.post(model);
      expect(replyOf('chat/completions', await response.json())).toEqual({
        text: 'Tea is ready. ☕',
        end,
      });
    });
  }

  test('a JSON tool call and its tool result preserve the conversation format', async () => {
    const model = nemotronModels[0].id;
    const gateway = await start((_body, index) =>
      Response.json(
        index === 0
          ? completion(
              model,
              { content: null, reasoning_content: 'Check the calendar.', tool_calls: toolCalls },
              'tool_calls',
            )
          : completion(model),
      ),
    );
    const first = await gateway.post(model);
    const result = (await first.json()) as ReturnType<typeof completion>;
    expect(result.choices[0]?.message).toMatchObject({ content: null, tool_calls: toolCalls });
    const messages = [
      { role: 'user', content: 'Check the kettle.' },
      { role: 'assistant', content: null, tool_calls: toolCalls },
      ...toolCalls.map((call) => ({
        role: 'tool',
        tool_call_id: call.id,
        content: '{"items":[]}',
      })),
    ];
    const response = await gateway.post(model, { messages });
    expect(replyOf('chat/completions', await response.json()).text).toBe('Tea is ready. ☕');
    expect(gateway.seen[1]?.body.messages).toEqual(messages);
    expect(JSON.stringify(gateway.seen[1]?.body)).not.toContain('Check the calendar.');
  });
});
