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
  dedupKey,
  type EventSink,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
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
export type ParkedActions = (bundle: AttemptBundle) => Promise<string[]>;

export type HermesAdapterOptions = {
  baseUrl: string;
  /** `API_SERVER_KEY`, when the API server is configured to require one. */
  token?: string;
  parkedActions: ParkedActions;
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
    this.client = new HermesClient({ baseUrl: options.baseUrl, token: options.token });
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

    let runId: string;
    try {
      const accepted = hermesRunAccepted.parse(await this.json(this.client.startRun(bundle)));
      runId = accepted.run_id;
    } catch (error) {
      // Nothing started, so nothing to reconcile and nothing to record as a gap.
      return await this.finish(bundle, emitter, {
        kind: 'failed',
        reason: `the runtime refused the run: ${message(error)}`,
        retryable: true,
      });
    }

    const stop = () => {
      // Best effort: the outcome does not depend on the engine acknowledging.
      void this.send(this.client.stop(runId)).catch(() => undefined);
    };
    signal.addEventListener('abort', stop, { once: true });
    // An abort that arrived while the start request was in flight fired before
    // there was a listener. The run exists by now, so it still has to be told.
    if (signal.aborted) stop();

    try {
      const outcome = await this.consume(runId, bundle, emitter, signal);
      return await this.finish(bundle, emitter, outcome);
    } finally {
      signal.removeEventListener('abort', stop);
    }
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
  ): Promise<AttemptOutcome> {
    let response: Response;
    try {
      response = await this.send(this.client.events(runId), signal);
    } catch (error) {
      return gap(`the event stream could not be opened: ${message(error)}`);
    }
    if (!response.ok || !response.body) {
      return gap(`the event stream answered ${response.status}`);
    }

    await emitter.emit({ type: 'turn_started', turn: 0 });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const calls = new CallIds();
    let buffer = '';
    let outcome: AttemptOutcome | null = null;

    try {
      for (;;) {
        const chunk = await withTimeout(
          reader.read(),
          this.options.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS,
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
        }
        if (outcome) break;
      }
    } catch (error) {
      // A read that threw took whatever the engine had already queued with it.
      return gap(
        signal.aborted
          ? 'the attempt was cancelled while its event stream was open'
          : `the event stream ended early: ${message(error)}`,
      );
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    if (outcome) return outcome;
    // The socket closed without a terminal frame. The engine may have finished;
    // there is no way to tell from here, and guessing would invent a result.
    void bundle;
    return gap('the event stream closed before the run reported an outcome');
  }

  /** Map one engine frame. Returns an outcome only for a terminal frame. */
  private async handle(
    runId: string,
    event: Record<string, unknown>,
    emitter: SequencedSink,
    calls: CallIds,
  ): Promise<AttemptOutcome | null> {
    const name = String(event.event);

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
    try {
      const parked = await this.options.parkedActions(bundle);
      if (parked.length > 0) {
        for (const actionId of parked) {
          await emitter.emit({ type: 'action_requested', action_id: actionId, kind: 'approval' });
        }
        settled = { kind: 'waiting_for_approval', action_ids: parked as [string, ...string[]] };
      }
    } catch (error) {
      // The ledger could not be read, so it is not known whether anything
      // parked. Reporting the engine's outcome unchanged could close a job that
      // is actually waiting on a person, so this fails retryably instead.
      settled = {
        kind: 'failed',
        reason: `the parked-action check failed: ${message(error)}`,
        retryable: true,
      };
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

  private async json(request: HermesRequest): Promise<unknown> {
    const response = await this.send(request);
    if (!response.ok) {
      throw new Error(`${request.method} ${new URL(request.url).pathname} answered ${response.status}`);
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

  constructor(
    private readonly attemptId: string,
    private readonly sink: EventSink,
  ) {}

  get next(): number {
    return this.seq;
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
    const timer = setTimeout(
      () => reject(new Error(`no frame for ${Math.round(ms / 1000)}s`)),
      ms,
    );
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
}): ParkedActions {
  const call = options.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  return async (bundle) => {
    const url = `${options.brokerUrl.replace(/\/+$/, '')}/actions?job_id=${encodeURIComponent(bundle.attempt.job_id)}&status=needs_approval`;
    const response = await call(url, {
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
}

export { HERMES_PINNED_TAG, RUNTIME_VERSION };
