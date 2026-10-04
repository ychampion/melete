import { describe, expect, test } from 'bun:test';
import type {
  AttemptBundle,
  AttemptOutcome,
  RuntimeAdapter,
  RuntimeEvent,
} from '@melete/contracts';
import { signCapability } from '../broker/capability.ts';
import { withPlaceholderResolution } from './broker.ts';
import { CHECK_FAILED, withPrivacyGate } from './gate.ts';
import { KEEP_PRIVATE, PrivacyRouter, SEND_REDACTED } from './router.ts';
import { MemoryPrivacyStore } from './store.ts';
import { Vault } from './vault.ts';

const JOB = 'job_01J00000000000000000000000';
const SPACE = 'sp_01J00000000000000000000000';
const attemptId = (n: number) => `att_01J0000000000000000000000${n}`;

function bundle(n: number, text: string, at = new Date().toISOString()): AttemptBundle {
  return {
    attempt: { id: attemptId(n), job_id: JOB, epoch: n, revision: 0, token: 't' },
    job: {
      title: 'Chat',
      objective: 'Help with what the person asks',
      constraints: {},
      progress_summary: '',
      unresolved_questions: [],
      deliverable: {},
    },
    inputs: {
      new_user_messages: [{ role: 'user', content: text, at }],
      approval_results: [],
      trigger_events: [],
    },
  } as unknown as AttemptBundle;
}

function harness(settings: Record<string, unknown> = { private_space: true }) {
  const store = new MemoryPrivacyStore();
  store.scopes.set(JOB, { spaceId: SPACE, conversationId: JOB, agentId: null, turnId: 'trn_1' });
  void store.saveSettings(SPACE, settings, null);
  const router = new PrivacyRouter({ store, resolve: async () => [{ address: '93.184.216.34' }] });
  const started: string[] = [];
  const inner: RuntimeAdapter = {
    capabilities: async () => ({ streaming: true, tools: true, interrupt: true, version: 'test' }),
    start: async (value) => {
      started.push(value.attempt.id);
      return { kind: 'completed', summary: 'done', evidence: [] } satisfies AttemptOutcome;
    },
  };
  const gated = withPrivacyGate(inner, {
    router: () => router,
    engineProtocol: 'chat/completions',
  });
  const events: RuntimeEvent[] = [];
  const run = (value: AttemptBundle) =>
    gated.start(
      value,
      { emit: async (event) => void events.push(event) },
      new AbortController().signal,
    );
  return { store, router, started, events, run, gated };
}

