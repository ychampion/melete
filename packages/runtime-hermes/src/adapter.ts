/**
 * The `RuntimeAdapter` over a pinned Hermes API server.
 *
 * Everything difficult here is about not lying. The engine's run stream is an
 * in-memory queue with no replay (`gateway/platforms/api_server_runs.py:154`),
 * so a dropped connection is lost history and not a pause. An `interrupted` run
 * is a dead attempt. Neither ever becomes a completion: they become
 * `failed{retryable:true}` with a reason that says events are missing, and the
 * job survives in Postgres so the next wake starts a fresh attempt.
 */
import {
  type AttemptBundle,
  type AttemptOutcome,
  BROKER_TIMEOUT_MS,
  dedupKey,
  type EventSink,
  hookCaptureErrorCode,
  hookObservation,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type ToolSpec,
  toolSpec,
  type WaitSpec,
  waitSpec,
} from '@melete/contracts';
import {
  HermesClient,
  type HermesRequest,
  hermesCapabilities,
  hermesRunAccepted,
  hermesRunEvent,
  isTerminalEvent,
  parseSse,
} from './client.ts';
import { asksWithoutProposing, UNPROPOSED_CONTINUATION } from './proposal.ts';
import { HERMES_PINNED_TAG, RUNTIME_VERSION } from './version.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The action ids this attempt left parked on the ledger.
 *
 * Injected rather than looked up here: reading the ledger needs the service's
 * own credential and a space, and handing those to the adapter would put the
 * approval key one refactor away from the runtime's side of the boundary. The
 * service knows both and passes a closure.
 */
export type ParkedActions = ((bundle: AttemptBundle, signal?: AbortSignal) => Promise<string[]>) & {
  /** Supplied by the service's broker client; defaults to the shared broker timeout. */
  readonly timeoutMs?: number;
};

/** Read through the service's authenticated broker client, never from model output. */
export type CatalogState = (bundle: AttemptBundle, signal?: AbortSignal) => Promise<ToolSpec[]>;

type RunResult = {
  outcome: AttemptOutcome;
  loaded?: ToolSpec[];
  outputTokens: number;
  /** Tool names this run called, in order, including calls the broker refused. */
  called?: string[];
};

type RunBudget = { turns: number; outputTokens: number; deadline: number };

export type HermesAdapterOptions = {
  baseUrl: string;
  /** `API_SERVER_KEY`, when the API server is configured to require one. */
  token?: string;
  /** The workspace path the launched engine writes to, when it is not the bundle's. */
  workspace?: string;
  parkedActions: ParkedActions;
  catalogState?: CatalogState;
  /** A typed, service-owned wait record, never inferred from reply text. */
  pendingWait?: (bundle: AttemptBundle) => Promise<WaitSpec | null>;
  fetch?: FetchLike;
  /** How long to wait for a frame before calling the stream dead. */
  streamIdleMs?: number;
};

/** Hermes writes a keepalive every 30s, so silence past 90s is a dead socket. */
const DEFAULT_STREAM_IDLE_MS = 90_000;

export class HermesRuntimeAdapter implements RuntimeAdapter {
  private readonly client: HermesClient;
  private readonly fetch: FetchLike;
  private readonly options: HermesAdapterOptions;

