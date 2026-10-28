import { describe, expect, test } from 'bun:test';
import type { PrivacySeen } from '@melete/contracts';
import { Hono } from 'hono';
import { ServiceError } from '../api/errors.ts';
import type { GatewayPrincipal, GatewayProvider } from '../gateway/types.ts';
import { PrivacyRouter } from './router.ts';
import { mountPrivacy } from './routes.ts';
import { SEEN_PART_LIMIT, sentParts } from './seen.ts';
import { MemoryPrivacyStore } from './store.ts';

const SPACE = 'sp_01J00000000000000000000000';
const CHAT = 'job_01J00000000000000000000000';
const OWNER = 'own_01J0000000000000000000000O';
const MEMBER = 'own_01J0000000000000000000000M';
const ACCOUNT = '000123456789';
const PHONE = '(415) 555-0132';

const provider: GatewayProvider = {
  name: 'fireworks',
  baseUrl: 'https://api.fireworks.ai/inference/v1/',
  apiKey: 'k',
  protocols: ['chat/completions'],
};
const principal: GatewayPrincipal = {
  privacy: { kind: 'job' },
  jobId: CHAT,
  attemptId: `att_${CHAT}`,
  epoch: 1,
  revision: 1,
  maxRequests: 50,
  maxTokens: 20_000,
  allowedModels: [],
};

const LETTER = JSON.stringify({
  from: 'Harbor Savings',
  subject: 'Your statement is ready',
  body: `Your statement for account ${ACCOUNT} is ready. Questions? Call us on ${PHONE}.`,
});

/** The person asks, the agent reads one mail item, and the result goes back to the model. */
const withMail = (ask: string) => ({
  model: 'cloud-model',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: ask },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'mail.read', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: LETTER },
  ],
});

function setup(turnId = 'trn_1') {
  const store = new MemoryPrivacyStore();
  store.scopes.set(CHAT, { spaceId: SPACE, conversationId: CHAT, agentId: null, turnId });
  store.people.set(CHAT, MEMBER);
  return { store, router: new PrivacyRouter({ store }) };
}

const send = (router: PrivacyRouter, body: Record<string, unknown>) =>
  router.prepare({ principal, provider, protocol: 'chat/completions', body });

const sentText = (seen: PrivacySeen, index: number) =>
  seen.parts[index]?.segments
    .map((segment) => ('text' in segment ? segment.text : segment.placeholder))
    .join('');
const shownText = (seen: PrivacySeen, index: number) =>
  seen.parts[index]?.segments
    .map((segment) => ('text' in segment ? segment.text : (segment.value ?? segment.placeholder)))
    .join('');

