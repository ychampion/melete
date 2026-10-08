import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import {
  GATEWAY_MAX_REQUEST_BYTES,
  IMAGE_INPUT_TOKENS,
  MAX_IMAGE_ENCODED_BYTES,
  MAX_REQUEST_IMAGES,
  REQUEST_FRAMING_TOKENS,
} from '@melete/contracts';
import { compactionThresholdTokens } from '@melete/runtime-hermes';
import { markedScreenshot, unmarkedBytes } from './fixtures/screenshot.ts';
import {
  countImages,
  imageMark,
  imageTokens,
  inlineImages,
  isInlineImage,
  withoutImages,
  withoutMarks,
} from './images.ts';
import {
  createModelGateway,
  GatewayError,
  type GatewayPrincipal,
  type GatewayProvider,
  type GatewayReservationRequest,
  PICTURE_NOT_READ,
  providersFromEnv,
} from './index.ts';
import { estimateInputTokens } from './metering.ts';

const MODEL = 'accounts/fireworks/models/deepseek-v4p1-flash';

/** Base64 text of the given length, as a shrunk screenshot arrives. */
const picture = (length: number) => markedScreenshot('act_01OWNSCREEN', length);
const chatImage = (data: string) => ({
  type: 'image_url',
  image_url: { url: `data:image/jpeg;base64,${data}` },
});
const responsesImage = (data: string) => ({
  type: 'input_image',
  image_url: `data:image/jpeg;base64,${data}`,
});
const messagesImage = (data: string) => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/jpeg', data },
});

/** A tool result carrying one screenshot, the way the engine sends it over chat completions. */
const screenshotTurn = (id: string, data: string) => [
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id, type: 'function', function: { name: 'computer.screenshot', arguments: '{}' } },
    ],
  },
  {
    role: 'tool',
    tool_call_id: id,
    content: [
      { type: 'text', text: `{"status":"succeeded","action_id":"${id}"}` },
      chatImage(data),
    ],
  },
];

