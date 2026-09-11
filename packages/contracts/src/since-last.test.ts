import { describe, expect, test } from 'bun:test';
import { EMPTY_SINCE_LAST, renderSinceLast, sinceLast } from './runtime.ts';

const at = '2026-09-11T10:00:00.000Z';
/** A valid ULID body: 26 Crockford base32 characters starting below 8. */
const ulid = (tail = '') => `01J${tail.padEnd(23, '0')}`;
const ATTEMPT = `att_${ulid()}`;
const ACTION = `act_${ulid()}`;
const APPROVAL = `apr_${ulid()}`;
const CLAIM = `k_${ulid()}`;
const JOB = `job_${ulid()}`;

describe('the delta brief', () => {
  test('an empty brief with no prior attempt says so instead of inventing work', () => {
    expect(renderSinceLast(EMPTY_SINCE_LAST)).toBe('This is the first attempt on this job.');
    expect(sinceLast.parse({})).toEqual(EMPTY_SINCE_LAST);
  });

  test('a prior attempt that produced nothing says that too', () => {
    const delta = sinceLast.parse({ attempt_id: ATTEMPT, ended_at: at });
    expect(renderSinceLast(delta)).toContain('nothing was produced and nothing is waiting');
  });

  test('a completed send is named with its receipt, which is what makes it a fact', () => {
    const delta = sinceLast.parse({
      attempt_id: ATTEMPT,
      ended_at: at,
      actions: [
        {
          action_id: ACTION,
          kind: 'email.send',
          status: 'succeeded',
          receipt_ref: 'message-id-7731@example.test',
          at,
        },
      ],
    });
    const text = renderSinceLast(delta);
    expect(text).toContain(ACTION);
    expect(text).toContain('email.send');
    expect(text).toContain('succeeded');
    expect(text).toContain('receipt message-id-7731@example.test');
  });

  test('an action with no receipt is not described as though it had one', () => {
    const delta = sinceLast.parse({
      attempt_id: ATTEMPT,
      ended_at: at,
      actions: [
        {
          action_id: ACTION,
          kind: 'email.send',
          status: 'unknown',
          receipt_ref: null,
          at,
        },
      ],
    });
    expect(renderSinceLast(delta)).not.toContain('receipt');
    expect(renderSinceLast(delta)).toContain('is unknown');
  });

  test('evidence, questions and approvals each get one line', () => {
    const delta = sinceLast.parse({
      attempt_id: ATTEMPT,
      ended_at: at,
      evidence: [
        { kind: 'artifact', handle: 'artifact:art_1', label: 'artifacts/brief.md', at },
        { kind: 'knowledge', handle: 'knowledge:k_1', label: 'knowledge/heating.md', at },
      ],
      pending_questions: [{ id: 'qst_1', text: 'Which address?', state: 'asked' }],
      pending_approvals: [
        {
          approval_id: APPROVAL,
          action_id: ACTION,
          kind: 'email.send',
          requested_at: at,
        },
      ],
    });
    const lines = renderSinceLast(delta).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain('artifacts/brief.md');
    expect(lines[2]).toContain('knowledge/heating.md');
    expect(lines[3]).toContain('Which address?');
    expect(lines[4]).toContain(APPROVAL);
  });

  test('a repair brief says what moved and how many outputs said the old thing', () => {
    const delta = sinceLast.parse({
      attempt_id: ATTEMPT,
      ended_at: at,
      repair_briefs: [
        {
          id: 'rb_1',
          job_id: JOB,
          key: 'event.trip.date',
          changed_handle: `${CLAIM}@1`,
          replacement_handle: `${CLAIM}@2`,
          old_value: 'July',
          new_value: 'August',
          affected: [
            { kind: 'artifact', output_id: 'art_0', output_version: '1', location: 'paragraph 2' },
          ],
          created_at: at,
        },
      ],
    });
    const text = renderSinceLast(delta);
    expect(text).toContain('event.trip.date');
    expect(text).toContain('"July"');
    expect(text).toContain('"August"');
    expect(text).toContain('1 output(s) cited the old value');
  });

  test('the brief is bounded, so one busy job cannot crowd out the rest of the prompt', () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      action_id: `act_${ulid(String(index).padStart(4, '0'))}`,
      kind: 'test.send',
      status: 'succeeded',
      receipt_ref: null,
      at,
    }));
    expect(() => sinceLast.parse({ actions: many })).toThrow();
  });
});
