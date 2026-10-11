/** A reply that only says what the agent is about to do is not the reply. */
import { expect, test } from 'bun:test';
import { type AttemptBundle, EMPTY_SINCE_LAST } from '@melete/contracts';
import { HermesRuntimeAdapter } from './adapter.ts';

const SUFFIX = '01J8ZP3QWABCDEFGHJKMNPQRST';
const bundle: AttemptBundle = {
  attempt: { id: `att_${SUFFIX}`, job_id: `job_${SUFFIX}`, epoch: 1, revision: 0, token: 'jwt' },
  job: {
    title: 'Weather',
    objective: 'Will it rain this afternoon?',
    constraints: {},
    progress_summary: '',
    unresolved_questions: [],
    deliverable: {},
  },
  inputs: { new_user_messages: [], approval_results: [], trigger_events: [], repair_briefs: [] },
  since_last: EMPTY_SINCE_LAST,
  transcript: [],
  tools: [],
  skills: [],
  knowledge: [],
  workspace: { mount: '/work', files: [] },
  budget: { max_turns: 8, max_output_tokens: 4000, max_wall_ms: 120_000, max_actions: 3 },
  model: { provider: 'custom', model: 'fake-scripted-v1', fallback: null },
};

function engine(outputs: string[]) {
  const inputs: string[] = [];
  let started = 0;
  const adapter = new HermesRuntimeAdapter({
    baseUrl: 'http://runtime:8790',
    parkedActions: async () => [],
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      if (path === '/v1/runs' && init?.method === 'POST') {
        inputs.push((JSON.parse(String(init.body)) as { input: string }).input);
        started++;
        return Response.json({ run_id: `run_${started}`, status: 'started' }, { status: 202 });
      }
      if (path.endsWith('/events')) {
        const output = outputs[Number(path.split('/')[3]?.replace('run_', '')) - 1] ?? '';
        return new Response(`data: ${JSON.stringify({ event: 'run.completed', output })}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return Response.json({ ok: true });
    },
    streamIdleMs: 2_000,
  });
  return { adapter, inputs };
}

test('is asked once for the reply itself', async () => {
  const { adapter, inputs } = engine(['Let me check the forecast…', 'It will rain after 4 PM.']);
  const outcome = await adapter.start(
    bundle,
    { emit: async () => {} },
    new AbortController().signal,
  );
  expect(inputs).toHaveLength(2);
  expect(outcome).toMatchObject({ kind: 'completed', summary: 'It will rain after 4 PM.' });
});

test('a reply with its answer is not asked again', async () => {
  const { adapter, inputs } = engine(['Let me check… It will rain after 4 PM.']);
  await adapter.start(bundle, { emit: async () => {} }, new AbortController().signal);
  expect(inputs).toHaveLength(1);
});
