/**
 * Before an attempt starts, the privacy router may need the person: a
 * conversation that must stay private has no local model to stay on. The
 * engine is not started; the attempt ends waiting for their answer with one
 * quick question, and nothing has been sent anywhere.
 *
 * The check fails open on an internal error on purpose: the gateway is where a
 * request is refused, and it fails closed, so a broken check can cost a failed
 * request but can never send a private conversation to a cloud model.
 */
import {
  type AttemptBundle,
  type CommittedOutcome,
  dedupKey,
  type EventSink,
  type QuestioningRuntimeAdapter,
  type RuntimeAdapter,
} from '@melete/contracts';
import type { Protocol } from './redact.ts';
import type { PrivacyRouter } from './router.ts';

export function withPrivacyGate<T extends RuntimeAdapter | QuestioningRuntimeAdapter>(
  runtime: T,
  options: {
    router: () => PrivacyRouter;
    engineProtocol: Protocol;
    onError?: (error: Error) => void;
  },
): QuestioningRuntimeAdapter {
  const start = async (
    bundle: AttemptBundle,
    sink: EventSink,
    signal: AbortSignal,
  ): Promise<CommittedOutcome> => {
    let decision: Awaited<ReturnType<PrivacyRouter['beforeAttempt']>> = { proceed: true };
    try {
      decision = await options.router().beforeAttempt(bundle, options.engineProtocol);
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
    if (decision.proceed) return runtime.start(bundle, sink, signal);
    await sink.emit({
      type: 'text_delta',
      text: decision.text,
      attempt_id: bundle.attempt.id,
      local_seq: 0,
      dedup_key: dedupKey(bundle.attempt.id, 0),
      at: new Date().toISOString(),
    });
    return {
      outcome: { kind: 'waiting_for_input', question: decision.text },
      questions: decision.question ? [decision.question] : [],
    };
  };
  return new Proxy(runtime, {
    get(target, property) {
      if (property === 'start') return start;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as QuestioningRuntimeAdapter;
}
