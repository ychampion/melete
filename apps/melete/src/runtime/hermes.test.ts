import { expect, test } from 'bun:test';
import { type AttemptBundle, EMPTY_SINCE_LAST } from '@melete/contracts';
import type { MemorySql } from '../memory/db.ts';
import { SupervisedHermesRuntime } from './hermes.ts';

test('an oversized assembled prompt is refused before launching an engine', async () => {
  let launched = false;
  const runtime = new SupervisedHermesRuntime(
    {
      kind: 'process',
      launch: async () => {
        launched = true;
        throw new Error('must not launch');
      },
      close: async () => {},
    },
    (() => {
      throw new Error('must not query');
    }) as unknown as MemorySql,
  );
  const bundle = {
    job: {
      title: 'Too large',
      objective: 'x'.repeat(128000),
      constraints: {},
      progress_summary: '',
      unresolved_questions: [],
    },
    since_last: EMPTY_SINCE_LAST,
    inputs: { new_user_messages: [], approval_results: [], trigger_events: [], repair_briefs: [] },
    transcript: [],
    skills: [],
    knowledge: [],
    tools: [],
    workspace: { mount: '/work' },
    model: { model: 'scripted' },
    budget: { max_output_tokens: 8000, max_turns: 8, max_actions: 3 },
  } as unknown as AttemptBundle;
  const outcome = await runtime.start(
    bundle,
    { emit: async () => {} },
    new AbortController().signal,
  );
  expect(outcome).toMatchObject({
    kind: 'budget_exhausted',
    summary: expect.stringContaining('input_context_exceeded'),
  });
  expect(launched).toBe(false);
});