describe('asking before a private conversation leaves the machine', () => {
  test('with no local model the engine is not started and the person is asked', async () => {
    const { run, started, events, store } = harness();
    const result = await run(bundle(1, 'hello'));
    expect(started).toEqual([]);
    expect(result).toMatchObject({
      outcome: { kind: 'waiting_for_input' },
      questions: [
        {
          options: [
            { id: 'send_redacted', label: SEND_REDACTED },
            { id: 'keep_private', label: KEEP_PRIVATE },
          ],
          because: [`job:${JOB}`],
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'text_delta', local_seq: 0 });
    expect((await store.conversation(JOB)).askedAttemptId).toBe(attemptId(1));
  });

  test('"Send a redacted version" lets the next attempt run, and it stays agreed', async () => {
    const { run, started, store } = harness();
    await run(bundle(1, 'hello'));
    store.answers.set(attemptId(1), SEND_REDACTED);
    await run(bundle(2, SEND_REDACTED));
    expect(started).toEqual([attemptId(2)]);
    expect((await store.conversation(JOB)).consent).toBe('allowed');
    await run(bundle(3, 'next thing'));
    expect(started).toEqual([attemptId(2), attemptId(3)]);
  });

  test('"Keep it private" sends nothing; the next message asks again', async () => {
    const { run, started, store } = harness();
    await run(bundle(1, 'hello'));
    store.answers.set(attemptId(1), KEEP_PRIVATE);
    const declined = await run(bundle(2, KEEP_PRIVATE));
    expect(started).toEqual([]);
    expect(declined).toMatchObject({ outcome: { kind: 'waiting_for_input' }, questions: [] });
    // A new turn is a new request: the person is asked again.
    store.scopes.set(JOB, { spaceId: SPACE, conversationId: JOB, agentId: null, turnId: 'trn_2' });
    const again = await run(bundle(3, 'another thing'));
    expect(started).toEqual([]);
    expect((again as { questions: unknown[] }).questions).toHaveLength(1);
  });

  test('a sensitive topic asks even when the space is not private', async () => {
    const { run, started, store } = harness({});
    const result = await run(bundle(1, 'Can you go through my bank statements for last year?'));
    expect(started).toEqual([]);
    expect((result as { outcome: { question: string } }).outcome.question).toContain(
      'personal finances',
    );
    expect((await store.conversation(JOB)).sensitive).toBe('finance');
  });

  test('an ordinary conversation, or one with a local model, starts at once', async () => {
    const plain = harness({});
    await plain.run(bundle(1, 'What is on my calendar tomorrow?'));
    expect(plain.started).toEqual([attemptId(1)]);
    const local = harness({
      private_space: true,
      local_model: { base_url: 'http://localhost:11434/v1', model: 'llama3.3' },
    });
    await local.run(bundle(1, 'hello'));
    expect(local.started).toEqual([attemptId(1)]);
  });

  test('a check that fails holds the request and says nothing was sent', async () => {
    const { run, started, events, router } = harness({});
    router.beforeAttempt = async () => {
      throw new Error('the privacy store is unavailable');
    };
    const result = await run(bundle(1, 'My therapist said I should write this down'));
    expect(started).toEqual([]);
    expect(result).toEqual({
      outcome: { kind: 'waiting_for_input', question: CHECK_FAILED },
      questions: [],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'text_delta', text: CHECK_FAILED });
    expect(CHECK_FAILED).toContain('has not sent anything');
  });

  test('after "It isn\'t", only a phrase the person writes later about themselves asks again', async () => {
    const { run, started, store } = harness({});
    const before = new Date(Date.now() - 60_000).toISOString();
    const held = 'My therapist says I should write down how the week went';
    await run(bundle(1, held, before));
    expect((await store.conversation(JOB)).sensitive).toBe('therapy');
    // The person says it is not sensitive; the message that was held goes on.
    await store.markConversation(JOB, SPACE, null);
    await run(bundle(2, held, before));
    expect(started).toEqual([attemptId(2)]);
    // What a page or a file said, carried forward, and passing topic words are not enough.
    const carried = bundle(3, 'Thanks, what about anxiety, mood and coping at work?');
    (carried.job as { progress_summary: string }).progress_summary =
      'A page said: my therapist and my bank statements are not involved.';
    await run(carried);
    expect(started).toEqual([attemptId(2), attemptId(3)]);
    expect(await store.conversation(JOB)).toMatchObject({ sensitive: null, cleared: true });
    // A phrase about themselves, written after they cleared it, marks it again and asks.
    const after = new Date(Date.now() + 1_000).toISOString();
    const later = await run(bundle(4, 'I was diagnosed with diabetes last month', after));
    expect(started).toEqual([attemptId(2), attemptId(3)]);
    expect((later as { questions: unknown[] }).questions).toHaveLength(1);
    expect(await store.conversation(JOB)).toMatchObject({ sensitive: 'health', cleared: false });
  });

  test('other runtime methods pass through the gate', async () => {
    const { gated } = harness();
    expect((await gated.capabilities()).version).toBe('test');
  });
});

describe('the broker resolves placeholders a payload still carries', () => {
  const KEY = 'k'.repeat(40);
  const token = signCapability(
    {
      job_id: JOB,
      attempt_id: attemptId(1),
      space_id: SPACE,
      epoch: 1,
      revision: 0,
      scopes: [],
      budget: { max_actions: 1, max_output_tokens: 1, max_usd_est: 0 },
      exp: Math.floor(Date.now() / 1000) + 600,
    },
    KEY,
  );

  async function setup() {
    const store = new MemoryPrivacyStore();
    store.scopes.set(JOB, { spaceId: SPACE, conversationId: JOB, agentId: null, turnId: 't' });
    const vault = new Vault();
    vault.assign('account', '000123456789');
    await store.saveVault(JOB, SPACE, vault);
    const router = new PrivacyRouter({ store });
    const seen: { path: string; body: string }[] = [];
    const broker = withPlaceholderResolution(
      async (request) => {
        seen.push({ path: new URL(request.url).pathname, body: await request.text() });
        return Response.json({ status: 'needs_approval' }, { status: 201 });
      },
      { capabilityKey: KEY, router: () => router },
    );
    return { broker, seen };
  }

  // The plugin serialises with Python's json.dumps, which escapes ⟦ as ⟦.
  const pythonJson = (value: unknown) =>
    JSON.stringify(value).replace(
      /[\u0080-￿]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );

  test('"pay ⟦ACCOUNT_1⟧" reaches the broker as the real account, so the approval shows it', async () => {
    const { broker, seen } = await setup();
    const response = await broker(
      new Request('http://broker.internal/actions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: pythonJson({
          kind: 'payments.send',
          connection_id: 'conn_x',
          payload: { to_account: '⟦ACCOUNT_1⟧', memo: 'rent from ⟦ACCOUNT_1⟧' },
          client_ref: 'r',
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(JSON.parse(seen[0]?.body ?? '{}').payload).toEqual({
      to_account: '000123456789',
      memo: 'rent from 000123456789',
    });
  });

  test('a placeholder this conversation never made is refused, not sent', async () => {
    const { broker, seen } = await setup();
    const response = await broker(
      new Request('http://broker.internal/actions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'payments.send', payload: { to_account: '⟦ACCOUNT_7⟧' } }),
      }),
    );
    expect(response.status).toBe(400);
    expect(
      ((await response.json()) as { error: { code: string; message: string } }).error,
    ).toMatchObject({
      code: 'payload_invalid',
    });
    expect(seen).toEqual([]);
  });

  test('bodies without placeholders, and other routes, pass untouched', async () => {
    const { broker, seen } = await setup();
    const body = JSON.stringify({ kind: 'mail.search', payload: { query: 'rent' } });
    await broker(
      new Request('http://broker.internal/actions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
      }),
    );
    await broker(
      new Request('http://broker.internal/tools', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(seen).toEqual([
      { path: '/actions', body },
      { path: '/tools', body: '' },
    ]);
  });
});

describe('the check judges the model the attempt runs on', () => {
  const LOCAL = 'http://127.0.0.1:11434/v1';
  // The person confirmed the server's default address is a model they run.
  const confirmed = { private_space: true, model_on_device_url: LOCAL };
  const withModel = (n: number, provider: string, model: string) =>
    ({ ...bundle(n, 'hello'), model: { provider, model, fallback: null } }) as AttemptBundle;
  const gate = (engineFor?: Parameters<typeof withPrivacyGate>[1]['engineFor']) => {
    const store = new MemoryPrivacyStore();
    store.scopes.set(JOB, { spaceId: SPACE, conversationId: JOB, agentId: null, turnId: 'trn_1' });
    void store.saveSettings(SPACE, confirmed, null);
    const router = new PrivacyRouter({
      store,
      resolve: async () => [{ address: '93.184.216.34' }],
    });
    const started: string[] = [];
    const gated = withPrivacyGate(
      {
        capabilities: async () => ({ streaming: true, tools: true, interrupt: true, version: 't' }),
        start: async (value) => {
          started.push(value.attempt.id);
          return { kind: 'completed', summary: 'done', evidence: [] } satisfies AttemptOutcome;
        },
      },
      {
        router: () => router,
        engineProtocol: 'chat/completions',
        providerUrl: LOCAL,
        ...(engineFor ? { engineFor } : {}),
      },
    );
    const run = (value: AttemptBundle) =>
      gated.start(value, { emit: async () => {} }, new AbortController().signal);
    return { run, started };
  };
  const engines = async (model: { provider: string }) =>
    model.provider === 'openai-compatible'
      ? { protocol: 'chat/completions' as const, providerUrl: LOCAL }
      : {
          protocol: 'chat/completions' as const,
          providerUrl: 'https://api.fireworks.ai/inference/v1',
        };

  test('an attempt on a cloud model in a private space asks first, though the default is on-device', async () => {
    const { run, started } = gate(engines);
    const result = await run(withModel(1, 'fireworks', 'accounts/fireworks/models/small'));
    expect(started).toEqual([]);
    expect(result).toMatchObject({ outcome: { kind: 'waiting_for_input' } });
  });

  test('an attempt on the confirmed on-device model goes ahead', async () => {
    const { run, started } = gate(engines);
    await run(withModel(2, 'openai-compatible', 'llama3.3'));
    expect(started).toEqual([attemptId(2)]);
  });
});
