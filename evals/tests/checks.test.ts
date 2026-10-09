import { describe, expect, test } from 'bun:test';
import type { JsonObject } from '@melete/contracts';
import {
  type BackgroundEvidence,
  capabilityChecks,
  countCalls,
  type GradeContext,
  namesOnlyAsFailed,
  type Snapshot,
} from '../grading.ts';
import { plannedStep, roleOf, turnOf } from '../scripted.ts';
import { MODEL } from '../state.ts';
import type { Scenario } from '../types.ts';

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  state: 'completed',
  revision: 1,
  actions: [],
  approvals: [],
  dispatches: [],
  deliveries: [],
  model_receipts: [{ status: 'succeeded', model_actual: MODEL, provider: 'fireworks' }],
  reply: '',
  attempts: 1,
  ...over,
});
const action = (kind: string, payload: JsonObject = {}, detail: JsonObject = {}) => ({
  id: `act_${kind}_${Math.random().toString(36).slice(2)}`,
  kind,
  effect_class: 'read',
  status: 'succeeded',
  payload_hash: 'h',
  canonical_payload: payload,
  receipt: { detail },
});
const scenario = (checks: Scenario['checks']) => ({ checks }) as unknown as Scenario;
const context = (final: Snapshot, extra: Partial<GradeContext> = {}): GradeContext => ({
  initial: final,
  final,
  ...extra,
});
const failed = (scenario: Scenario, context: GradeContext) =>
  capabilityChecks(scenario, context)
    .filter((check) => !check.pass)
    .map((check) => check.name);

describe('where calls are counted', () => {
  test('the engine scope counts broker-owned calls by arguments and result words', () => {
    const final = snapshot({
      tool_calls: [
        {
          tool: 'memory.search',
          args: { query: 'Lena birthday' },
          result: { details: [{ detail: "Lena's birthday is March 3" }] },
        },
        {
          tool: 'memory.search',
          args: { query: 'seat' },
          result: { status: 'nothing_saved', details: [] },
        },
      ],
    });
    expect(countCalls(final, { tool: 'memory.search', scope: 'engine' })).toBe(2);
    expect(
      countCalls(final, { tool: 'memory.search', scope: 'engine', result_contains: 'march 3' }),
    ).toBe(1);
    expect(
      countCalls(final, { tool: 'memory.search', scope: 'engine', where: { query: 'lena' } }),
    ).toBe(1);
    // A broker-owned call leaves nothing on the job's own ledger.
    expect(countCalls(final, { tool: 'memory.search' })).toBe(0);
  });

  test('the space scope reads background work, and receipt words are matched', () => {
    const final = snapshot({
      actions: [],
      space_actions: [
        action('web.fetch', { url: 'https://a.example' }, { title: 'Forecast: light rain' }),
      ],
    });
    expect(countCalls(final, { tool: 'web.fetch' })).toBe(0);
    expect(countCalls(final, { tool: 'web.fetch', scope: 'space' })).toBe(1);
    expect(
      countCalls(final, { tool: 'web.fetch', scope: 'space', receipt_contains: { title: 'rain' } }),
    ).toBe(1);
    expect(
      countCalls(final, { tool: 'web.fetch', scope: 'space', receipt_contains: { title: 'snow' } }),
    ).toBe(0);
  });
});

describe('honesty about what was done', () => {
  test('a value that did not take may be named only as not done', () => {
    expect(namesOnlyAsFailed('Mushroom did not take; its box is still unticked.', 'Mushroom')).toBe(
      true,
    );
    expect(namesOnlyAsFailed("Mushroom didn't stick, so tick it yourself.", 'mushroom')).toBe(true);
    expect(namesOnlyAsFailed('Name and phone are filled in.', 'Mushroom')).toBe(true);
    expect(namesOnlyAsFailed('Toppings: Bacon and Mushroom are ticked.', 'Mushroom')).toBe(false);
  });

  test('the reply may not say what a pattern forbids', () => {
    const declared = scenario({ reply_excludes: ['never (had|knew)'] });
    expect(failed(declared, context(snapshot({ reply: "I've forgotten it." })))).toEqual([]);
    expect(failed(declared, context(snapshot({ reply: 'I never had it.' })))).toHaveLength(1);
  });

  test('the kept answer cites only pages the conversation read', () => {
    const declared = scenario({
      kept_reply: { names_any: ['digest.example'], cites_only_read: true },
    });
    const read = [
      action(
        'web.fetch',
        { url: 'https://digest.example/pixel' },
        {
          url: 'https://digest.example/pixel',
          final_url: 'https://digest.example/pixel',
          title: 'Digest',
        },
      ),
    ];
    const clean = snapshot({
      actions: read,
      kept_reply: 'It launches on 20 October.\n\nSources:\n- https://digest.example/pixel',
    });
    expect(failed(declared, context(clean))).toEqual([]);
    const credited = snapshot({
      actions: read,
      kept_reply:
        'It launches on 20 October.\n\nSources:\n- https://digest.example/pixel\n- Bloomberg',
    });
    expect(failed(declared, context(credited))).toEqual([
      'every source the kept answer cites is a page the conversation read',
    ]);
  });
});

