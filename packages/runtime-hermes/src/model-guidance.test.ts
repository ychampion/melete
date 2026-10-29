import { describe, expect, test } from 'bun:test';
import {
  type AttemptBundle,
  EMPTY_SINCE_LAST,
  MODEL_GUIDANCE_TOKEN_LIMIT,
  modelGuidance,
} from '@melete/contracts';
import { estimateTokens } from '@melete/skills';
import { HermesClient } from './client.ts';
import { MODEL_GUIDANCE_HEADING, renderModelGuidance } from './instructions.ts';

const SUFFIX = '01J8ZP3QWABCDEFGHJKMNPQRST';
const NEMOTRON = 'nvidia/nemotron-3-super-120b-a12b';

const turn = (model: string): AttemptBundle => ({
  attempt: { id: `att_${SUFFIX}`, job_id: `job_${SUFFIX}`, epoch: 1, revision: 1, token: 't' },
  job: {
    title: 'Plan the weekend',
    objective: 'Help the person plan Saturday.',
    progress_summary: '',
    constraints: {},
    unresolved_questions: [],
    deliverable: { kind: 'answer' },
  },
  inputs: {
    new_user_messages: [
      { role: 'user', content: 'what is on Saturday?', at: '2026-10-01T00:00:00Z' },
    ],
    approval_results: [],
    trigger_events: [],
    repair_briefs: [],
  },
  since_last: EMPTY_SINCE_LAST,
  transcript: [],
  tools: [],
  skills: [],
  knowledge: [],
  workspace: { mount: '/work', files: [] },
  budget: { max_turns: 8, max_output_tokens: 4000, max_wall_ms: 120000, max_actions: 3 },
  model: { provider: 'nebius', model, fallback: null },
});

/** A request in a room: each message names who wrote it. */
const roomRequest = (model: string): AttemptBundle => {
  const bundle = turn(model);
  bundle.inputs.new_user_messages = [
    { role: 'user', content: 'Can everyone do Friday?', name: 'Alice', at: '2026-10-01T00:00:00Z' },
  ];
  return bundle;
};

const client = new HermesClient({ baseUrl: 'http://runtime:8790/', token: 'surrogate' });
const sent = (bundle: AttemptBundle) =>
  JSON.parse(client.startRun(bundle).body ?? '{}') as { instructions: string; input: string };

describe('per-model guidance in the prompt', () => {
  for (const [kind, make] of [
    ['a turn', turn],
    ['a room request', roomRequest],
  ] as const) {
    test(`${kind} on Nemotron carries the notes last in the instructions, never in the input`, () => {
      const body = sent(make(NEMOTRON));
      const notes = renderModelGuidance(NEMOTRON);
      expect(notes).toStartWith(MODEL_GUIDANCE_HEADING);
      expect(body.instructions.endsWith(`\n\n${notes}`)).toBe(true);
      // Behind everything already there: the task notes still come first.
      expect(body.instructions.indexOf('# This task')).toBeLessThan(
        body.instructions.indexOf(MODEL_GUIDANCE_HEADING),
      );
      expect(body.input).not.toContain(MODEL_GUIDANCE_HEADING);
    });

    test(`${kind} on another model has no notes`, () => {
      const body = sent(make('deepseek-v4p1-flash'));
      expect(body.instructions).not.toContain(MODEL_GUIDANCE_HEADING);
      expect(renderModelGuidance('deepseek-v4p1-flash')).toBe('');
    });
  }

  test('the notes are all that changes in the instructions, and they stay small', () => {
    const plain = sent(turn('deepseek-v4p1-flash')).instructions;
    const guided = sent(turn(NEMOTRON)).instructions;
    expect(guided).toBe(`${plain}\n\n${renderModelGuidance(NEMOTRON)}`);
    expect(estimateTokens(modelGuidance(NEMOTRON)?.text ?? '')).toBeLessThanOrEqual(
      MODEL_GUIDANCE_TOKEN_LIMIT,
    );
    // The heading and lead line add only a little on top of the family's text.
    expect(estimateTokens(renderModelGuidance(NEMOTRON))).toBeLessThanOrEqual(
      MODEL_GUIDANCE_TOKEN_LIMIT + 40,
    );
  });
});

describe('the operator switch', () => {
  test('off means no block', () => {
    expect(renderModelGuidance(NEMOTRON, false)).toBe('');
    expect(renderModelGuidance(NEMOTRON, true)).toStartWith(MODEL_GUIDANCE_HEADING);
  });

  test('MELETE_MODEL_GUIDANCE=off at start leaves the block out of a run', () => {
    const script = [
      `import { HermesClient } from ${JSON.stringify(new URL('./client.ts', import.meta.url).pathname)};`,
      `const bundle = ${JSON.stringify(turn(NEMOTRON))};`,
      "const client = new HermesClient({ baseUrl: 'http://runtime:8790/' });",
      'console.log(JSON.parse(client.startRun(bundle).body).instructions);',
    ].join('\n');
    const run = (value: string) => {
      const child = Bun.spawnSync([process.execPath, '-e', script], {
        env: { ...process.env, MELETE_MODEL_GUIDANCE: value },
      });
      expect(child.exitCode).toBe(0);
      return child.stdout.toString();
    };
    expect(run('off')).not.toContain(MODEL_GUIDANCE_HEADING);
    expect(run('')).toContain(MODEL_GUIDANCE_HEADING);
  });
});
