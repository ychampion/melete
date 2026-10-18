/**
 * The `RuntimeAdapter` over a pinned Hermes API server.
 *
 * Everything difficult here is about not lying. The engine's run stream is an
 * in-memory queue with no replay (`gateway/platforms/api_server_runs.py`),
 * so a dropped connection is lost history and not a pause. An `interrupted` run
 * is a dead attempt. Neither ever becomes a completion: they become
 * `failed{retryable:true}` with a reason that says events are missing, and the
 * job survives in Postgres so the next wake starts a fresh attempt.
 */
import {
  APPROVAL_OUTDATED_NOTE,
  type AttemptBundle,
  type AttemptOutcome,
  BROKER_TIMEOUT_MS,
  dedupKey,
  type EventSink,
  hookCaptureErrorCode,
  hookObservation,
  type ProviderFailure,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type SteerMessage,
  type ToolSpec,
  toolSpec,
  type WaitSpec,
  waitSpec,
} from '@melete/contracts';
import { claimsContinuation, unbackedClaims } from './claims.ts';
import {
  HermesClient,
  type HermesRequest,
  hermesCapabilities,
  hermesRunAccepted,
  hermesRunEvent,
  isTerminalEvent,
  parseSse,
} from './client.ts';
import {
  DELIVER_CONTINUATION,
  quietAllowanceMs,
  SAID_DELIVER_CONTINUATION,
  stalledContinuation,
  stalledNote,
} from './liveness.ts';
import { answersAlready, onlyNarration } from './narration.ts';
import { asksWithoutProposing, UNPROPOSED_CONTINUATION } from './proposal.ts';
import { steerContinuation, steerInput } from './steer.ts';
import { RUNTIME_VERSION } from './version.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The class of a provider refusal, when the engine's failure carries the code
 * the gateway answered with (`provider_key_refused`, `provider_down`, ...).
 * The engine quotes the gateway's error, and the gateway sends only the code.
 */
export function providerFailureIn(error: string): ProviderFailure | null {
  const match =
    /\bprovider_(key_refused|quota|rate_limited|model_not_found|context_too_long|down)\b/.exec(
      error,
    );
  if (!match?.[1]) return null;
  return match[1] === 'down' ? 'provider_down' : (match[1] as ProviderFailure);
}

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
  /** The broker's catalog after a load the running agent could not take: continue in a new run. */
  loaded?: ToolSpec[];
  /** The broker's catalog after a load the running agent took: the run went on with it. */
  live?: ToolSpec[];
  outputTokens: number;
  /** Tool names this run called, in order, including calls the broker refused. */
  called?: string[];
  /** The engine sent nothing for longer than its step may take, and the run was stopped. */
  stalled?: { silentMs: number; tool?: string };
  /** The run ended with steered words it never reached a step's end to read. */
  pendingSteer?: boolean;
};

/**
 * Words the person sent while one attempt runs. `queued` waits for the next
 * run of the attempt; `sent` went to the run in progress and is delivered at
 * its next step's end; once the attempt's loop is over, `closed` refuses more.
 */
