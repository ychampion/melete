import { expect, test } from 'bun:test';
import { type AttemptBundle, EMPTY_SINCE_LAST, type RuntimeAdapter } from '@melete/contracts';
import { withPrivacyGate } from '../privacy/gate.ts';
import type { PrivacyRouter } from '../privacy/router.ts';
import { withPreparedEngine } from './prepare.ts';

const attempt: AttemptBundle = {
  attempt: {
    id: 'att_01J00000000000000000000000',
    job_id: 'job_01J00000000000000000000000',
    epoch: 1,
    revision: 0,
    token: 'capability',
  },
  job: {
    title: 'Answer',
    objective: 'Answer the message',
    constraints: {},
    progress_summary: '',
    unresolved_questions: [],
    deliverable: {},
  },
  since_last: EMPTY_SINCE_LAST,
  inputs: { new_user_messages: [], approval_results: [], trigger_events: [], repair_briefs: [] },
  transcript: [],
  tools: [],
  skills: [],
  knowledge: [],
  workspace: { mount: '/work', files: [] },
  budget: { max_turns: 4, max_output_tokens: 1000, max_wall_ms: 10000, max_actions: 2 },
  model: { provider: 'fake', model: 'scripted', fallback: null },
  time_zone: 'UTC',
};

const preparer = (order: string[]) => (bundle: AttemptBundle) => {
  order.push(`prepare ${bundle.attempt.id}`);
  return () => order.push('give up');
};

test('the engine is got ready before the wrapped work, and given up when the attempt never starts', async () => {
  const order: string[] = [];
  const memory: RuntimeAdapter = {
    capabilities: async () => {
      throw new Error('not used');
    },
    start: async () => {
      order.push('memory');
      throw new Error('memory unavailable');
    },
  };
  const runtime = withPreparedEngine(memory, preparer(order));
  const failure = await runtime
    .start(attempt, { emit: async () => {} }, new AbortController().signal)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(order).toEqual([`prepare ${attempt.attempt.id}`, 'memory', 'give up']);
});

test('the engine loads while the privacy check runs, and a refused attempt gives it up', async () => {
  const order: string[] = [];
  const inner: RuntimeAdapter = {
    capabilities: async () => ({ streaming: true, tools: true, interrupt: true, version: 'test' }),
    start: async () => {
      order.push('engine started');
      return { kind: 'completed', summary: 'done', evidence: [] };
    },
  };
  const router = {
    async beforeAttempt() {
      order.push('privacy check');
      return { proceed: false, text: 'Keep this private?', question: null };
    },
  } as unknown as PrivacyRouter;
  const runtime = withPreparedEngine(
    withPrivacyGate(inner, { router: () => router, engineProtocol: 'chat/completions' }),
    preparer(order),
  );
  const outcome = await runtime.start(
    attempt,
    { emit: async () => {} },
    new AbortController().signal,
  );
  expect('outcome' in outcome ? outcome.outcome.kind : outcome.kind).toBe('waiting_for_input');
  expect(order).toEqual([`prepare ${attempt.attempt.id}`, 'privacy check', 'give up']);
});

test('an attempt that starts takes its engine, and what else the runtime offers stays reachable', async () => {
  const order: string[] = [];
  const inner: RuntimeAdapter & { contextInvalidated: () => Promise<void> } = {
    capabilities: async () => ({ streaming: true, tools: true, interrupt: true, version: 'test' }),
    start: async () => {
      order.push('engine started');
      return { kind: 'completed', summary: 'done', evidence: [] };
    },
    contextInvalidated: async () => {
      order.push('invalidated');
    },
  };
  const runtime = withPreparedEngine(inner, preparer(order));
  await runtime.start(attempt, { emit: async () => {} }, new AbortController().signal);
  await runtime.contextInvalidated();
  expect(order).toEqual([
    `prepare ${attempt.attempt.id}`,
    'engine started',
    'give up',
    'invalidated',
  ]);
  expect((await runtime.capabilities()).version).toBe('test');
});
