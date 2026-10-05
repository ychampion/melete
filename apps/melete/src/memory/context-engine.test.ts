import { expect, test } from 'bun:test';
import { type AttemptBundle, EMPTY_SINCE_LAST, type RuntimeAdapter } from '@melete/contracts';
import { withMemoryRuntime } from './context.ts';
import type { MemorySql } from './db.ts';

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

const engine: RuntimeAdapter = {
  capabilities: async () => {
    throw new Error('not used');
  },
  start: async () => {
    throw new Error('not reached');
  },
};

test("the engine is got ready before the attempt's memory is read, and given up when the attempt never starts", async () => {
  const order: string[] = [];
  const runtime = withMemoryRuntime(
    engine,
    (() => {
      throw new Error('no database here');
    }) as unknown as MemorySql,
    async () => {
      order.push('memory');
      throw new Error('memory unavailable');
    },
    {
      prepareEngine: (bundle) => {
        order.push(`prepare ${bundle.attempt.id}`);
        return () => order.push('give up');
      },
    },
  );
  const failure = await runtime
    .start(attempt, { emit: async () => {} }, new AbortController().signal)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(order).toEqual([`prepare ${attempt.attempt.id}`, 'memory', 'give up']);
});