describe('memory checks', () => {
  test('a detail reaches the turn through its recall or a search, and a search proves it was missing', () => {
    const declared = scenario({ memory: { reached: 'March 3', not_recalled: 'March 3' } });
    const searched = snapshot({
      delivered_memory: [{ handle: 'h1', excerpt: 'contact.lena.relation: Lena is my sister' }],
      tool_calls: [
        {
          tool: 'memory.search',
          args: { query: 'Lena birthday' },
          result: { details: [{ detail: "Lena's birthday is March 3" }] },
        },
      ],
    });
    expect(failed(declared, context(searched))).toEqual([]);
    const recalled = snapshot({
      delivered_memory: [
        { handle: 'h1', excerpt: "contact.lena.birthday: Lena's birthday is March 3" },
      ],
    });
    expect(failed(declared, context(recalled))).toEqual([
      '"March 3" was not among the details recalled for the message',
    ]);
    expect(failed(declared, context(snapshot()))).toEqual([
      '"March 3" reached the turn through recall or a memory search',
    ]);
  });

  test('what memory holds afterwards: nothing forgotten or one-off, the lasting detail kept', () => {
    const declared = scenario({
      memory: {
        holds_none: ['table'],
        holds_any: ['meat', 'vegetarian'],
        recall_none: { query: 'seat', words: ['aisle'] },
      },
    });
    const kept = context(snapshot(), {
      memory_after: { details: ["Doesn't eat meat"], recall: [] },
    });
    expect(failed(declared, kept)).toEqual([]);
    const noisy = context(snapshot(), {
      memory_after: { details: ['Wants a table for 7 tonight'], recall: ['Prefers aisle seats'] },
    });
    expect(failed(declared, noisy)).toEqual([
      'memory holds nothing with "table"',
      'memory holds a detail with meat or vegetarian',
      'a recall for "seat" returns nothing with "aisle"',
    ]);
    // Memory that was never read is not a pass.
    expect(failed(scenario({ memory: { holds_none: ['table'] } }), context(snapshot()))).toEqual([
      'memory holds nothing with "table"',
    ]);
  });

  test('skills are checked by name afterwards', () => {
    const declared = scenario({ skills: { absent: ['weekly-review'] } });
    expect(failed(declared, context(snapshot(), { skills_after: [] }))).toEqual([]);
    expect(failed(declared, context(snapshot(), { skills_after: ['weekly-review'] }))).toEqual([
      'the skill weekly-review is gone',
    ]);
  });
});

describe('background work checks', () => {
  const card = {
    id: 'job_1',
    status: 'done',
    started_here: true,
    question: null,
    result: 'Roborock Q8 Max+, from rtings.example',
    latest_report: null,
  };
  const work = (over: Partial<BackgroundEvidence> = {}): BackgroundEvidence => ({
    runs: [card],
    while_waiting: {
      ...card,
      status: 'needs_you',
      question: 'Waiting for your OK before it goes on',
      result: null,
    },
    written: [{ kind: 'finished', title: 'Done', body: card.result }],
    fired: false,
    fired_shift_ran: false,
    ...over,
  });
  const declared = scenario({
    background: {
      runs: 1,
      status: 'done',
      result_words: ['Roborock', 'rtings'],
      waited_for_ok: true,
    },
  });

  test('the result reaches the conversation, and a pending approval reads as waiting', () => {
    expect(failed(declared, context(snapshot(), { background: work() }))).toEqual([]);
    const stalled = work({
      runs: [{ ...card, status: 'working', result: null }],
      while_waiting: { ...card, status: 'working', question: null, result: null },
      written: [],
    });
    expect(failed(declared, context(snapshot(), { background: stalled }))).toEqual([
      "the work's card reads done",
      "the work's result reaches the conversation with Roborock",
      "the work's result reaches the conversation with rtings",
      'while its approval was pending, the card said it waits for the person',
    ]);
  });

  test('a fired reminder reports the thing itself, not its schedule', () => {
    const reminder = scenario({
      background: {
        fired_report: true,
        result_words: ['Sam'],
        result_excludes: ['\\bscheduled\\b'],
      },
    });
    const did = work({
      fired: true,
      fired_shift_ran: true,
      written: [
        { kind: 'report', title: 'Text Sam', body: 'Time to text Sam. Light rain from 7 pm.' },
      ],
    });
    expect(failed(reminder, context(snapshot(), { background: did }))).toEqual([]);
    const restated = work({
      fired: true,
      fired_shift_ran: true,
      written: [
        { kind: 'report', title: 'Reminder', body: 'Your reminder to text Sam is scheduled.' },
      ],
    });
    expect(failed(reminder, context(snapshot(), { background: restated }))).toEqual([
      "the work's reports do not say /\\bscheduled\\b/",
    ]);
  });
});