  constructor(options: HermesAdapterOptions) {
    this.options = options;
    this.client = new HermesClient({
      baseUrl: options.baseUrl,
      token: options.token,
      workspace: options.workspace,
    });
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * What this build supports, read from the engine rather than declared here.
   *
   * Durable idempotency is a refusal, not a warning. Without it a restart
   * between the start request and its answer turns a retry into a second run,
   * and a second run is a second set of effects.
   */
  async capabilities(): Promise<RuntimeCapabilities> {
    const body = await this.json(this.client.capabilities());
    const parsed = hermesCapabilities.parse(body);
    const idempotency = parsed.features.runs_idempotency;
    if (!idempotency?.supported || !idempotency.durable) {
      throw new Error(
        'the Hermes API server reports no durable run idempotency; a retried start would ' +
          'become a second run. Give it a writable HERMES_HOME and try again.',
      );
    }
    return {
      streaming: parsed.features.run_events_sse !== false,
      tools: true,
      interrupt: parsed.features.run_stop !== false,
      version: parsed.model ? `${RUNTIME_VERSION} (${parsed.model})` : RUNTIME_VERSION,
    };
  }

  async start(
    bundle: AttemptBundle,
    sink: EventSink,
    signal: AbortSignal,
  ): Promise<AttemptOutcome> {
    const emitter = new SequencedSink(bundle.attempt.id, sink);
    const controller = new AbortController();
    const deadline = Date.now() + bundle.budget.max_wall_ms;
    // The timer that ends the budget is also what records that it ended. The
    // deadline is armed off a monotonic timer and would otherwise be read back
    // off the wall clock, and those two disagree: a timer may fire a tick early,
    // and a host whose clock is slewed or stepped back leaves a spent budget
    // reading as unspent. The attempt is then written down as a failure rather
    // than an exhausted budget, which is a different thing to tell an owner.
    let wallExpired = false;
    const timer = setTimeout(() => {
      wallExpired = true;
      controller.abort();
    }, bundle.budget.max_wall_ms);
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const budget: RunBudget = { turns: 0, outputTokens: 0, deadline };
    let input = this.client.renderInput(bundle);
    if (bundle.transcript.length) {
      // The broker's prior context is persisted as part of this first input.
      // Subsequent runs hydrate the same session's native history. The pin's
      // explicit conversation_history parser strips tool-call fields, whereas
      // session hydration preserves them and keeps provider history append-only.
      input += `\n\n## Recorded prior context\n\n${JSON.stringify(bundle.transcript)}`;
    }
    let catalog = bundle.tools;
    let runId: string | undefined;
    let final: AttemptOutcome = exhausted('The attempt reached its turn limit.');
    // Every tool the attempt called, across continuations, and whether it has
    // already had its one chance to propose what it asked the owner about.
    const called: string[] = [];
    let nudged = false;
    // The owner refused something in this wake. Telling the attempt to call the
    // tool now would be Melete's own idea to ask again for what was just
    // refused: the ledger would stop the same bytes, but a variation of them is
    // a fresh question the owner never invited. The reply is still treated as a
    // question rather than a completion.
    const refused = bundle.inputs.approval_results.some((entry) => entry.decision === 'denied');
    const stop = () => {
      if (runId) void this.send(this.client.stop(runId)).catch(() => undefined);
    };
    controller.signal.addEventListener('abort', stop);
    try {
      if (this.options.catalogState) {
        catalog = await beforeDeadline(
          this.options.catalogState(bundle, controller.signal),
          deadline,
        );
      }
      for (let index = 0; index < bundle.budget.max_turns; index++) {
        if (
          controller.signal.aborted ||
          budget.turns >= bundle.budget.max_turns ||
          budget.outputTokens >= bundle.budget.max_output_tokens
        ) {
          final = signal.aborted
            ? gap('the attempt was cancelled')
            : exhausted('The attempt reached its shared runtime budget.');
          break;
        }
        const accepted = hermesRunAccepted.parse(
          await beforeDeadline(
            this.json(
              this.client.startRun(bundle, {
                index,
                input,
              }),
              controller.signal,
            ),
            deadline,
          ),
        );
        runId = accepted.run_id;
        if (controller.signal.aborted) stop();
        const result = await this.consume(
          runId,
          bundle,
          emitter,
          controller.signal,
          catalog,
          budget,
        );
        budget.outputTokens += result.outputTokens;
        called.push(...(result.called ?? []));
        final = result.outcome;
        if (
          budget.outputTokens > bundle.budget.max_output_tokens ||
          budget.turns > bundle.budget.max_turns
        ) {
          final = exhausted('The attempt reached its shared runtime budget.');
          break;
        }
        const unproposed =
          !result.loaded &&
          final.kind === 'completed' &&
          asksWithoutProposing(final.summary, called, catalog);
        if (unproposed && final.kind === 'completed') {
          // A reply asking for a go-ahead is a question to the owner, never a
          // completion. The ledger still has the last word in finish().
          final = { kind: 'waiting_for_input', question: final.summary };
        }
        if (unproposed && !nudged && !refused && !signal.aborted && !controller.signal.aborted) {
          if (
            (await beforeDeadline(this.options.parkedActions(bundle, controller.signal), deadline))
              .length > 0
          )
            break;
          nudged = true;
          input = UNPROPOSED_CONTINUATION;
          continue;
        }
        if (!result.loaded || signal.aborted || controller.signal.aborted) break;
        // Approval wins even when a load and an external proposal shared a run.
        if (
          (await beforeDeadline(this.options.parkedActions(bundle, controller.signal), deadline))
            .length > 0
        )
          break;
        const added = result.loaded.filter(
          (tool) => !catalog.some((old) => old.name === tool.name),
        );
        catalog = result.loaded;
        input = `Continue the same job and attempt. The broker loaded these tools: ${added.map((tool) => tool.name).join(', ')}. Their schemas are now available. Continue from the recorded progress.`;
        final = exhausted('The attempt reached its continuation limit.');
      }
    } catch (error) {
      stop();
      final = {
        kind: 'failed',
        reason: `the runtime refused the run: ${message(error)}`,
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', stop);
    }
    // Either clock is enough to settle this: the timer fired, or the wall clock
    // says the deadline is behind us. Whichever notices first, the budget is
    // what ended the attempt, so a rejection the deadline caused never survives
    // as a failure.
    if ((wallExpired || Date.now() >= deadline) && !signal.aborted)
      final = exhausted('The attempt reached its wall-time limit.');
    return await this.finish(bundle, emitter, final);
  }

  /**
   * Read the stream exactly once and map what comes off it.
   *
   * The return value is what the engine said happened. Whether that survives
   * contact with the ledger is decided in `finish`.
   */
  private async consume(
    runId: string,
    bundle: AttemptBundle,
    emitter: SequencedSink,
    signal: AbortSignal,
    catalog: ToolSpec[],
    budget: RunBudget,
  ): Promise<RunResult> {
    const result = (outcome: AttemptOutcome): RunResult => ({
      outcome,
      outputTokens: 0,
    });
    let response: Response;
    try {
      response = await this.send(this.client.events(runId), signal);
    } catch (error) {
      return result(gap(`the event stream could not be opened: ${message(error)}`));
    }
    if (!response.ok || !response.body) {
      return result(gap(`the event stream answered ${response.status}`));
    }

    await emitter.emit({ type: 'turn_started', turn: budget.turns });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const calls = new CallIds();
    let buffer = '';
    let outcome: AttemptOutcome | null = null;
    let loaded: ToolSpec[] | undefined;
    let text = '';
    const completedTools: string[] = [];
    let outputTokens = 0;
    let budgetStopped = false;

    try {
      for (;;) {
        const chunk = await withTimeout(
          reader.read(),
          Math.max(
            1,
            Math.min(
              this.options.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS,
              budget.deadline - Date.now(),
            ),
          ),
        );
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const { messages, rest } = parseSse(buffer);
        buffer = rest;
        for (const sse of messages) {
          const event = safeParseEvent(sse.data);
          if (!event) continue;
          const mapped = await this.handle(runId, event, emitter, calls);
          if (mapped) outcome = mapped;
          if (event.event === 'message.delta') text += String(event.delta ?? '');
          if (event.event === 'tool.started') budget.turns++;
          if (event.event === 'tool.completed') {
            completedTools.push(String(event.tool ?? 'unknown'));
            if (event.tool === 'load_tool' && event.error !== true && this.options.catalogState) {
              const current = await beforeDeadline(
                this.options.catalogState(bundle, signal),
                budget.deadline,
              );
              if (current.some((tool) => !catalog.some((old) => old.name === tool.name))) {
                loaded = current;
                // Stop explicitly; the model need not obey a textual instruction.
                // Drain to a terminal frame before another run may execute.
                await beforeDeadline(this.send(this.client.stop(runId)), budget.deadline);
              }
            }
          }
          if (
            !outcome &&
            !budgetStopped &&
            (budget.turns >= bundle.budget.max_turns ||
              budget.outputTokens + Math.ceil(text.length / 4) > bundle.budget.max_output_tokens)
          ) {
            budgetStopped = true;
            await beforeDeadline(this.send(this.client.stop(runId)), budget.deadline);
          }
          if (isTerminalEvent(String(event.event))) {
            const usage = event.usage as Record<string, unknown> | undefined;
            outputTokens = Math.max(Math.ceil(text.length / 4), Number(usage?.output_tokens ?? 0));
            if (!completedTools.length || text) budget.turns++;
            if (loaded && (event.event === 'run.cancelled' || event.event === 'run.completed')) {
              outcome = { kind: 'completed', summary: 'tools_loaded', evidence: [] };
            }
            if (budgetStopped)
              outcome = exhausted('The attempt reached its shared runtime budget.');
          }
        }
        if (outcome) break;
      }
    } catch (error) {
      // A read that threw took whatever the engine had already queued with it.
      return result(
        gap(
          signal.aborted
            ? 'the attempt was cancelled while its event stream was open'
            : `the event stream ended early: ${message(error)}`,
        ),
      );
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    if (outcome)
      return {
        outcome,
        ...(loaded && !budgetStopped && outcome.kind === 'completed' ? { loaded } : {}),
        outputTokens,
        called: completedTools,
      };
    // The socket closed without a terminal frame. The engine may have finished;
    // there is no way to tell from here, and guessing would invent a result.
    void bundle;
    return result(gap('the event stream closed before the run reported an outcome'));
  }

  /** Map one engine frame. Returns an outcome only for a terminal frame. */
  private async handle(
    runId: string,
    event: Record<string, unknown>,
    emitter: SequencedSink,
    calls: CallIds,
  ): Promise<AttemptOutcome | null> {
    const name = String(event.event);

    if (name === 'hook.event' || name === 'hook.error') {
      await emitter.hook(event, name === 'hook.error');
      return null;
    }

    if (name === 'message.delta') {
      await emitter.emit({ type: 'text_delta', text: String(event.delta ?? '') });
      return null;
    }

    if (name === 'tool.started') {
      const tool = String(event.tool ?? 'unknown');
      // The engine's public run stream carries a preview string, never the
      // arguments (`_FIXED_EVENT_FIELDS` in api_server_runs.py). The real
      // canonical payload is on the broker's action record, which is where an
      // approval is argued over; this is for the live view only.
      await emitter.emit({
        type: 'tool_call_proposed',
        tool,
        call_id: calls.open(tool, emitter.next),
        arguments: { preview: String(event.preview ?? '') },
      });
      return null;
    }

    if (name === 'tool.completed') {
      const tool = String(event.tool ?? 'unknown');
      await emitter.emit({
        type: 'tool_result',
        call_id: calls.close(tool),
        ok: event.error !== true,
        result: { duration_seconds: Number(event.duration ?? 0) },
      });
      return null;
    }

    if (name === 'approval.request') {
      // Melete's own approvals never come through here: a broker tool returns a
      // structured needs-approval result and the job parks. This is the shell
      // command guard, and Melete has no shell tool, so the honest answer is no.
      // Never `once`, and never a session or permanent allowance, which would
      // outlive the attempt it was granted for.
      const requestId = typeof event.request_id === 'string' ? event.request_id : null;
      if (requestId) {
        await this.send(this.client.approve(runId, requestId, 'deny')).catch(() => undefined);
      }
      return null;
    }

    if (isTerminalEvent(name)) {
      if (name === 'run.completed') {
        return {
          kind: 'completed',
          summary: String(event.output ?? '').trim(),
          // Evidence is the broker's to name. The engine knows nothing about
          // action ids, so claiming any here would be fabrication.
          evidence: [],
        };
      }
      if (name === 'run.failed') {
        return {
          kind: 'failed',
          reason: String(event.error ?? 'the runtime reported a failure'),
          retryable: true,
        };
      }
      // interrupted and cancelled: the owner process died or the attempt was
      // stopped. Either way this attempt is dead and is never resumed.
      return gap(`the run ended as ${name.replace('run.', '')}`);
    }

    return null;
  }

  /**
   * The ledger has the last word.
   *
   * A run that ended tidily still owes an answer if it left an action waiting
   * for a person: the model was told to stop, and the job has to park rather
   * than report success. This check runs on every outcome, including a failure,
   * because an action parks the moment it is proposed and a later crash does
   * not un-park it.
   */
  private async finish(
    bundle: AttemptBundle,
    emitter: SequencedSink,
    outcome: AttemptOutcome,
  ): Promise<AttemptOutcome> {
    let settled = outcome;
    // Execution has ended. The service owns the lookup timeout independently
    // of the exhausted model budget; a slow broker is not an attempt failure.
    const finalization = new AbortController();
    const timeoutMs = this.options.parkedActions.timeoutMs ?? BROKER_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => finalization.abort(), timeoutMs);
    try {
      const parked = await beforeDeadline(
        this.options.parkedActions(bundle, finalization.signal),
        deadline,
      );
      if (parked.length > 0) {
        for (const actionId of parked) {
          await emitter.emit({ type: 'action_requested', action_id: actionId, kind: 'approval' });
        }
        settled = { kind: 'waiting_for_approval', action_ids: parked as [string, ...string[]] };
      } else if (settled.kind === 'completed' && this.options.pendingWait) {
        const pending = await beforeDeadline(this.options.pendingWait(bundle), deadline);
        if (pending) {
          const wait = waitSpec.parse(pending);
          if (wait.kind !== 'timer' && wait.kind !== 'event')
            throw new Error('Invalid lifecycle wait');
          settled = { kind: 'waiting_for_event_or_time', wait };
        }
      }
    } catch (error) {
      const timedOut =
        finalization.signal.aborted ||
        Date.now() >= deadline ||
        (error instanceof Error && error.name === 'TimeoutError');
      settled = {
        kind: 'unknown_check',
        check: 'parked_actions',
        reason: timedOut ? 'timed_out' : 'unavailable',
        message: timedOut
          ? `The parked-action check timed out after ${timeoutMs} ms; approval state is unknown.`
          : `The parked-action check is unavailable; approval state is unknown: ${message(error)}`,
      };
    } finally {
      clearTimeout(timer);
      finalization.abort();
    }

    await emitter.emit({ type: 'attempt_outcome', outcome: settled });
    return settled;
  }

  private async send(request: HermesRequest, signal?: AbortSignal): Promise<Response> {
    return this.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      ...(signal ? { signal } : {}),
    });
  }

