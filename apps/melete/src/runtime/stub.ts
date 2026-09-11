import {
  type AttemptBundle,
  type AttemptOutcome,
  attemptOutcome,
  type ContextInvalidated,
  dedupKey,
  type EventSink,
  type JsonObject,
  jsonObject,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  runtimeEvent,
} from '@melete/contracts';
import { z } from 'zod';

const selector = {
  epoch: z.union([z.number().int().positive(), z.array(z.number().int().positive())]).optional(),
};
const stepSchema = z.discriminatedUnion('type', [
  z.object({ ...selector, type: z.literal('turn_started'), turn: z.number().int().nonnegative() }),
  z.object({ ...selector, type: z.literal('text_delta'), text: z.string() }),
  z.object({
    ...selector,
    type: z.literal('tool'),
    tool: z.string().min(1),
    call_id: z.string().min(1),
    arguments: jsonObject.optional(),
    result: jsonObject.optional(),
    ok: z.boolean().optional(),
  }),
  z.object({
    ...selector,
    type: z.literal('action_requested'),
    action_id: z.string(),
    kind: z.string(),
  }),
  z.object({
    ...selector,
    type: z.literal('sleep'),
    ms: z.number().int().nonnegative().max(2_147_483_647),
  }),
  z.object({ ...selector, type: z.literal('stall'), key: z.string().min(1) }),
  z.object({ ...selector, type: z.literal('crash'), message: z.string().optional() }),
  z.object({ ...selector, type: z.literal('outcome'), outcome: attemptOutcome }),
]);
const scriptSchema = z.object({
  script: z.array(stepSchema),
  ignore_abort: z.boolean().optional(),
});

/**
 * Store {script:[...]} as JSON in job.constraints.notes. Each step may select a
 * specific epoch (or epochs), so a crash in attempt A need not recur in B.
 * Tool steps reuse their call_id across attempts; only a durable tool transcript
 * entry proves they completed. An outcome step can return any frozen outcome kind.
 */
export type StubStep = z.infer<typeof stepSchema>;
export type StubScript = z.infer<typeof scriptSchema>;

export type StubRuntimeOptions = {
  onContextInvalidated?: (control: ContextInvalidated) => void | Promise<void>;
  /** A scripted fake effect. No provider or connector is contacted by the stub. */
  onTool?: (
    callId: string,
    args: JsonObject,
    bundle: AttemptBundle,
  ) => JsonObject | Promise<JsonObject>;
  /** Resolve a named gate to let a deliberately stalled attempt continue. */
  onStall?: (key: string, bundle: AttemptBundle) => Promise<void>;
  /** Models a process ignoring cancellation, for service fencing verification. */
  ignoreAbort?: boolean;
};

export class StubRuntimeCrash extends Error {
  override name = 'StubRuntimeCrash';
}

type EventBody<T = RuntimeEvent> = T extends RuntimeEvent
  ? Omit<T, 'attempt_id' | 'local_seq' | 'dedup_key' | 'at'>
  : never;

function readScript(bundle: AttemptBundle): StubScript {
  const constraints = bundle.job.constraints;
  if ('script' in constraints) return scriptSchema.parse(constraints);
  if (typeof constraints.notes !== 'string' || !constraints.notes.trim().startsWith('{')) {
    return { script: [] };
  }
  const parsed: unknown = JSON.parse(constraints.notes);
  if (typeof parsed !== 'object' || parsed === null || !('script' in parsed)) {
    return { script: [] };
  }
  return scriptSchema.parse(parsed);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Stub attempt aborted', 'AbortError');
}

async function waitFor(
  pending: Promise<void>,
  signal: AbortSignal,
  ignoreAbort: boolean,
): Promise<void> {
  if (ignoreAbort) return pending;
  if (signal.aborted) throw abortError(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([pending, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** Deterministic disposable runtime used by the service integration suite. */
export class StubRuntimeAdapter implements RuntimeAdapter {
  constructor(private readonly options: StubRuntimeOptions = {}) {}

  contextInvalidated(control: ContextInvalidated) {
    return this.options.onContextInvalidated?.(control);
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return { streaming: true, tools: true, interrupt: true, version: 'stub/1' };
  }

  async start(
    bundle: AttemptBundle,
    sink: EventSink,
    signal: AbortSignal,
  ): Promise<AttemptOutcome> {
    const script = readScript(bundle);
    const ignoreAbort = script.ignore_abort ?? this.options.ignoreAbort ?? false;
    const completedCalls = new Set(
      bundle.transcript
        .filter((message) => message.role === 'tool' && message.tool_call_id)
        .map((message) => message.tool_call_id),
    );
    let localSeq = 0;
    const emit = async (body: EventBody): Promise<void> => {
      const seq = localSeq++;
      await sink.emit(
        runtimeEvent.parse({
          ...body,
          attempt_id: bundle.attempt.id,
          local_seq: seq,
          dedup_key: dedupKey(bundle.attempt.id, seq),
          at: new Date().toISOString(),
        }),
      );
    };
    const checkAbort = (): void => {
      if (!ignoreAbort && signal.aborted) throw abortError(signal);
    };
    const finish = async (outcome: AttemptOutcome): Promise<AttemptOutcome> => {
      checkAbort();
      await emit({ type: 'attempt_outcome', outcome });
      return outcome;
    };

    checkAbort();
    for (const step of script.script) {
      const epochs = Array.isArray(step.epoch) ? step.epoch : [step.epoch];
      if (step.epoch !== undefined && !epochs.includes(bundle.attempt.epoch)) continue;
      checkAbort();
      switch (step.type) {
        case 'turn_started':
          await emit({ type: 'turn_started', turn: step.turn });
          break;
        case 'text_delta':
          await emit({ type: 'text_delta', text: step.text });
          break;
        case 'action_requested':
          await emit({ type: 'action_requested', action_id: step.action_id, kind: step.kind });
          break;
        case 'tool': {
          if (completedCalls.has(step.call_id)) break;
          const args = step.arguments ?? {};
          await emit({
            type: 'tool_call_proposed',
            tool: step.tool,
            call_id: step.call_id,
            arguments: args,
          });
          checkAbort();
          const result = this.options.onTool
            ? await this.options.onTool(step.call_id, args, bundle)
            : (step.result ?? {});
          // Once a fake effect completes, persist its result even if cancellation
          // arrived meanwhile; the service decides whether the receipt is late.
          await emit({ type: 'tool_result', call_id: step.call_id, ok: step.ok ?? true, result });
          completedCalls.add(step.call_id);
          break;
        }
        case 'sleep': {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const pending = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, step.ms);
          });
          try {
            await waitFor(pending, signal, ignoreAbort);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
          break;
        }
        case 'stall':
          await waitFor(
            this.options.onStall?.(step.key, bundle) ?? new Promise<void>(() => {}),
            signal,
            ignoreAbort,
          );
          break;
        case 'crash':
          throw new StubRuntimeCrash(step.message ?? 'scripted runtime crash');
        case 'outcome':
          return finish(step.outcome);
      }
    }
    return finish({ kind: 'completed', summary: 'Script completed.', evidence: [] });
  }
}
