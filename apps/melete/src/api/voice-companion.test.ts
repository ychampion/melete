/**
 * The companion that talks while the work runs. The real gateway and the real
 * privacy router carry every call here; only the provider is replaced, at the
 * socket, so what reaches it is what a real provider would receive.
 */
import { describe, expect, test } from 'bun:test';
import type { VoiceAsideRequest } from '@melete/contracts';
import { Hono } from 'hono';
import type { Database } from '../db/client.ts';
import type { GatewayProvider } from '../gateway/types.ts';
import { MemoryPrivacyStore, PrivacyRouter } from '../privacy/index.ts';
import { ServiceError } from './errors.ts';
import { mountVoice, type VoicePrivacy } from './voice.ts';
import {
  CANNOT_FROM_HERE,
  COMPANION_FORMAT,
  type CompanionContext,
  CUT_OFF_LINE,
  companionBody,
  companionInput,
  ON_SCREEN_LINE,
  openVoiceCompanion,
  parseCompanionReply,
  readCompanionReply,
  replyText,
  type VoiceCompanion,
  withoutClaims,
} from './voice-companion.ts';

const SPACE = 'spc_1';
const CONVERSATION = 'job_chat';

const provider: GatewayProvider = {
  name: 'openai',
  baseUrl: 'https://api.openai.com/v1/',
  apiKey: 'a-key-that-stays-inside-the-gateway',
  protocols: ['chat/completions', 'responses'],
};

const context: CompanionContext = {
  agentName: 'Melete',
  turns: [
    { said: 'What is on tomorrow?', answer: 'Two meetings and the dentist.' },
    { said: 'Compare the three hotel pages for the trip.', answer: '' },
  ],
};

const progress: VoiceAsideRequest = {
  kind: 'progress',
  activity: { now: 'Reading the third page', steps: ['Read page one', 'Read page two'] },
};

type Seen = { url: string; body: Record<string, unknown> };

/** Stands in for the provider, recording exactly what the gateway forwarded. */
function upstream(text: string, seen: Seen[], extra: Record<string, unknown> = {}) {
  return async (incoming: Request): Promise<Response> => {
    seen.push({ url: incoming.url, body: (await incoming.json()) as Record<string, unknown> });
    return Response.json({
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      model: 'gpt-6-astra',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
        ...((extra.output as unknown[]) ?? []),
      ],
      usage: { input_tokens: 300, output_tokens: 20, total_tokens: 320 },
    });
  };
}

async function withCompanion<T>(
  store: MemoryPrivacyStore,
  handler: (incoming: Request) => Promise<Response>,
  work: (companion: VoiceCompanion) => Promise<T>,
): Promise<T> {
  store.scopes.set(CONVERSATION, {
    spaceId: SPACE,
    conversationId: CONVERSATION,
    agentId: null,
    turnId: null,
  });
  const opened = await openVoiceCompanion({
    provider: 'openai',
    model: 'gpt-6-astra',
    providers: [provider],
    privacy: new PrivacyRouter({ store }),
    fetch: handler,
  });
  try {
    return await work(opened.companion);
  } finally {
    await opened.close();
  }
}

const call = (request: VoiceAsideRequest = progress) => ({
  spaceId: SPACE,
  conversationId: CONVERSATION,
  request,
  context,
});

