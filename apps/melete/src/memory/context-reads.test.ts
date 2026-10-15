import { expect, test } from 'bun:test';
import { type AttemptBundle, EMPTY_SINCE_LAST, type RuntimeAdapter } from '@melete/contracts';
import { withMemoryRuntime } from './context.ts';
import type { MemoryScope, MemorySql } from './db.ts';

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

test("an attempt's memory scope, privacy and agent are read together, not one after another", async () => {
  const order: string[] = [];
  // Answers the question about the agent, then has nothing more: the recall after it fails.
  const sql = ((strings: TemplateStringsArray) => {
    if (strings.join('?').includes('reads_memory')) {
      order.push('agent');
      return Promise.resolve([{ reads_memory: true }]);
    }
    return Promise.reject(new Error('no more database here'));
  }) as unknown as MemorySql;
  const runtime = withMemoryRuntime(
    engine,
    sql,
    async () => {
      order.push('scope asked');
      await Bun.sleep(20);
      order.push('scope answered');
      return {
        ownerId: 'own_01J00000000000000000000000',
        spaceId: 'sp_01J00000000000000000000000',
        publisher: 'service',
        audience: 'private',
        role: 'owner',
      } satisfies MemoryScope;
    },
    {
      recallsPrivateMemory: async () => {
        order.push('privacy');
        return false;
      },
    },
  );
  const failure = await runtime
    .start(attempt, { emit: async () => {} }, new AbortController().signal)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(order.slice(0, 4)).toEqual(['scope asked', 'privacy', 'agent', 'scope answered']);
});