  private async json(request: HermesRequest, signal?: AbortSignal): Promise<unknown> {
    const response = await this.send(request, signal);
    if (!response.ok) {
      throw new Error(
        `${request.method} ${new URL(request.url).pathname} answered ${response.status}`,
      );
    }
    return response.json();
  }
}

/**
 * A dropped or interrupted stream, said plainly.
 *
 * `retryable` is true because the job is intact; what is lost is this attempt's
 * events, not its work. The reason text is the durable record of the gap: it
 * reaches the transcript inside the `attempt_outcome` event, which is the only
 * durable event the contract has for saying that history is missing.
 */
const gap = (reason: string): AttemptOutcome => ({
  kind: 'failed',
  reason: `${reason}. Some events from this attempt were never received, so its transcript is incomplete.`,
  retryable: true,
});

const exhausted = (summary: string): AttemptOutcome => ({ kind: 'budget_exhausted', summary });

/**
 * One runtime event minus the four fields the sink stamps on. Distributive, so
 * the union stays a union: a plain `Omit` over it collapses to the fields the
 * members share, which is only `type`.
 */
type RuntimeEventBody<T extends RuntimeEvent = RuntimeEvent> = T extends RuntimeEvent
  ? Omit<T, 'attempt_id' | 'local_seq' | 'dedup_key' | 'at'>
  : never;

