/**
 * Before an attempt starts, the privacy router may need the person: a
 * conversation that must stay private has no local model to stay on. The
 * engine is not started; the attempt ends waiting for their answer with one
 * quick question, and nothing has been sent anywhere.
 *
 * The check fails closed. It is the only place a job's own words are judged
 * for a sensitive topic before they reach the gateway, so when it cannot
 * finish, the engine is not started either: the attempt ends waiting, the
 * person is told plainly that nothing was sent, and their next message tries
 * again.
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

/** The model an attempt runs on, as its bundle names it. */
export type AttemptModel = { provider: string; model: string };
/** How an attempt's model is reached: the protocol it speaks and its address. */
export type AttemptEngine = { protocol: Protocol; providerUrl?: string };

/** What the person is told when the check could not be made. */
export const CHECK_FAILED =
  'Melete could not check whether this conversation needs to stay private, so it has not sent anything to a model. Send your message again to try once more.';

export function withPrivacyGate<T extends RuntimeAdapter | QuestioningRuntimeAdapter>(
  runtime: T,
  options: {
    router: () => PrivacyRouter;
    engineProtocol: Protocol;
    /** The configured provider's address, which the owner may have confirmed is a model they run. */
    providerUrl?: string;
    /**
     * The protocol and address of the model this attempt runs on. Given, it is
     * what the check judges, so an attempt on another model than the server's
     * default (one chosen in the app, or the secondary) is asked about as that
     * model rather than refused later at the gateway.
     */
    engineFor?: (model: AttemptModel) => Promise<AttemptEngine>;
    onError?: (error: Error) => void;
  },
): QuestioningRuntimeAdapter {
  const start = async (
    bundle: AttemptBundle,
    sink: EventSink,
    signal: AbortSignal,
  ): Promise<CommittedOutcome> => {
    let decision: Awaited<ReturnType<PrivacyRouter['beforeAttempt']>>;
    try {
      const engine =
        options.engineFor && bundle.model
          ? await options.engineFor(bundle.model)
          : { protocol: options.engineProtocol, providerUrl: options.providerUrl };
      decision = await options.router().beforeAttempt(bundle, engine.protocol, engine.providerUrl);
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      decision = { proceed: false, text: CHECK_FAILED, question: null };
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