type SteerState = {
  seen: Set<string>;
  queued: SteerMessage[];
  sent: SteerMessage[];
  runId?: string;
  closed: boolean;
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
  /**
   * How long the engine may send no event while these tools are in flight
   * (keepalives do not count) before it is treated as stuck. Defaults to
   * the longest the step may take plus a margin (`liveness.ts`).
   */
  quietMs?: (open: readonly string[], catalog: readonly ToolSpec[]) => number;
  /** The clock silence is measured on, in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
};

/** Hermes writes a keepalive every 30s, so silence past 90s is a dead socket. */
const DEFAULT_STREAM_IDLE_MS = 90_000;
/** How long a stuck engine is given to take the request to stop its run. */
const STOP_WAIT_MS = 5_000;
/** How many ended attempts are remembered to refuse a late steer; far more than run at once. */
const ENDED_KEPT = 1_000;

export class HermesRuntimeAdapter implements RuntimeAdapter {
  private readonly client: HermesClient;
  private readonly fetch: FetchLike;
  private readonly options: HermesAdapterOptions;
  private readonly steers = new Map<string, SteerState>();
  /** Attempts whose loop is over, newest last, so a late steer is refused rather than queued. */
  private readonly ended = new Set<string>();

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

  private steerState(attemptId: string): SteerState {
    let state = this.steers.get(attemptId);
    if (!state) {
      state = { seen: new Set(), queued: [], sent: [], closed: false };
      this.steers.set(attemptId, state);
    }
    return state;
  }

  /**
   * Words the person sent while this attempt runs. A run in progress takes
   * them at its next step's end; between runs, or when the run will not take
   * them, they become the input of the attempt's next run. Once the attempt's
   * loop is over nothing more is taken here, and the service carries the
   * words to the next turn.
   */
  async steer(attemptId: string, message: SteerMessage): Promise<boolean> {
    if (this.ended.has(attemptId)) return false;
    const state = this.steerState(attemptId);
    if (state.closed) return false;
    if (state.seen.has(message.id)) return true;
    state.seen.add(message.id);
    const runId = state.runId;
    if (runId) {
      // A run that has ended, or will not take it, answers 409; it waits for the next run.
      const taken = await this.send(this.client.steer(runId, steerInput([message]))).then(
        (response) => response.ok,
        () => false,
      );
      // Taken by the run that is still this attempt's: read at its next step's end.
      if (taken && state.runId === runId && !state.closed) {
        state.sent.push(message);
        return true;
      }
      if (taken && state.closed) return true;
    }
    if (state.closed) return false;
    state.queued.push(message);
    return true;
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
    // renderInput already carries the recorded prior context, tool-call fields included.
    let input = this.client.renderInput(bundle);
    let catalog = bundle.tools;
    let runId: string | undefined;
    let final: AttemptOutcome = exhausted('The attempt reached its turn limit.');
    // Every tool the attempt called, across continuations, and whether it has
    // already had its one chance to propose what it asked the owner about.
    const called: string[] = [];
    let nudged = false;
    // The engine has one chance to report after it went quiet, and one to
    // speak to the person after it stopped without a word.
    const started = this.now();
    let stalled: RunResult['stalled'];
    // An earlier attempt of this turn already gave the person its answer, and
    // nothing new came in since: one that ends without words here has nothing
    // new to say, and asking it to say something would send the answer again.
    // Words that may only be a line about the next step, or a new message,
    // approval or event to answer, leave the one ask in place, told what the
    // person already has.
    const said = bundle.inputs.said_this_turn?.trim() ?? '';
    const news =
      bundle.inputs.new_user_messages.length > 0 ||
      bundle.inputs.approval_results.length > 0 ||
      bundle.inputs.trigger_events.length > 0;
    let delivered = said !== '' && !news && answersAlready(said);
    // A reply that claims a step no tool took gets one hidden chance to take
    // it or say it again without the claim. Actions the person approved in
    // this wake were carried out for it, so they back a claim as well.
    let repaired = false;
    const approvedKinds = bundle.inputs.approval_results.flatMap((entry) =>
      entry.decision === 'approved' && entry.kind ? [entry.kind] : [],
    );
    const stuck = (silentMs: number): AttemptOutcome => ({
      kind: 'completed',
      summary: stalledNote(silentMs, this.now() - started),
      evidence: [],
    });
    // The owner refused something in this wake. Telling the attempt to call the
    // tool now would be Melete's own idea to ask again for what was just
    // refused: the ledger would stop the same bytes, but a variation of them is
    // a fresh question the owner never invited. The reply is still treated as a
    // question rather than a completion.
    const refused = bundle.inputs.approval_results.some(
      (entry) => entry.decision === 'denied' && entry.note !== APPROVAL_OUTDATED_NOTE,
    );
    const stop = () => {
      if (runId) void this.send(this.client.stop(runId)).catch(() => undefined);
    };
    const steering = this.steerState(bundle.attempt.id);
    const steerDelivered = async (messages: SteerMessage[]) => {
      for (const message of messages)
        await emitter.emit({ type: 'steer_delivered', steer_id: message.id });
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
            // An engine that went quiet once gets no longer to take the next run.
            stalled ? Math.min(deadline, Date.now() + this.quiet([], catalog)) : deadline,
          ),
        );
        runId = accepted.run_id;
        if (controller.signal.aborted) stop();
        steering.runId = runId;
        let result: RunResult;
        try {
          result = await this.consume(
            runId,
            bundle,
            emitter,
            controller.signal,
            catalog,
            budget,
            async () => {
              // A step ended: whatever the run took by then was read with it.
              const read = steering.sent.splice(0);
              await steerDelivered(read);
            },
          );
        } finally {
          steering.runId = undefined;
        }
        // Taken but never read: the run ended before another step did.
        if (result.pendingSteer || result.outcome.kind !== 'completed')
          steering.queued.unshift(...steering.sent.splice(0));
        else await steerDelivered(steering.sent.splice(0));
        budget.outputTokens += result.outputTokens;
        called.push(...(result.called ?? []));
        if (result.live) catalog = result.live;
        final = result.outcome;
        if (result.stalled) {
          // Asked once to report what it has, in a fresh run of this attempt;
          // quiet again, the turn ends with a note that says so.
          if (signal.aborted || controller.signal.aborted) break;
          if (stalled) {
            final = stuck(result.stalled.silentMs);
            break;
          }
          stalled = result.stalled;
          await emitter.emit({
            type: 'stalled',
            silent_ms: Math.round(stalled.silentMs),
            ...(stalled.tool ? { tool: stalled.tool.slice(0, 200) } : {}),
          });
          input = stalledContinuation(stalled.silentMs);
          continue;
        }
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
        // A run that ended on its tool calls with nothing said to the person
        // is asked once, out of their sight, to say it now.
        // So is one that only said what it was about to do ("Let me check…").
        const wordless =
          !result.loaded &&
          final.kind === 'completed' &&
          ((!final.summary.trim() && called.length > 0) || onlyNarration(final.summary));
        if (wordless && !delivered && !signal.aborted && !controller.signal.aborted) {
          if (
            (await beforeDeadline(this.options.parkedActions(bundle, controller.signal), deadline))
              .length > 0
          )
            break;
          delivered = true;
          input = said ? SAID_DELIVER_CONTINUATION : DELIVER_CONTINUATION;
          continue;
        }
        // Words the person sent while this ran become the next run's input,
        // before anything else ends the attempt: they are answered in this turn.
        if (
          steering.queued.length > 0 &&
          !result.loaded &&
          (final.kind === 'completed' || final.kind === 'waiting_for_input') &&
          !signal.aborted &&
          !controller.signal.aborted
        ) {
          if (
            (await beforeDeadline(this.options.parkedActions(bundle, controller.signal), deadline))
              .length > 0
          )
            break;
          const taken = steering.queued.splice(0);
          input = steerContinuation(taken, final.kind === 'completed' ? final.summary : '');
          await steerDelivered(taken);
          continue;
        }
        const claims =
          !result.loaded && !repaired && final.kind === 'completed' && final.summary.trim()
            ? unbackedClaims(final.summary, [...called, ...approvedKinds])
            : [];
        if (claims.length > 0 && !signal.aborted && !controller.signal.aborted) {
          if (
            (await beforeDeadline(this.options.parkedActions(bundle, controller.signal), deadline))
              .length > 0
          )
            break;
          repaired = true;
          input = claimsContinuation(claims);
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
      // An engine that went quiet and then could not take the run asking it to
      // report is stuck: the turn ends with a note rather than starting over.
      final =
        stalled && !signal.aborted
          ? stuck(stalled.silentMs)
          : {
              kind: 'failed',
              reason: `the runtime refused the run: ${message(error)}`,
              retryable: true,
            };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', stop);
      // Nothing more is taken here; what was never read is the service's to carry.
      steering.closed = true;
      this.steers.delete(bundle.attempt.id);
      this.ended.add(bundle.attempt.id);
      if (this.ended.size > ENDED_KEPT) {
        const [oldest] = this.ended;
        if (oldest) this.ended.delete(oldest);
      }
    }
    // Either clock is enough to settle this: the timer fired, or the wall clock
    // says the deadline is behind us. Whichever notices first, the budget is
    // what ended the attempt, so a rejection the deadline caused never survives
    // as a failure.
    if ((wallExpired || Date.now() >= deadline) && !signal.aborted)
      final = exhausted('The attempt reached its wall-time limit.');
    return await this.finish(bundle, emitter, final);
  }

  /** How long the engine may send no event while these tools are in flight. */
  private quiet(open: readonly string[], catalog: readonly ToolSpec[]): number {
    return (this.options.quietMs ?? quietAllowanceMs)(open, catalog);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
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
    stepEnded: () => Promise<void> = async () => {},
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
    let live: ToolSpec[] | undefined;
    let text = '';
    const completedTools: string[] = [];
    let outputTokens = 0;
    let budgetStopped = false;
    let pendingSteer = false;
    // The stream is read as it arrives and handled as fast as each frame can be
    // recorded. Whatever arrived while the last one was being recorded is taken
    // together, so a burst of text is recorded as one piece rather than one
    // write per token, and the text reaches the person as soon as it can.
    const arrived: Uint8Array[] = [];
    let ended = false;
    let failure: unknown;
    let wake: (() => void) | undefined;
    void (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          arrived.push(chunk.value);
          wake?.();
        }
      } catch (error) {
        failure = error ?? new Error('the event stream failed');
      } finally {
        ended = true;
        wake?.();
      }
    })();

    // When the engine last sent an event (keepalives are not events), and the
    // tools it is in the middle of: together they say whether it is stuck.
    let lastEventAt = this.now();
    const open: string[] = [];
    let quiet = false;
    try {
      for (;;) {
        if (!arrived.length && !ended) {
          const idle = Math.min(
            this.options.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS,
            budget.deadline - Date.now(),
          );
          const quietLeft = lastEventAt + this.quiet(open, catalog) - this.now();
          try {
            await withTimeout(
              new Promise<void>((resolve) => {
                wake = resolve;
              }),
              Math.max(1, Math.min(idle, quietLeft)),
            );
          } catch (error) {
            // Silence past the stream's own limit is a dead socket; silence past
            // what the step may take, with the socket alive, is a stuck engine.
            if (quietLeft > idle) throw error;
            // A timer may fire a tick early, so the clock, not the timer, says
            // whether the silence has really run its length.
            if (this.now() - lastEventAt < this.quiet(open, catalog)) continue;
            quiet = true;
          }
        }
        wake = undefined;
        if (quiet) break;
        if (!arrived.length) {
          if (failure !== undefined) throw failure;
          break;
        }
        for (const value of arrived.splice(0)) buffer += decoder.decode(value, { stream: true });
        const { messages, rest } = parseSse(buffer);
        buffer = rest;
        const events = messages
          .map((sse) => safeParseEvent(sse.data))
          .filter((event): event is Record<string, unknown> => event !== null);
        if (events.length) lastEventAt = this.now();
        for (const event of coalesceDeltas(events)) {
          const mapped = await this.handle(runId, event, emitter, calls);
          if (mapped) outcome = mapped;
          if (event.event === 'message.delta') text += String(event.delta ?? '');
          if (event.event === 'tool.started') {
            budget.turns++;
            open.push(String(event.tool ?? 'unknown'));
          }
          if (event.event === 'tool.completed') {
            const at = open.lastIndexOf(String(event.tool ?? 'unknown'));
            if (at >= 0) open.splice(at, 1);
            completedTools.push(String(event.tool ?? 'unknown'));
            await stepEnded();
            if (event.tool === 'load_tool' && this.options.catalogState) {
              // Whether a tool loaded is the broker's record, never the model's
              // words. The plugin first asks the engine to add a loaded tool to
              // the running agent's list, and the run simply goes on with it.
              // A load it could not add comes back marked as an error (the
              // plugin's continues_in_a_new_run), and only then is the run
              // ended and continued in a fresh one that is built with the tool.
              // A refused load adds nothing to the broker's catalog either way.
              const current = await beforeDeadline(
                this.options.catalogState(bundle, signal),
                budget.deadline,
              );
              const known = live ?? catalog;
              if (current.some((tool) => !known.some((old) => old.name === tool.name))) {
                if (event.error === true) {
                  loaded = current;
                  // Stop explicitly; the model need not obey a textual instruction.
                  // Drain to a terminal frame before another run may execute.
                  await beforeDeadline(this.send(this.client.stop(runId)), budget.deadline);
                } else live = current;
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
            if (event.pending_steer) pendingSteer = true;
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
        // Keepalives alone keep the socket open, not the work going.
        if (this.now() - lastEventAt >= this.quiet(open, catalog)) {
          quiet = true;
          break;
        }
      }
      if (quiet && !signal.aborted) {
        // The run is stopped so nothing it was doing carries on unseen. A stuck
        // engine may not answer that either, so it is not waited on for long.
        await withTimeout(this.send(this.client.stop(runId)), STOP_WAIT_MS).catch(() => undefined);
        return {
          outcome: gap('the engine stopped answering'),
          outputTokens: Math.ceil(text.length / 4),
          called: completedTools,
          stalled: {
            silentMs: this.now() - lastEventAt,
            ...(open.length ? { tool: open[open.length - 1] } : {}),
          },
        };
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
        ...(live ? { live } : {}),
        ...(pendingSteer ? { pendingSteer } : {}),
        outputTokens,
        called: completedTools,
      };
    // The socket closed without a terminal frame. The engine may have finished;
    // there is no way to tell from here, and guessing would invent a result.
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

    if (name === 'reasoning.delta') {
      const delta = String(event.delta ?? '');
      if (delta) await emitter.emit({ type: 'reasoning_delta', text: delta });
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
          summary: plainEngineNotice(String(event.output ?? '').trim()),
          // Evidence is the broker's to name. The engine knows nothing about
          // action ids, so claiming any here would be fabrication.
          evidence: [],
        };
      }
      if (name === 'run.failed') {
        const reason = String(event.error ?? 'the runtime reported a failure');
        const failure = providerFailureIn(reason);
        return {
          kind: 'failed',
          reason,
          // A refused key, a spent account or a missing model fails the same
          // way next time; a busy or failing provider may answer later.
          retryable: !failure || failure === 'rate_limited' || failure === 'provider_down',
          ...(failure ? { failure } : {}),
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

/**
 * Consecutive text frames taken as one, and consecutive reasoning frames as
 * one; every other frame keeps its place, so nothing is reordered around a
 * tool call or the end of the run.
 */
export function coalesceDeltas(frames: Record<string, unknown>[]): Record<string, unknown>[] {
  const merged: Record<string, unknown>[] = [];
  for (const frame of frames) {
    const last = merged.at(-1);
    if (
      last &&
      last.event === frame.event &&
      (frame.event === 'message.delta' || frame.event === 'reasoning.delta')
    )
      merged[merged.length - 1] = {
        ...last,
        delta: String(last.delta ?? '') + String(frame.delta ?? ''),
      };
    else merged.push(frame);
  }
  return merged;
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

const MODELS_HINT = 'choose another model in Settings › Models';
const LIMIT_HINT =
  'Whoever runs this Melete server can raise the reply limit with MELETE_DEFAULT_MAX_OUTPUT_TOKENS';

/**
 * The engine's own notices for a reply that hit the model's output limit, each
 * matched by how it starts, and what is said in their place. The engine's
 * wording points at its own slash commands (`/reasoning`, `/model`), which do
 * not exist here, so a person would be sent looking for something that is not
 * there.
 */
const ENGINE_NOTICES: { starts: string[]; say: string }[] = [
  {
    starts: ['⚠️ **Thinking Budget Exhausted**', '⚠️ **No visible answer was produced.**'],
    say:
      'The model spent its whole reply allowance thinking and had nothing left for an answer. ' +
      `Try asking for a smaller piece at a time, or ${MODELS_HINT}. ` +
      `${LIMIT_HINT}, or lower the thinking effort with MELETE_REASONING_EFFORT_AGENT.`,
  },
  {
    starts: [
      'Response truncated due to output length limit',
      'First response truncated due to output length limit',
    ],
    say:
      'The model reached its reply length limit before it finished, so this reply was stopped. ' +
      `Try asking for a shorter answer or one part at a time, or ${MODELS_HINT}. ` +
      `${LIMIT_HINT}.`,
  },
  {
    starts: ['⚠️ **Response Stopped — Repetition Detected**'],
    say:
      'The model started repeating itself, so its reply was stopped before it ran on. ' +
      `Send your message again, or ${MODELS_HINT}.`,
  },
];

/** An answer as the person should read it, with the engine's limit notices put in Melete's terms. */
export function plainEngineNotice(output: string): string {
  const notice = ENGINE_NOTICES.find((entry) =>
    entry.starts.some((start) => output.startsWith(start)),
  );
  return notice ? notice.say : output;
}

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