describe('pictures a request carries', () => {
  test('are recognised per protocol, and only when inline', () => {
    expect(isInlineImage(chatImage('AAAA'))).toBe(true);
    expect(isInlineImage(responsesImage('AAAA'))).toBe(true);
    expect(isInlineImage(messagesImage('AAAA'))).toBe(true);
    expect(isInlineImage({ type: 'image_url', image_url: 'data:image/png;base64,AAAA' })).toBe(
      true,
    );
    for (const remote of [
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      { type: 'input_image', image_url: 'https://example.com/a.png' },
      { type: 'input_image', file_id: 'file-1' },
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'image_url', image_url: { url: 'data:text/html;base64,AAAA' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'AAAA' } },
    ])
      expect(isInlineImage(remote)).toBe(false);
  });

  test('are counted, and refused past the count, the size or base64', () => {
    const body = { messages: [...screenshotTurn('a', 'AAAA'), ...screenshotTurn('b', 'AAAA')] };
    expect(countImages(body)).toBe(2);
    const many = {
      messages: Array.from({ length: MAX_REQUEST_IMAGES + 1 }, (_, i) =>
        screenshotTurn(`c${i}`, 'AAAA'),
      ).flat(),
    };
    expect(() => countImages(many)).toThrow(new GatewayError(413, 'too_many_images'));
    expect(() =>
      countImages({ input: [responsesImage(picture(MAX_IMAGE_ENCODED_BYTES + 4))] }),
    ).toThrow(new GatewayError(413, 'image_too_large'));
    expect(() => countImages({ messages: [{ content: [messagesImage('not base64!')] }] })).toThrow(
      new GatewayError(400, 'invalid_image'),
    );
  });

  test('hold the cap when one turn takes several computer steps, each with its picture', () => {
    // One assistant turn with four steps, as parallel calls and a batch make
    // routine: each result carries the screenshot taken after it.
    const steps = ['computer.click', 'computer.type', 'computer.key', 'computer.batch'];
    const turn = [
      {
        role: 'assistant',
        content: null,
        tool_calls: steps.map((name, i) => ({
          id: `s${i}`,
          type: 'function',
          function: { name, arguments: '{"step":1}' },
        })),
      },
      ...steps.map((_, i) => ({
        role: 'tool',
        tool_call_id: `s${i}`,
        content: [
          { type: 'text', text: `{"status":"succeeded","action_id":"act_STEP${i}"}` },
          chatImage(picture(1024)),
        ],
      })),
    ];
    // Sent as is, the request is past the cap and refused.
    expect(MAX_REQUEST_IMAGES).toBe(3);
    expect(() => countImages({ messages: turn })).toThrow(new GatewayError(413, 'too_many_images'));
    // The pinned engine retires every tool picture but the newest three on each
    // request it sends (agent/context_compressor.py
    // evict_stale_outbound_tool_images, called from turn_request_assembly.py and
    // chat_completion_helpers.py), leaving the older result's text in its place.
    const sent = turn.map((message, i) =>
      i > 0 && i <= steps.length - MAX_REQUEST_IMAGES
        ? { ...message, content: [{ type: 'text', text: '[screenshot removed]' }] }
        : message,
    );
    expect(countImages({ messages: sent })).toBe(MAX_REQUEST_IMAGES);
  });

  test('are replaced by text in their own protocol, leaving the input untouched', () => {
    const body = {
      input: [{ type: 'function_call_output', output: [responsesImage('AAAA')] }],
      messages: [{ role: 'user', content: [messagesImage('AAAA'), chatImage('AAAA')] }],
    };
    const copy = structuredClone(body);
    expect(withoutImages(body, 'gone')).toEqual({
      input: [{ type: 'function_call_output', output: [{ type: 'input_text', text: 'gone' }] }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'gone' },
            { type: 'text', text: 'gone' },
          ],
        },
      ],
    });
    expect(body).toEqual(copy);
  });

  test('name the action they came from, and lose that mark before they are sent', () => {
    const action = 'act_01OWNSCREEN';
    expect(imageMark(chatImage(markedScreenshot(action)))).toBe(action);
    expect(imageMark(messagesImage(markedScreenshot(action)))).toBe(action);
    expect(imageMark(responsesImage(markedScreenshot(action)))).toBe(action);
    for (const unmarked of [
      markedScreenshot(null),
      markedScreenshot('computer'),
      markedScreenshot('act_../../x'),
      'AAAA',
      'iVBORw0KGgo=',
    ])
      expect(imageMark(chatImage(unmarked))).toBeNull();
    const body = {
      messages: [
        {
          content: [
            chatImage(markedScreenshot(action)),
            messagesImage(markedScreenshot(action)),
            responsesImage(markedScreenshot(action)),
            {
              ...chatImage(markedScreenshot(action)),
              image_url: {
                url: `data:image/jpeg;base64,${markedScreenshot(action)}`,
                detail: 'high',
              },
            },
          ],
        },
      ],
    };
    const clean = withoutMarks(body);
    const expected = unmarkedBytes(action).toString('base64');
    expect(clean).toEqual({
      messages: [
        {
          content: [
            chatImage(expected),
            messagesImage(expected),
            responsesImage(expected),
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${expected}`, detail: 'high' },
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(clean)).not.toContain(
      Buffer.from('melete-screenshot').toString('base64').slice(0, 12),
    );
    for (const image of inlineImages(clean)) expect(imageMark(image)).toBeNull();
    // A body with nothing to take out is the same object.
    const plain = { messages: [{ content: [chatImage(markedScreenshot(null))] }] };
    expect(withoutMarks(plain)).toBe(plain);
  });

  test('are charged the flat count the engine compacts by, not their bytes', () => {
    const data = picture(MAX_IMAGE_ENCODED_BYTES);
    const body = { messages: screenshotTurn('a', data) };
    const { tokens, text } = imageTokens(body);
    expect(tokens).toBe(IMAGE_INPUT_TOKENS);
    expect(JSON.stringify(text)).not.toContain(data);
    // Counted as text, one picture alone would be some 33,000 tokens.
    expect(estimateInputTokens(JSON.stringify(body))).toBeGreaterThan(30_000);
    expect(estimateInputTokens(JSON.stringify(text))).toBeLessThan(100);
  });
});

describe('the gateway forwards screenshots within its limits', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
    );
  });

  async function start() {
    const principal: GatewayPrincipal = {
      privacy: { kind: 'job' },
      jobId: 'job-test',
      attemptId: 'attempt-test',
      epoch: 1,
      revision: 1,
      maxRequests: 10,
      maxTokens: 20_000,
      allowedModels: [{ provider: 'fireworks', model: MODEL }],
    };
    const reservations: GatewayReservationRequest[] = [];
    const sent: string[] = [];
    const server = createModelGateway({
      // The transport alone: what the router lets through is router.test.ts's.
      privacy: false,
      authenticate: async () => principal,
      budget: {
        reserve: async (request) => {
          reservations.push(request);
          return { id: String(reservations.length) };
        },
        settle: async () => {},
      },
      providers: providersFromEnv({ FIREWORKS_API_KEY: 'fw-key' }),
      defaultProvider: 'fireworks',
      fetch: async (request) => {
        sent.push(await request.text());
        return Response.json({
          model: MODEL,
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      },
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
    const post = (body: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${address.port}/providers/fireworks/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer melete-surrogate-test',
          'x-melete-capability': 'attempt',
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 100, ...body }),
      });
    return { post, reservations, sent };
  }

  test('a screenshot reaches the provider as a picture, charged as one', async () => {
    const { post, reservations, sent } = await start();
    const data = picture(64 * 1024);
    const messages = [{ role: 'user', content: 'look' }, ...screenshotTurn('call_1', data)];
    const response = await post({ messages });
    expect(response.status).toBe(200);
    const forwarded = JSON.parse(sent[0] ?? '{}');
    // The runtime's mark is taken out; the picture is otherwise as it was.
    expect(forwarded.messages[2].content[1]).toEqual(
      chatImage(unmarkedBytes('act_01OWNSCREEN', 64 * 1024).toString('base64')),
    );
    const textOnly = estimateInputTokens(
      JSON.stringify(withoutImages({ model: MODEL, messages, max_tokens: 100 }, '')),
    );
    expect(reservations[0]?.estimatedTokens).toBe(
      textOnly + IMAGE_INPUT_TOKENS + REQUEST_FRAMING_TOKENS + 100,
    );
  });

  test('a picture named by address, too many pictures, or one too large is refused before anything is reserved', async () => {
    const { post, reservations, sent } = await start();
    const remote = await post({
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x.test/a' } }] },
      ],
    });
    expect(remote.status).toBe(400);
    const many = await post({
      messages: Array.from({ length: MAX_REQUEST_IMAGES + 1 }, (_, i) =>
        screenshotTurn(`call_${i}`, 'AAAA'),
      ).flat(),
    });
    expect(many.status).toBe(413);
    const large = await post({
      messages: screenshotTurn('call_big', picture(MAX_IMAGE_ENCODED_BYTES + 4)),
    });
    expect(large.status).toBe(413);
    expect(reservations).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test('the kept screenshots at their largest and the text at the compaction trigger fit the body limit', async () => {
    const { post, sent } = await start();
    // The text the engine may hold before it compacts, for a model that reads
    // images, at the engine's four characters to the token.
    const threshold = compactionThresholdTokens({ contextWindow: 1_000_000, vision: true });
    const text = 'x'.repeat(threshold * 4);
    const messages = [
      { role: 'user', content: text },
      ...Array.from({ length: MAX_REQUEST_IMAGES }, (_, i) =>
        screenshotTurn(`call_${i}`, picture(MAX_IMAGE_ENCODED_BYTES)),
      ).flat(),
    ];
    const body = JSON.stringify({ model: MODEL, max_tokens: 100, messages });
    expect(Buffer.byteLength(body)).toBeLessThan(GATEWAY_MAX_REQUEST_BYTES);
    const response = await post({ messages });
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
  });
});

describe('a model that reads no pictures is sent none, whatever the deployment', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
    );
  });
  /** A model on the person's own machine, as a local install names one. */
  const LOCAL: GatewayProvider = {
    name: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1/',
    apiKey: 'local',
    allowHttp: true,
    protocols: ['chat/completions'],
  };

  // No file store and so no attachments: the picture guard asks the model settings alone.
  async function start(provider: 'fireworks' | 'ollama', reads: boolean) {
    const model = provider === 'ollama' ? 'llama3.1' : MODEL;
    const principal: GatewayPrincipal = {
      privacy: { kind: 'job' },
      jobId: 'job-test',
      attemptId: 'attempt-test',
      epoch: 1,
      revision: 1,
      maxRequests: 10,
      maxTokens: 20_000,
      allowedModels: [{ provider, model }],
    };
    const sent: string[] = [];
    const server = createModelGateway({
      privacy: false,
      authenticate: async () => principal,
      budget: { reserve: async () => ({ id: '1' }), settle: async () => {} },
      providers: [...providersFromEnv({ FIREWORKS_API_KEY: 'fw-key' }), LOCAL],
      defaultProvider: 'fireworks',
      vision: async () => reads,
      fetch: async (request) => {
        sent.push(await request.text());
        return Response.json({
          model,
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      },
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
    const messages = [
      { role: 'user', content: 'look' },
      ...screenshotTurn('call_1', picture(4096)),
    ];
    const response = await fetch(
      `http://127.0.0.1:${address.port}/providers/${provider}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer melete-surrogate-test',
          'x-melete-capability': 'attempt',
        },
        body: JSON.stringify({ model, max_tokens: 100, messages }),
      },
    );
    expect(response.status).toBe(200);
    return sent[0] ?? '';
  }

  for (const provider of ['fireworks', 'ollama'] as const)
    test(`${provider === 'ollama' ? 'a local model' : 'a cloud model with no file store'}: pictures go only where they are read`, async () => {
      const blind = await start(provider, false);
      expect(blind).not.toContain('image_url');
      expect(blind).toContain(PICTURE_NOT_READ.slice(1, 40));
      const seeing = await start(provider, true);
      expect(seeing).toContain('image_url');
      expect(seeing).not.toContain(PICTURE_NOT_READ.slice(1, 40));
    });
});