/**
 * Numbers the events and computes the one dedup key format, so replaying a
 * stream after a reconnect writes no duplicate rows.
 */
class SequencedSink {
  private seq = 0;
  private readonly captures = new Map<string, string>();

  constructor(
    private readonly attemptId: string,
    private readonly sink: EventSink,
  ) {}

  get next(): number {
    return this.seq;
  }

  async hook(input: Record<string, unknown>, failed: boolean): Promise<void> {
    if (input.attempt_id !== this.attemptId) throw new Error('hook attempt identity mismatch');
    const observation = hookObservation.parse(input);
    if (!observation.capture_id.startsWith(`${this.attemptId}:hook:`))
      throw new Error('hook capture identity mismatch');
    const event: RuntimeEventBody = failed
      ? {
          ...observation,
          type: 'hook_error',
          error_code: hookCaptureErrorCode.parse(input.error_code),
        }
      : { ...observation, type: 'hook_event' };
    const fingerprint = JSON.stringify(event);
    const previous = this.captures.get(observation.capture_id);
    if (previous !== undefined) {
      if (previous !== fingerprint) throw new Error('hook capture replay changed its contents');
      return;
    }
    await this.emit(event);
    // A retried capture keeps its original event identity; it cannot consume a new sequence.
    this.captures.set(observation.capture_id, fingerprint);
  }

