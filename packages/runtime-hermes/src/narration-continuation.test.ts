/** A reply that only says what the agent is about to do is not the reply. */
import { expect, test } from 'bun:test';
import { type AttemptBundle, EMPTY_SINCE_LAST } from '@melete/contracts';
import { HermesRuntimeAdapter } from './adapter.ts';
import { SAID_THEN_WROTE } from './instructions.ts';
import { DELIVER_CONTINUATION, SAID_DELIVER_CONTINUATION } from './liveness.ts';
import { answersAlready } from './narration.ts';

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

const ANSWER = 'It will rain after 4 PM. Take an umbrella if you head out.';
const at = '2026-10-18T12:00:00.000Z';
const run = (given: AttemptBundle, outputs: string[]) => {
  const { adapter, inputs } = engine(outputs);
  return adapter
    .start(given, { emit: async () => {} }, new AbortController().signal)
    .then((outcome) => ({ outcome, inputs }));
};
const withSaid = (said: string, inputs: Partial<AttemptBundle['inputs']> = {}): AttemptBundle => ({
  ...bundle,
  inputs: { ...bundle.inputs, ...inputs, said_this_turn: said },
});

test('a turn whose answer the person already has is not asked to say it again', async () => {
  const { inputs } = await run(withSaid(ANSWER), ['Let me check the forecast…', ANSWER]);
  expect(inputs).toHaveLength(1);
  // It is shown the words it already sent, once, after its instructions.
  expect(inputs[0]).toContain('## Already said in this turn');
  expect(inputs[0]).toContain(`<already_said>\n${ANSWER}\n</already_said>`);
  expect(inputs[0]).not.toContain(SAID_THEN_WROTE);
});

test('a turn that only said what it was about to do is still asked for the answer', async () => {
  const { outcome, inputs } = await run(withSaid('Let me look that up.'), [
    'Let me check the forecast…',
    'It will rain after 4 PM.',
  ]);
  expect(inputs).toHaveLength(2);
  expect(outcome).toMatchObject({ kind: 'completed', summary: 'It will rain after 4 PM.' });
});

test('a plan line the narration filter does not know is not taken for the answer', async () => {
  // Said by a real model before a step; the filter keeps it, since it names no "let me".
  const { inputs } = await run(withSaid('Checking what I know about your book club.'), [
    'Let me check your notes…',
    'Your book club meets on Thursdays.',
  ]);
  expect(inputs).toHaveLength(2);
  // The one ask knows what the person already has.
  expect(inputs[1]).toBe(SAID_DELIVER_CONTINUATION);
});

test('a short answer already sent leaves one ask, for only what is new', async () => {
  const { inputs } = await run(withSaid('It will rain after 4 PM.'), [
    'Let me check the radar…',
    'The radar shows it starting closer to 5.',
  ]);
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toBe(SAID_DELIVER_CONTINUATION);
  expect(inputs[1]).not.toBe(DELIVER_CONTINUATION);
});

test('a message the person sent after the answer still gets its reply', async () => {
  const message = { role: 'user' as const, content: 'And tomorrow?', at };
  const { outcome, inputs } = await run(withSaid(ANSWER, { new_user_messages: [message] }), [
    'Let me look that up…',
    'Tomorrow stays dry.',
  ]);
  // Told the earlier words do not answer it, and asked once if it goes quiet.
  expect(inputs[0]).toContain(SAID_THEN_WROTE);
  expect(inputs).toHaveLength(2);
  expect(outcome).toMatchObject({ kind: 'completed', summary: 'Tomorrow stays dry.' });
});

test('an event in the wake leaves the ask in place', async () => {
  const { inputs } = await run(
    withSaid(ANSWER, { trigger_events: [{ kind: 'timer_fired', wake_at: at }] }),
    ['Let me look at the radar…', 'Still rain after 4 PM.'],
  );
  expect(inputs).toHaveLength(2);
});

test('words that answer are told from words that announce', () => {
  for (const said of [
    ANSWER,
    'Dear Hiring Manager,\n\nHere is the letter.\n\nSincerely,\nRiya Sharma',
    `Here is the plan. ${'Day one is the old town and the castle. '.repeat(4)}`,
  ])
    expect(answersAlready(said)).toBe(true);
  for (const said of [
    'Pulling up your calendar now.',
    'Looking into it.',
    "I'll check the weather. One moment.",
    "I'm going to draft the letter and then count the words.",
    // Short answers count as a line: the cost is one ask for what is new, never an early end.
    'Yes.',
    'It will rain after 4 PM.',
  ])
    expect(answersAlready(said)).toBe(false);
});