describe('what the model saw', () => {
  test('a mail item with an account and a phone number shows both sides, values only from the vault', async () => {
    const { store, router } = setup();
    await send(router, withMail('What does the letter from my bank say?'));

    // What is kept is what left: placeholders, never the values.
    const kept = JSON.stringify(store.seenParts);
    expect(kept).not.toContain(ACCOUNT);
    expect(kept).not.toContain('555-0132');
    expect(kept).not.toContain('helpful assistant');

    const seen = await router.seen(CHAT, SPACE, 'trn_1');
    expect(seen.route).toBe('cloud');
    expect(seen.parts.map((part) => [part.source, part.tool])).toEqual([
      ['you', null],
      ['tool', 'mail.read'],
    ]);
    expect(seen.parts[0]?.segments).toEqual([{ text: 'What does the letter from my bank say?' }]);
    const swapped = seen.parts[1]?.segments.filter((segment) => 'placeholder' in segment);
    expect(swapped).toEqual([
      { placeholder: '⟦ACCOUNT_1⟧', category: 'account', value: ACCOUNT },
      { placeholder: '⟦PHONE_1⟧', category: 'phone', value: PHONE },
    ]);
    expect(sentText(seen, 1)).toContain('statement for account ⟦ACCOUNT_1⟧ is ready');
    expect(sentText(seen, 1)).not.toContain(ACCOUNT);
    expect(shownText(seen, 1)).toContain(`statement for account ${ACCOUNT} is ready`);
    expect(shownText(seen, 1)).toContain(`Call us on ${PHONE}.`);
    expect(seen.categories).toEqual([
      { category: 'account', count: 1 },
      { category: 'phone', count: 1 },
    ]);
  });

  test('a turn with nothing to swap says so: the pieces carry no placeholders', async () => {
    const { router } = setup();
    await send(router, {
      model: 'cloud-model',
      messages: [{ role: 'user', content: 'Plan a quiet Sunday walk near the river.' }],
    });
    const seen = await router.seen(CHAT, SPACE, 'trn_1');
    expect(seen).toEqual({
      route: 'cloud',
      parts: [
        {
          source: 'you',
          tool: null,
          truncated: false,
          segments: [{ text: 'Plan a quiet Sunday walk near the river.' }],
        },
      ],
      categories: [],
    });
  });

  test('a re-sent piece stays with the turn that first sent it', async () => {
    const { store, router } = setup('trn_1');
    const first = withMail('What does the letter from my bank say?');
    await send(router, first);
    await send(router, first);
    store.scopes.set(CHAT, {
      spaceId: SPACE,
      conversationId: CHAT,
      agentId: null,
      turnId: 'trn_2',
    });
    await send(router, {
      ...first,
      messages: [
        ...first.messages,
        { role: 'assistant', content: 'It says your statement is ready.' },
        { role: 'user', content: 'Thanks. Remind me to read it tonight.' },
      ],
    });
    expect((await router.seen(CHAT, SPACE, 'trn_1')).parts).toHaveLength(2);
    const second = await router.seen(CHAT, SPACE, 'trn_2');
    expect(second.parts.map((part) => part.segments)).toEqual([
      [{ text: 'Thanks. Remind me to read it tonight.' }],
    ]);
  });

  test('an answer with no record has no route and no pieces', async () => {
    const { router } = setup();
    expect(await router.seen(CHAT, SPACE, 'trn_none')).toEqual({
      route: null,
      parts: [],
      categories: [],
    });
  });

  test('tool results are named in every protocol, and a long one is cut whole', () => {
    const long = `${'a'.repeat(SEEN_PART_LIMIT - 4)} ⟦ACCOUNT_1⟧ tail`;
    const parts = sentParts(
      {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Read my mail' }] },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'mail.search', input: {} }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: long }],
          },
        ],
      },
      'messages',
    );
    expect(parts.map((part) => [part.source, part.tool, part.truncated])).toEqual([
      ['you', null, false],
      ['tool', 'mail.search', true],
    ]);
    expect(parts[1]?.text.endsWith(' ')).toBe(true);
    expect(parts[1]?.text).not.toContain('⟦');

    const responses = sentParts(
      {
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'Any bills?' }] },
          { type: 'function_call', call_id: 'c1', name: 'mail.search', arguments: '{}' },
          { type: 'function_call_output', call_id: 'c1', output: 'One from City Water.' },
        ],
      },
      'responses',
    );
    expect(responses.map((part) => [part.source, part.tool, part.text])).toEqual([
      ['you', null, 'Any bills?'],
      ['tool', 'mail.search', 'One from City Water.'],
    ]);
  });
});

/** The route as a signed-in person in a shared space reaches it. */
async function as(principalId: string, role: 'owner' | 'member') {
  const { router } = setup();
  await send(router, withMail('What does the letter from my bank say?'));
  const app = new Hono();
  app.onError((error, c) =>
    error instanceof ServiceError
      ? c.json({ error: { code: error.code } }, error.status)
      : c.json({ error: { code: 'internal_error' } }, 500),
  );
  app.use(async (c, next) => {
    c.set('experienceSpaceId', SPACE);
    c.set('sessionSpace', { spaceId: SPACE, kind: 'shared', role } as never);
    c.set('owner', { id: principalId, email: 'person@example.test', created_at: '' });
    await next();
  });
  mountPrivacy(app, { router: () => router });
  return app.request(`/conversations/${CHAT}/privacy/seen`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turn_id: 'trn_1' }),
  });
}

describe('who sees what the model saw', () => {
  test('the person whose conversation it is sees it, uncached', async () => {
    const response = await as(MEMBER, 'member');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const seen = (await response.json()) as PrivacySeen;
    expect(JSON.stringify(seen)).toContain(ACCOUNT);
  });

  test("the space's owner does not see a member's", async () => {
    const response = await as(OWNER, 'owner');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: 'scope_denied' } });
  });

  test('someone else in the space does not either', async () => {
    const response = await as('own_01J0000000000000000000000X', 'member');
    expect(response.status).toBe(403);
  });
});
