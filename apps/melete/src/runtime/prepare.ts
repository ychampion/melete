import type {
  AttemptBundle,
  EventSink,
  QuestioningRuntimeAdapter,
  RuntimeAdapter,
} from '@melete/contracts';

/**
 * Gets an attempt's engine ready ahead of its start; the function it returns
 * gives that engine up when the attempt never starts.
 */
export type PrepareEngine = (bundle: AttemptBundle, signal: AbortSignal) => () => void;

/**
 * The runtime with each attempt's engine got ready the moment the attempt
 * reaches it, so the engine loads while everything this runtime wraps does its
 * own work first: the privacy check, a long conversation's summary, and the
 * recall of memory. Only what the engine is started with is used (the model,
 * the tools' features and the attempt's own values); nothing the attempt is
 * told reaches the engine before its start. An attempt that ends before its
 * start, refused or failed, gives the engine up.
 */
export function withPreparedEngine<T extends RuntimeAdapter | QuestioningRuntimeAdapter>(
  runtime: T,
  prepareEngine: PrepareEngine,
): T {
  const start = async (bundle: AttemptBundle, sink: EventSink, signal: AbortSignal) => {
    const giveUp = prepareEngine(bundle, signal);
    try {
      return await (
        runtime.start as (
          bundle: AttemptBundle,
          sink: EventSink,
          signal: AbortSignal,
        ) => ReturnType<T['start']>
      )(bundle, sink, signal);
    } finally {
      // Once the attempt took its engine, this does nothing.
      giveUp();
    }
  };
  return new Proxy(runtime, {
    get(target, property) {
      if (property === 'start') return start;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
