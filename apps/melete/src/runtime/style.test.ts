import { describe, expect, test } from 'bun:test';
import type {
  AttemptBundle,
  AttemptOutcome,
  EventSink,
  RuntimeAdapter,
  StyleViolation,
} from '@melete/contracts';
import { outcomeText, replyClassOf, styleViolationsOf, withStyleCheck } from './style.ts';

const bundle = { attempt: { id: 'att_style' } } as unknown as AttemptBundle;
const sink: EventSink = { emit: async () => {} };

const runtimeReturning = (outcome: AttemptOutcome): RuntimeAdapter => ({
  capabilities: async () => ({ streaming: false, tools: false, interrupt: false, version: 't/1' }),
  start: async () => outcome,
});

describe('the style measurement on an attempt outcome', () => {
  test('reads the text each outcome kind actually shows a person', () => {
    expect(outcomeText({ kind: 'completed', summary: 'Sent it.', evidence: [] })).toBe('Sent it.');
    expect(outcomeText({ kind: 'waiting_for_input', question: 'Which address?' })).toBe(
      'Which address?',
    );
    expect(
      outcomeText({ kind: 'waiting_for_input', question: 'Which one?', draft: 'Here it is.' }),
    ).toBe('Here it is.\n\nWhich one?');
    expect(
      outcomeText({ kind: 'failed', reason: 'The mailbox refused it.', retryable: false }),
    ).toBe('The mailbox refused it.');
    expect(outcomeText({ kind: 'waiting_for_approval', action_ids: ['act_1'] })).toBe('');
    expect(outcomeText({ kind: 'waiting_for_event_or_time', wait: { kind: 'none' } })).toBe('');
  });

  test('an outcome citing an artifact is measured as a deliverable', () => {
    expect(
      replyClassOf({
        kind: 'completed',
        summary: 'Done.',
        evidence: [{ kind: 'artifact', artifact_id: 'art_1' }],
      }),
    ).toBe('deliverable');
    expect(replyClassOf({ kind: 'completed', summary: 'Done.', evidence: [] })).toBe('casual');
    expect(replyClassOf({ kind: 'waiting_for_input', question: 'Which?' })).toBe('casual');
  });

  test('a clean summary produces no violations', () => {
    expect(
      styleViolationsOf({ kind: 'completed', summary: 'It is booked for Thursday.', evidence: [] }),
    ).toEqual([]);
  });

  test('a preamble and a self-reference are both recorded', () => {
    const violations = styleViolationsOf({
      kind: 'completed',
      summary: 'Certainly! As an AI I have booked Thursday.',
      evidence: [],
    });
    expect(violations.map((v) => v.code)).toEqual(['banned_opener', 'ai_self_reference']);
  });

  test('a long note attached to an artifact is inside budget', () => {
    const summary = Array.from({ length: 20 }, (_, i) => `Section ${i} is written.`).join(' ');
    expect(
      styleViolationsOf({
        kind: 'completed',
        summary,
        evidence: [{ kind: 'artifact', artifact_id: 'art_1' }],
      }),
    ).toEqual([]);
  });
});

describe('the style-check decorator', () => {
  test('records what it saw and returns the outcome unchanged', async () => {
    const outcome: AttemptOutcome = {
      kind: 'completed',
      summary: 'Of course! Here it is. And here. And here.',
      evidence: [],
    };
    const seen: Array<{ id: string; violations: readonly StyleViolation[] }> = [];
    const wrapped = withStyleCheck(runtimeReturning(outcome), (id, violations) => {
      seen.push({ id, violations });
    });
    const returned = await wrapped.start(bundle, sink, new AbortController().signal);
    expect(returned).toBe(outcome);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe('att_style');
    expect(seen[0]?.violations.map((v) => v.code)).toEqual(['banned_opener', 'sentence_budget']);
  });

  test('records an empty list for a clean attempt rather than recording nothing', async () => {
    const seen: StyleViolation[][] = [];
    const wrapped = withStyleCheck(
      runtimeReturning({ kind: 'completed', summary: 'Booked for Thursday.', evidence: [] }),
      (_id, violations) => {
        seen.push([...violations]);
      },
    );
    await wrapped.start(bundle, sink, new AbortController().signal);
    expect(seen).toEqual([[]]);
  });

  test('never blocks: a recorder that throws does not fail the attempt', async () => {
    const outcome: AttemptOutcome = {
      kind: 'completed',
      summary: 'Certainly! Done.',
      evidence: [],
    };
    const wrapped = withStyleCheck(runtimeReturning(outcome), () => {
      throw new Error('the measurement store is down');
    });
    expect(await wrapped.start(bundle, sink, new AbortController().signal)).toBe(outcome);
  });

  test('passes the wrapped runtime capabilities through', async () => {
    const wrapped = withStyleCheck(
      runtimeReturning({ kind: 'completed', summary: 'Done.', evidence: [] }),
      () => {},
    );
    expect((await wrapped.capabilities()).version).toBe('t/1');
  });
});