  async emit(event: RuntimeEventBody) {
    const local_seq = this.seq++;
    await this.sink.emit({
      ...event,
      attempt_id: this.attemptId,
      local_seq,
      dedup_key: dedupKey(this.attemptId, local_seq),
      at: new Date().toISOString(),
    } as RuntimeEvent);
  }
}

/**
 * The engine's tool events carry a name and no call id, so a result has to be
 * paired with the start it belongs to. Tools run one at a time on this path, so
 * a per-name stack is exact rather than a guess; an unmatched completion gets
 * its own id instead of being attached to the wrong call.
 */
class CallIds {
  private readonly open_ = new Map<string, string[]>();

  open(tool: string, seq: number): string {
    const id = `${tool}#${seq}`;
    const stack = this.open_.get(tool) ?? [];
    stack.push(id);
    this.open_.set(tool, stack);
    return id;
  }

  close(tool: string): string {
    const stack = this.open_.get(tool);
    return stack?.pop() ?? `${tool}#unmatched`;
  }
}

function safeParseEvent(data: string): Record<string, unknown> | null {
  try {
    const parsed = hermesRunEvent.safeParse(JSON.parse(data));
    return parsed.success ? (parsed.data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no frame for ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const beforeDeadline = <T>(promise: Promise<T>, deadline: number): Promise<T> =>
  withTimeout(promise, Math.max(1, deadline - Date.now()));

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The default ledger lookup: the service's own read route, filtered down to the
 * actions this attempt left waiting. The list route is per job, so the attempt
 * filter happens here.
 */
export function brokerParkedActions(options: {
  brokerUrl: string;
  serviceKey: string;
  spaceId: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): ParkedActions {
  const timeoutMs = options.timeoutMs ?? BROKER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new RangeError('Invalid broker timeout');
  const call =
    options.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const lookup: ParkedActions = async (bundle, signal) => {
    const url = `${options.brokerUrl.replace(/\/+$/, '')}/actions?job_id=${encodeURIComponent(bundle.attempt.job_id)}&status=needs_approval`;
    const response = await call(url, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${options.serviceKey}`,
        'x-melete-space-id': options.spaceId,
        accept: 'application/json',
      },
    });
    if (!response.ok) throw new Error(`the action ledger answered ${response.status}`);
    const body = (await response.json()) as { actions?: { id: string; attempt_id: string }[] };
    return (body.actions ?? [])
      .filter((action) => action.attempt_id === bundle.attempt.id)
      .map((action) => action.id);
  };
  return Object.assign(lookup, { timeoutMs });
}

/** Catalog discovery never receives the service's approval credential. */
export function brokerCatalogState(options: {
  brokerUrl: string;
  fetch?: FetchLike;
}): CatalogState {
  const call =
    options.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  return async (bundle, signal) => {
    const response = await call(`${options.brokerUrl.replace(/\/+$/, '')}/tools`, {
      ...(signal ? { signal } : {}),
      headers: { authorization: `Bearer ${bundle.attempt.token}`, accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`the tool catalog answered ${response.status}`);
    const body = (await response.json()) as { tools?: unknown };
    return toolSpec.array().parse(body.tools);
  };
}

export { HERMES_PINNED_TAG, RUNTIME_VERSION };