describe('the companion has no way to act', () => {
  test('no request body it builds carries a tool, for any protocol', () => {
    const input = companionInput(progress, context);
    for (const target of [
      { provider: 'openai', model: 'gpt-6-astra' },
      { provider: 'anthropic', model: 'claude-x' },
      { provider: 'fireworks', model: 'accounts/fireworks/models/llama' },
    ]) {
      const body = companionBody(target, 'system', input) as Record<string, unknown>;
      for (const key of [
        'tools',
        'tool_choice',
        'functions',
        'function_call',
        'parallel_tool_calls',
      ])
        expect(body).not.toHaveProperty(key);
    }
  });

  test('what reaches the provider has no tools, and a tool call in the reply is ignored', async () => {
    const seen: Seen[] = [];
    const reply = JSON.stringify({ intent: 'talk', say: 'Two pages down, one to go.' });
    const answer = await withCompanion(
      new MemoryPrivacyStore(),
      upstream(reply, seen, {
        output: [{ type: 'function_call', name: 'email.send', arguments: '{}', call_id: 'c1' }],
      }),
      (companion) => companion.answer(call()),
    );
    expect(answer).toEqual({ answer: { intent: 'talk', say: 'Two pages down, one to go.' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).not.toHaveProperty('tools');
    expect(seen[0]?.body).not.toHaveProperty('tool_choice');
  });

  test('only text is read from any protocol', () => {
    expect(
      replyText('chat/completions', {
        choices: [
          { message: { content: null, tool_calls: [{ function: { name: 'files.write' } }] } },
        ],
      }),
    ).toBe('');
    expect(
      replyText('messages', {
        content: [
          { type: 'tool_use', name: 'calendar.delete', input: {} },
          { type: 'text', text: 'Still reading.' },
        ],
      }),
    ).toBe('Still reading.');
  });
});

describe('what the companion is shown and what it says', () => {
  test('it sees the conversation, the running work and what was heard', () => {
    const input = JSON.parse(
      companionInput(
        { kind: 'heard', text: 'Also check the second site.', activity: progress.activity },
        context,
      ),
    );
    expect(input.earlier).toEqual([
      { person: 'What is on tomorrow?', you: 'Two meetings and the dentist.' },
    ]);
    expect(input.working_on.asked).toBe('Compare the three hotel pages for the trip.');
    expect(input.activity).toEqual({
      done: ['Read page one', 'Read page two'],
      now: 'Reading the third page',
    });
    expect(input.heard).toBe('Also check the second site.');
  });

  test('replies are read as intent and words, and anything else as words', () => {
    expect(parseCompanionReply('{"intent":"steer","say":"I will pass that on."}')).toEqual({
      intent: 'steer',
      say: 'I will pass that on.',
    });
    expect(parseCompanionReply('```json\n{"intent":"stop","say":"Stopping now."}\n```')).toEqual({
      intent: 'stop',
      say: 'Stopping now.',
    });
    expect(parseCompanionReply('{"intent":"quiet","say":""}')).toEqual({
      intent: 'quiet',
      say: null,
    });
    expect(parseCompanionReply('{"intent":"talk","say":"  "}')).toEqual({
      intent: 'quiet',
      say: null,
    });
    expect(parseCompanionReply('I am on the last page now.')).toEqual({
      intent: 'talk',
      say: 'I am on the last page now.',
    });
    expect(parseCompanionReply('')).toEqual({ intent: 'quiet', say: null });
  });

  test('a reply cut off mid-JSON is never spoken as JSON', () => {
    const cut = [
      '{"intent":"talk","say":"I am reading the third page and',
      '{"intent":"talk","sa',
      '{"intent":',
      '```json\n{"intent":"talk","say":"Nearly there',
      '{',
      '"intent":"talk","say":"half of it"',
    ];
    for (const text of cut) {
      const aside = parseCompanionReply(text);
      expect(aside).toEqual({ intent: 'talk', say: CUT_OFF_LINE });
      expect(aside.say).not.toContain('{');
      expect(aside.say).not.toContain('"');
    }
  });

  test('a whole reply with words around it is still read, and its words never carry JSON', () => {
    expect(parseCompanionReply('Sure: {"intent":"talk","say":"On it."}')).toEqual({
      intent: 'talk',
      say: 'On it.',
    });
    expect(parseCompanionReply('{"intent":"talk","say":"{\\"intent\\":\\"talk\\""}')).toEqual({
      intent: 'talk',
      say: CUT_OFF_LINE,
    });
  });

  test('it never says out loud that something was done or approved', () => {
    expect(
      parseCompanionReply(
        '{"intent":"talk","say":"I read both pages. I have sent the email to Sam and paid the deposit. Nearly done."}',
      ),
    ).toEqual({
      intent: 'talk',
      say: `I read both pages. ${CANNOT_FROM_HERE} Nearly done.`,
    });
    expect(parseCompanionReply('Your refund was approved.')).toEqual({
      intent: 'talk',
      say: CANNOT_FROM_HERE,
    });
    expect(withoutClaims('I am drafting the email to Sam now.')).toBe(
      'I am drafting the email to Sam now.',
    );
    const long = parseCompanionReply(`${'This is a sentence. '.repeat(40)}`);
    expect(long.say?.length).toBeLessThanOrEqual(400);
    expect(long.say?.endsWith('.')).toBe(true);
  });
});

describe('the companion obeys the privacy router as chat does', () => {
  test('a sensitive conversation with no local model sends nothing to the cloud', async () => {
    const store = new MemoryPrivacyStore();
    await store.markConversation(CONVERSATION, SPACE, 'health');
    const seen: Seen[] = [];
    const answer = await withCompanion(store, upstream('{"intent":"talk","say":"x"}', seen), (c) =>
      c.answer(call()),
    );
    expect(answer).toEqual({ failed: 'refused' });
    expect(seen).toHaveLength(0);
  });

  test('a private space sends nothing to the cloud', async () => {
    const store = new MemoryPrivacyStore();
    await store.saveSettings(SPACE, { private_space: true }, null);
    const seen: Seen[] = [];
    const answer = await withCompanion(store, upstream('{"intent":"talk","say":"x"}', seen), (c) =>
      c.answer(call()),
    );
    expect(answer).toEqual({ failed: 'refused' });
    expect(seen).toHaveLength(0);
  });

  test('details are redacted on the way out and restored in what is said', async () => {
    const seen: Seen[] = [];
    const store = new MemoryPrivacyStore();
    const answer = await withCompanion(
      store,
      async (incoming) => {
        const body = (await incoming.clone().json()) as Record<string, unknown>;
        const placeholder = /⟦[A-Z_]+_\d+⟧/.exec(JSON.stringify(body))?.[0] ?? 'none';
        return upstream(
          JSON.stringify({ intent: 'talk', say: `I am writing to ${placeholder}.` }),
          seen,
        )(incoming);
      },
      (c) =>
        c.answer(
          call({
            kind: 'progress',
            activity: { now: 'Writing to sam.taylor@example.com', steps: [] },
          }),
        ),
    );
    expect(JSON.stringify(seen[0]?.body)).not.toContain('sam.taylor@example.com');
    expect('answer' in answer && answer.answer.say).toBe('I am writing to sam.taylor@example.com.');
  });
});

/* ---------- the route ---------- */

const PERSON = 'prn_01J00000000000000000000000';

function route(options: {
  companion?: VoiceCompanion | null;
  privacy?: VoicePrivacy;
  now?: () => number;
  /** What the allowance holds, so a test can see each aside counted. */
  taken?: string[];
  givenBack?: string[];
  asides?: number;
  context?: CompanionContext;
}) {
  const built = new Hono();
  built.onError((error, c) =>
    error instanceof ServiceError
      ? c.json({ error: { code: error.code, message: error.message } }, error.status)
      : c.json({ error: { code: 'internal_error', message: String(error) } }, 500),
  );
  built.use('*', async (c, next) => {
    c.set('owner', { id: PERSON, email: 'p@example.test', created_at: new Date().toISOString() });
    c.set('experienceSpaceId', SPACE);
    await next();
  });
  const taken = options.taken ?? [];
  // The conversation lookup finds the caller's own conversation.
  const db = {
    select: () => ({
      from: () => ({ where: async () => [{ id: CONVERSATION, agentId: null }] }),
    }),
  } as unknown as Database;
  mountVoice(built, {
    db,
    allowance: {
      take: async (_principal, kind, amount, limit) => {
        if (taken.length + amount > limit) return null;
        taken.push(kind);
        return `r${taken.length}`;
      },
      giveBack: async (id) => {
        options.givenBack?.push(id);
      },
    },
    providers: {
      transcription: null,
      live: {
        speak: async () => ({ body: new Response('').body as ReadableStream, mime: 'audio/mpeg' }),
        session: async () => ({ url: 'wss://x', expires_at: new Date().toISOString() }),
      },
    },
    limits: { seconds: 1800, characters: 20_000, sessions: 30, asides: options.asides ?? 600 },
    privacy: options.privacy ?? (async () => null),
    companion: options.companion === undefined ? null : options.companion,
    context: async () => options.context ?? context,
    ...(options.now ? { now: options.now } : {}),
  });
  const post = (body: unknown) =>
    built.request(`/conversations/${CONVERSATION}/voice/aside`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { post };
}

describe('the aside route', () => {
  test('a spoken answer to a question that waits on the screen is pointed there, never met with silence', async () => {
    const quiet: VoiceCompanion = {
      answer: async () => ({ answer: { intent: 'quiet', say: null } }),
    };
    const heard: VoiceAsideRequest = {
      kind: 'heard',
      text: 'Let us eat out.',
      activity: progress.activity,
    };
    const asking = { ...context, asking: true };
    const pointed = await route({ companion: quiet, context: asking }).post(heard);
    expect(await pointed.json()).toEqual({ intent: 'talk', say: ON_SCREEN_LINE });
    // A progress moment, or nothing waiting, may still be quiet.
    expect(
      await (await route({ companion: quiet, context: asking }).post(progress)).json(),
    ).toEqual({
      intent: 'quiet',
      say: null,
    });
    expect(await (await route({ companion: quiet }).post(heard)).json()).toEqual({
      intent: 'quiet',
      say: null,
    });
    // The companion is told the question is there.
    expect(JSON.parse(companionInput(heard, asking)).question_waiting_on_screen).toBe(true);
  });

  const answering = (calls: unknown[]): VoiceCompanion => ({
    answer: async (asked) => {
      calls.push(asked);
      return { answer: { intent: 'talk', say: 'Two of three pages read.' } };
    },
  });

  test('answers with what to say, and counts it against the day', async () => {
    const calls: unknown[] = [];
    const taken: string[] = [];
    const response = await route({ companion: answering(calls), taken }).post(progress);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ intent: 'talk', say: 'Two of three pages read.' });
    expect(calls).toHaveLength(1);
    expect(taken).toEqual(['aside']);
  });

  test('past the daily allowance it says so and the companion is not asked', async () => {
    const calls: unknown[] = [];
    const limited = route({ companion: answering(calls), asides: 1 });
    expect((await limited.post(progress)).status).toBe(200);
    const refused = await limited.post(progress);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'voice_daily_limit',
    );
    expect(calls).toHaveLength(1);
  });

  test('a refused call is given back; one that never came back stays counted', async () => {
    const givenBack: string[] = [];
    const refused: VoiceCompanion = { answer: async () => ({ failed: 'refused' }) };
    expect((await route({ companion: refused, givenBack }).post(progress)).status).toBe(502);
    expect(givenBack).toEqual(['r1']);
    const lost: string[] = [];
    const unanswered: VoiceCompanion = { answer: async () => ({ failed: 'unanswered' }) };
    expect((await route({ companion: unanswered, givenBack: lost }).post(progress)).status).toBe(
      502,
    );
    expect(lost).toEqual([]);
  });

  test('a private or sensitive place is refused before the companion is asked', async () => {
    for (const reason of ['private', 'sensitive'] as const) {
      const calls: unknown[] = [];
      const response = await route({
        companion: answering(calls),
        privacy: async () => reason,
      }).post({ kind: 'heard', text: 'How is it going?', activity: progress.activity });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'voice_private',
      );
      expect(calls).toHaveLength(0);
    }
  });

  test('a privacy check that fails keeps the companion quiet too', async () => {
    const calls: unknown[] = [];
    const response = await route({
      companion: answering(calls),
      privacy: async () => {
        throw new Error('settings unreadable');
      },
    }).post(progress);
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test('no companion, no answer, a bad body, or too many asides each say so plainly', async () => {
    expect((await route({}).post(progress)).status).toBe(404);
    const failing: VoiceCompanion = { answer: async () => ({ failed: 'unanswered' }) };
    expect((await route({ companion: failing }).post(progress)).status).toBe(502);
    expect(
      (await route({ companion: answering([]) }).post({ kind: 'heard', activity: {} })).status,
    ).toBe(400);
    let clock = 0;
    const limited = route({ companion: answering([]), now: () => clock });
    for (let i = 0; i < 20; i += 1) expect((await limited.post(progress)).status).toBe(200);
    expect((await limited.post(progress)).status).toBe(429);
    clock += 61_000;
    expect((await limited.post(progress)).status).toBe(200);
  });
});

describe('the aside’s answer schema', () => {
  const input = companionInput(progress, context);

  test('a provider with structured outputs is sent the schema; an unknown endpoint is not', () => {
    const openai = companionBody({ provider: 'openai', model: 'gpt-6-astra' }, 'system', input);
    expect(openai).toMatchObject({
      text: { format: { type: 'json_schema', name: 'voice_aside', strict: true } },
    });
    const claude = companionBody(
      { provider: 'anthropic', model: 'claude-opus-5-5' },
      'system',
      input,
    );
    expect(claude).toMatchObject({
      output_config: { format: { type: 'json_schema', schema: COMPANION_FORMAT.schema } },
    });
    const compatible = companionBody(
      { provider: 'openai-compatible', model: 'x' },
      'system',
      input,
    );
    expect(compatible).not.toHaveProperty('response_format');
  });

  test('the old failure: a reply cut off at the output limit is never read out', () => {
    // Recorded: the voice once spoke a cut-off JSON reply aloud.
    const cut = {
      choices: [
        {
          message: { content: '{"intent":"talk","say":"Two of the three pa' },
          finish_reason: 'length',
        },
      ],
    };
    expect(readCompanionReply('chat/completions', cut)).toEqual({
      intent: 'talk',
      say: CUT_OFF_LINE,
    });
    // Even a cut-off reply that happens to parse is not taken as whole.
    const parses = {
      content: [{ type: 'text', text: '{"intent":"stop","say":""}' }],
      stop_reason: 'max_tokens',
    };
    expect(readCompanionReply('messages', parses)).toEqual({ intent: 'talk', say: CUT_OFF_LINE });
    const whole = {
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: '{"intent":"steer","say":"I will pass that on."}' },
          ],
        },
      ],
    };
    expect(readCompanionReply('responses', whole)).toEqual({
      intent: 'steer',
      say: 'I will pass that on.',
    });
  });
});
