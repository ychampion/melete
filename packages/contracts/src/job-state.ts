/**
 * The job state machine. A responsibility outlives any process, so its state is
 * a small, closed set with a pure transition function that the service and the
 * tests share. Nothing here touches a database, a clock, or a queue.
 */
import { z } from 'zod';
import { err, ok, type Result } from './common.ts';

export const JOB_STATES = [
  'queued',
  'running',
  'waiting_for_input',
  'waiting_for_approval',
  'waiting_for_event_or_time',
  'needs_reconciliation',
  'completed',
  'failed',
  'cancelled',
] as const;

export const jobState = z.enum(JOB_STATES);
export type JobState = z.infer<typeof jobState>;

export const TERMINAL_STATES = [
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly JobState[];

export const WAITING_STATES = [
  'waiting_for_input',
  'waiting_for_approval',
  'waiting_for_event_or_time',
  'needs_reconciliation',
] as const satisfies readonly JobState[];

export const isTerminal = (state: JobState): boolean =>
  (TERMINAL_STATES as readonly JobState[]).includes(state);

export const isWaiting = (state: JobState): boolean =>
  (WAITING_STATES as readonly JobState[]).includes(state);

/**
 * Inputs are the only things that move a job. Each one names an authorized fact
 * that has already been persisted: a lease taken, an attempt's committed
 * outcome, an approval decision, a timer that fired.
 */
export const transitionInput = z.discriminatedUnion('kind', [
  // The scheduler took the lease and is about to run one bounded attempt.
  z.object({ kind: z.literal('attempt_started') }),
  // An attempt committed "completed". Completion is not the runtime's decision
  // alone: every action must be terminal and the deliverable predicate must
  // hold, or the job waits instead of claiming success.
  z.object({
    kind: z.literal('attempt_completed'),
    all_actions_terminal: z.boolean(),
    has_unknown_action: z.boolean(),
    deliverable_declared: z.boolean(),
    deliverable_satisfied: z.boolean(),
  }),
  z.object({ kind: z.literal('attempt_waiting_for_input') }),
  z.object({ kind: z.literal('attempt_waiting_for_approval') }),
  z.object({ kind: z.literal('attempt_waiting_for_event_or_time') }),
  z.object({
    kind: z.literal('attempt_failed'),
    retryable: z.boolean(),
    attempts_remaining: z.number().int().min(0),
  }),
  z.object({ kind: z.literal('attempt_budget_exhausted') }),
  // An action came back unknown; the job cannot proceed until verify or a
  // human decides what really happened.
  z.object({ kind: z.literal('action_unknown') }),
  z.object({ kind: z.literal('user_input_received') }),
  z.object({
    kind: z.literal('approval_decided'),
    decision: z.enum(['approved', 'denied']),
  }),
  z.object({ kind: z.literal('event_fired') }),
  z.object({ kind: z.literal('timer_fired') }),
  z.object({ kind: z.literal('reconciled') }),
  z.object({ kind: z.literal('cancelled') }),
]);

export type TransitionInput = z.infer<typeof transitionInput>;
export type TransitionInputKind = TransitionInput['kind'];

export const TRANSITION_ERROR_CODES = [
  'illegal_transition',
  'already_terminal',
  'actions_not_terminal',
] as const;

export const transitionErrorCode = z.enum(TRANSITION_ERROR_CODES);
export type TransitionErrorCode = z.infer<typeof transitionErrorCode>;

export type TransitionError = {
  code: TransitionErrorCode;
  message: string;
  from: JobState;
  input: TransitionInputKind;
};

const fail = (
  code: TransitionErrorCode,
  message: string,
  from: JobState,
  input: TransitionInput,
): Result<JobState, TransitionError> => err({ code, message, from, input: input.kind });

/**
 * The whole state machine. Given a state and an authorized input, return the
 * next state or an error explaining why the input does not apply. Pure: same
 * arguments, same answer, forever.
 */
export function transition(
  state: JobState,
  input: TransitionInput,
): Result<JobState, TransitionError> {
  // Cancellation is legal from anywhere that is not already finished. Admitted
  // actions may still land; their disposition is recorded honestly elsewhere,
  // so a cancelled job never hides an unknown effect.
  if (input.kind === 'cancelled') {
    return isTerminal(state)
      ? fail('already_terminal', `job is already ${state}`, state, input)
      : ok('cancelled');
  }

  if (isTerminal(state)) {
    return fail('already_terminal', `no input applies to a ${state} job`, state, input);
  }

  switch (state) {
    case 'queued':
      if (input.kind === 'attempt_started') return ok('running');
      return fail(
        'illegal_transition',
        `a queued job accepts attempt_started, not ${input.kind}`,
        state,
        input,
      );

    case 'running':
      switch (input.kind) {
        case 'attempt_completed': {
          // An unresolved external effect outranks a happy summary.
          if (input.has_unknown_action) return ok('needs_reconciliation');
          if (!input.all_actions_terminal) {
            return fail(
              'actions_not_terminal',
              'an attempt cannot complete while an action is still in flight',
              state,
              input,
            );
          }
          // A final answer with no evidence is a question, not a result.
          if (input.deliverable_declared && !input.deliverable_satisfied) {
            return ok('waiting_for_input');
          }
          return ok('completed');
        }
        case 'attempt_waiting_for_input':
          return ok('waiting_for_input');
        case 'attempt_waiting_for_approval':
          return ok('waiting_for_approval');
        case 'attempt_waiting_for_event_or_time':
          return ok('waiting_for_event_or_time');
        case 'action_unknown':
          return ok('needs_reconciliation');
        case 'attempt_failed':
          return input.retryable && input.attempts_remaining > 0 ? ok('queued') : ok('failed');
        case 'attempt_budget_exhausted':
          return ok('failed');
        default:
          return fail(
            'illegal_transition',
            `a running job does not accept ${input.kind}`,
            state,
            input,
          );
      }

    case 'waiting_for_input':
      if (input.kind === 'user_input_received') return ok('queued');
      return fail(
        'illegal_transition',
        `waiting_for_input accepts user_input_received, not ${input.kind}`,
        state,
        input,
      );

    case 'waiting_for_approval':
      // A denial wakes the job too: it is information the next attempt must act
      // on, not a reason to strand the responsibility.
      if (input.kind === 'approval_decided') return ok('queued');
      return fail(
        'illegal_transition',
        `waiting_for_approval accepts approval_decided, not ${input.kind}`,
        state,
        input,
      );

    case 'waiting_for_event_or_time':
      if (input.kind === 'event_fired' || input.kind === 'timer_fired') return ok('queued');
      return fail(
        'illegal_transition',
        `waiting_for_event_or_time accepts event_fired or timer_fired, not ${input.kind}`,
        state,
        input,
      );

    case 'needs_reconciliation':
      if (input.kind === 'reconciled') return ok('queued');
      return fail(
        'illegal_transition',
        `needs_reconciliation accepts reconciled, not ${input.kind}`,
        state,
        input,
      );

    default:
      return fail('illegal_transition', `unhandled state ${state}`, state, input);
  }
}

/** Every legal edge, for documentation and for the exhaustive state-machine test. */
export const LEGAL_EDGES: ReadonlyArray<{
  from: JobState;
  input: TransitionInputKind;
  to: JobState;
}> = [
  { from: 'queued', input: 'attempt_started', to: 'running' },
  { from: 'running', input: 'attempt_completed', to: 'completed' },
  { from: 'running', input: 'attempt_waiting_for_input', to: 'waiting_for_input' },
  { from: 'running', input: 'attempt_waiting_for_approval', to: 'waiting_for_approval' },
  {
    from: 'running',
    input: 'attempt_waiting_for_event_or_time',
    to: 'waiting_for_event_or_time',
  },
  { from: 'running', input: 'action_unknown', to: 'needs_reconciliation' },
  { from: 'running', input: 'attempt_failed', to: 'failed' },
  { from: 'running', input: 'attempt_budget_exhausted', to: 'failed' },
  { from: 'waiting_for_input', input: 'user_input_received', to: 'queued' },
  { from: 'waiting_for_approval', input: 'approval_decided', to: 'queued' },
  { from: 'waiting_for_event_or_time', input: 'event_fired', to: 'queued' },
  { from: 'waiting_for_event_or_time', input: 'timer_fired', to: 'queued' },
  { from: 'needs_reconciliation', input: 'reconciled', to: 'queued' },
  { from: 'queued', input: 'cancelled', to: 'cancelled' },
  { from: 'running', input: 'cancelled', to: 'cancelled' },
  { from: 'waiting_for_input', input: 'cancelled', to: 'cancelled' },
  { from: 'waiting_for_approval', input: 'cancelled', to: 'cancelled' },
  { from: 'waiting_for_event_or_time', input: 'cancelled', to: 'cancelled' },
  { from: 'needs_reconciliation', input: 'cancelled', to: 'cancelled' },
];