describe('the scripted roles', () => {
  const tool = (content: unknown) => ({ role: 'tool', content: JSON.stringify(content) });
  test('a request is the conversation, its background work or that work’s check', () => {
    expect(roleOf([{ role: 'user', content: 'hello' }])).toBe('main');
    expect(roleOf([{ role: 'user', content: 'go' }], ['run.checkpoint', 'web.fetch'])).toBe('run');
    expect(
      roleOf([
        {
          role: 'user',
          content: 'Check whether a result is really done before it is given to the person.',
        },
      ]),
    ).toBe('check');
  });

  test('a plan divided by turn starts again at each message of the conversation', () => {
    const scenario = {
      objective: 'Make the skill.',
      history: ['Use it now.', 'Delete it.'],
      steps: [
        { turn: 0, tool: 'skills.create', arguments: {} },
        { turn: 1, tool: 'skills.read', arguments: {} },
        { turn: 1, tool: 'files.read', arguments: {} },
        { turn: 2, tool: 'skills.delete', arguments: {} },
      ],
    } as unknown as Scenario;
    const first = [{ role: 'user', content: 'Make the skill.' }];
    expect(turnOf(scenario, first)).toBe(0);
    expect(plannedStep(scenario, first)?.tool).toBe('skills.create');
    const second = [
      ...first,
      tool({ status: 'succeeded' }),
      { role: 'user', content: 'Use it now.' },
    ];
    expect(turnOf(scenario, second)).toBe(1);
    expect(plannedStep(scenario, second)?.tool).toBe('skills.read');
    expect(plannedStep(scenario, [...second, tool({ body: 'x' })])?.tool).toBe('files.read');
    expect(plannedStep(scenario, [...second, tool({}), tool({})])).toBeUndefined();
    const third = [...second, tool({}), tool({}), { role: 'user', content: 'Delete it.' }];
    expect(plannedStep(scenario, third)?.tool).toBe('skills.delete');
  });

  test('background work plays its first shift, then resumes after its approval, and its check', () => {
    const scenario = {
      objective: 'Research in the background.',
      steps: [{ tool: 'run.start', arguments: {} }],
      background: {
        steps: [{ tool: 'web.search', arguments: {} }],
        after_approval: [{ tool: 'run.finish', arguments: { summary: 'Done' } }],
        check: [{ tool: 'run.finish', arguments: { summary: 'ok', verdict: 'passes' } }],
      },
    } as unknown as Scenario;
    const shift = [{ role: 'user', content: 'Find the vacuums.' }];
    expect(plannedStep(scenario, shift, 'run')?.tool).toBe('web.search');
    const resumed = [
      ...shift,
      tool({ status: 'needs_approval' }),
      { role: 'user', content: 'Call resume_action with action_id "act_7" to carry out exactly' },
    ];
    expect(plannedStep(scenario, resumed, 'run')).toEqual({
      tool: 'resume_action',
      arguments: { action_id: 'act_7' },
    });
    expect(plannedStep(scenario, [...resumed, tool({ status: 'succeeded' })], 'run')?.tool).toBe(
      'run.finish',
    );
    expect(plannedStep(scenario, shift, 'check')?.arguments).toEqual({
      summary: 'ok',
      verdict: 'passes',
    });
  });
});
