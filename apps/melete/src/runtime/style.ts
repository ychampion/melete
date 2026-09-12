/**
 * Measuring how an attempt talks.
 *
 * The identity file states the reply rules; this decorator writes down whether
 * the attempt followed the four of them a machine can decide. It wraps any
 * runtime adapter, reads the text the attempt committed, and hands the result
 * to a recorder. It never changes the outcome and never fails an attempt: a
 * reply that opened with "Certainly!" is still the reply, and the honest thing
 * to do with the observation is to keep it where a later release can compare.
 */
import {
  type AttemptBundle,
  type AttemptOutcome,
  checkStyle,
  type EventSink,
  type ReplyClass,
  type RuntimeAdapter,
  replyClassOfEvidence,
  type StyleViolation,
} from '@melete/contracts';

/**
 * The text an outcome shows a person. An approval wait and an event wait show
 * nothing of their own, so there is nothing to measure; the service writes
 * those sentences itself from the job row.
 */
export function outcomeText(outcome: AttemptOutcome): string {
  switch (outcome.kind) {
    case 'completed':
      return outcome.summary;
    case 'waiting_for_input':
      return outcome.draft ? `${outcome.draft}\n\n${outcome.question}` : outcome.question;
    case 'budget_exhausted':
      return outcome.summary;
    case 'failed':
      return outcome.reason;
    default:
      return '';
  }
}

/** Which budget this outcome is measured against, decided from records only. */
export function replyClassOf(outcome: AttemptOutcome): ReplyClass {
  return outcome.kind === 'completed' ? replyClassOfEvidence(outcome.evidence) : 'casual';
}

/** Everything the check saw in one attempt's own outgoing text. */
export const styleViolationsOf = (outcome: AttemptOutcome): StyleViolation[] =>
  checkStyle(outcomeText(outcome), { reply_class: replyClassOf(outcome) });

export type StyleRecorder = (
  attemptId: string,
  violations: readonly StyleViolation[],
) => Promise<void> | void;

/**
 * Wrap a runtime so every attempt's text is measured. A recorder that throws is
 * swallowed on purpose: losing a measurement is a smaller harm than failing a
 * finished attempt over bookkeeping, and the attempt's own outcome is already
 * durable by the time this runs.
 */
export function withStyleCheck(runtime: RuntimeAdapter, record: StyleRecorder): RuntimeAdapter {
  return {
    capabilities: () => runtime.capabilities(),
    async start(bundle: AttemptBundle, sink: EventSink, signal: AbortSignal) {
      const outcome = await runtime.start(bundle, sink, signal);
      try {
        await record(bundle.attempt.id, styleViolationsOf(outcome));
      } catch {
        // Measured, not enforced. A recorder failure changes nothing about the outcome.
      }
      return outcome;
    },
  };
}
