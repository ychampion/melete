import { describe, expect, test } from 'bun:test';
import { isErr, isOk, unwrap } from './common.ts';
import {
  isTerminal,
  isWaiting,
  JOB_STATES,
  type JobState,
  LEGAL_EDGES,
  type TransitionInput,
  transition,
} from './job-state.ts';

/** A representative input for each kind, used to drive the exhaustive sweep. */
const INPUTS: Record<TransitionInput['kind'], TransitionInput> = {
  attempt_started: { kind: 'attempt_started' },
  attempt_completed: {
    kind: 'attempt_completed',
    all_actions_terminal: true,
    has_unknown_action: false,
    deliverable_declared: false,
    deliverable_satisfied: false,
  },
  attempt_waiting_for_input: { kind: 'attempt_waiting_for_input' },
  attempt_waiting_for_approval: { kind: 'attempt_waiting_for_approval' },
  attempt_waiting_for_event_or_time: { kind: 'attempt_waiting_for_event_or_time' },
  attempt_failed: { kind: 'attempt_failed', retryable: false, attempts_remaining: 0 },
  attempt_budget_exhausted: { kind: 'attempt_budget_exhausted' },
  action_unknown: { kind: 'action_unknown' },
  user_input_received: { kind: 'user_input_received' },
  approval_decided: { kind: 'approval_decided', decision: 'approved' },
  event_fired: { kind: 'event_fired' },
  timer_fired: { kind: 'timer_fired' },
  reconciled: { kind: 'reconciled' },
  cancelled: { kind: 'cancelled' },
};

describe('every legal edge in the specification', () => {
  for (const edge of LEGAL_EDGES) {
    test(`${edge.from} --${edge.input}--> ${edge.to}`, () => {
      const result = transition(edge.from, INPUTS[edge.input]);
      expect(isOk(result)).toBe(true);
      expect(unwrap(result)).toBe(edge.to);
    });
  }
});

describe('the outcome of an attempt is not the runtime word alone', () => {
  test('an unknown action sends the job to reconciliation, not to completed', () => {
    const result = transition('running', {
      kind: 'attempt_completed',
      all_actions_terminal: false,
      has_unknown_action: true,
      deliverable_declared: true,
      deliverable_satisfied: true,
    });
    expect(unwrap(result)).toBe('needs_reconciliation');
  });

  test('an action still in flight blocks completion', () => {
    const result = transition('running', {
      kind: 'attempt_completed',
      all_actions_terminal: false,
      has_unknown_action: false,
      deliverable_declared: false,
      deliverable_satisfied: false,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('actions_not_terminal');
  });

  test('a final answer with no evidence becomes a question', () => {
    const result = transition('running', {
      kind: 'attempt_completed',
      all_actions_terminal: true,
      has_unknown_action: false,
      deliverable_declared: true,
      deliverable_satisfied: false,
    });
    expect(unwrap(result)).toBe('waiting_for_input');
  });

  test('a satisfied deliverable completes', () => {
    const result = transition('running', {
      kind: 'attempt_completed',
      all_actions_terminal: true,
      has_unknown_action: false,
      deliverable_declared: true,
      deliverable_satisfied: true,
    });
    expect(unwrap(result)).toBe('completed');
  });
});

describe('retry', () => {
  test('a retryable failure with budget left goes back to the queue', () => {
    const result = transition('running', {
      kind: 'attempt_failed',
      retryable: true,
      attempts_remaining: 2,
    });
    expect(unwrap(result)).toBe('queued');
  });

  test('a retryable failure with no attempts left fails', () => {
    const result = transition('running', {
      kind: 'attempt_failed',
      retryable: true,
      attempts_remaining: 0,
    });
    expect(unwrap(result)).toBe('failed');
  });

  test('an exhausted budget fails rather than looping', () => {
    expect(unwrap(transition('running', { kind: 'attempt_budget_exhausted' }))).toBe('failed');
  });
});

describe('illegal transitions are refused, not tolerated', () => {
  const cases: Array<[JobState, TransitionInput['kind']]> = [
    ['queued', 'attempt_completed'],
    ['queued', 'user_input_received'],
    ['running', 'reconciled'],
    ['running', 'attempt_started'],
    ['waiting_for_approval', 'user_input_received'],
    ['waiting_for_input', 'approval_decided'],
    ['waiting_for_event_or_time', 'reconciled'],
    ['needs_reconciliation', 'timer_fired'],
  ];

  for (const [from, input] of cases) {
    test(`${from} refuses ${input}`, () => {
      const result = transition(from, INPUTS[input]);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.code).toBe('illegal_transition');
        expect(result.error.from).toBe(from);
        expect(result.error.input).toBe(input);
      }
    });
  }

  test('nothing moves a finished job, including another cancellation', () => {
    for (const state of ['completed', 'failed', 'cancelled'] as const) {
      for (const input of Object.values(INPUTS)) {
        const result = transition(state, input);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) expect(result.error.code).toBe('already_terminal');
      }
    }
  });
});

describe('cancellation', () => {
  test('is legal from every non-terminal state', () => {
    for (const state of JOB_STATES) {
      const result = transition(state, { kind: 'cancelled' });
      if (isTerminal(state)) {
        expect(isErr(result)).toBe(true);
      } else {
        expect(unwrap(result)).toBe('cancelled');
      }
    }
  });
});

describe('state predicates', () => {
  test('terminal and waiting sets do not overlap and cover the enum', () => {
    for (const state of JOB_STATES) {
      expect(isTerminal(state) && isWaiting(state)).toBe(false);
    }
    const classified = JOB_STATES.filter(
      (s) => isTerminal(s) || isWaiting(s) || s === 'queued' || s === 'running',
    );
    expect(classified.length).toBe(JOB_STATES.length);
  });
});

describe('the transition function is pure', () => {
  test('the same arguments give the same answer and mutate nothing', () => {
    const input: TransitionInput = { kind: 'attempt_waiting_for_approval' };
    const frozen = Object.freeze({ ...input });
    const first = transition('running', frozen);
    const second = transition('running', frozen);
    expect(first).toEqual(second);
    expect(frozen).toEqual({ kind: 'attempt_waiting_for_approval' });
  });
});

describe('declared artifact checks', () => {
  const completing = (over: Partial<Extract<TransitionInput, { kind: 'attempt_completed' }>>) =>
    transition('running', {
      kind: 'attempt_completed',
      all_actions_terminal: true,
      has_unknown_action: false,
      deliverable_declared: false,
      deliverable_satisfied: true,
      ...over,
    } as TransitionInput);

  test('a failing artifact check turns a completion into a question', () => {
    expect(unwrap(completing({ artifact_validations_passed: false }))).toBe('waiting_for_input');
    expect(unwrap(completing({ artifact_validations_passed: true }))).toBe('completed');
  });

  test('a caller that knows nothing about artifacts is unaffected', () => {
    // The field is optional so every existing caller keeps its behaviour; only
    // a caller that has read the validation rows can say false.
    expect(unwrap(completing({}))).toBe('completed');
  });

  test('an unresolved external effect still outranks a failing check', () => {
    expect(
      unwrap(completing({ artifact_validations_passed: false, has_unknown_action: true })),
    ).toBe('needs_reconciliation');
  });
});
