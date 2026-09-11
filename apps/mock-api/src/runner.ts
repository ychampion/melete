/**
 * Plays a scenario against a job.
 *
 * The runner is the only thing in the mock that resembles a runtime, and it is
 * deliberately powerless: it proposes effects and reports outcomes, and every
 * state change goes through `Store.move`, which calls the contract's
 * `transition`. If a scenario asked for something the state machine refuses,
 * the mock throws rather than writing the state the script wanted.
 */
import { type Attempt, canonicalizePayload, ID_PREFIXES } from '@melete/contracts';
import { labelIndex, type Scenario } from './scenario.ts';
import { MockConflict, newId, type Store } from './store.ts';

export type GateSignal =
  | { kind: 'approval'; decision: 'approved' | 'denied' }
  | { kind: 'input'; text: string }
  | { kind: 'reconciled' }
  | { kind: 'cancelled' };

export type RunnerOptions = {
  /** Injected so a test can play a whole scenario without waiting for it. */
  sleep?: (ms: number) => Promise<void>;
  /** Multiplies every scripted delay. The dev server runs at 1. */
  speed?: number;
  onError?: (jobId: string, error: unknown) => void;
};

type RunState = {
  script: Scenario;
  labels: Map<string, number>;
  position: number;
  attemptId: string | null;
  /** action ids by the label the scenario gave them. */
  refs: Map<string, string>;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class Runner {
  private readonly runs = new Map<string, RunState>();
  private readonly gates = new Map<string, (signal: GateSignal) => void>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly speed: number;
  private readonly onError: (jobId: string, error: unknown) => void;
  /** Drives that have started and not yet finished, parked ones included. */
  private active = 0;

  constructor(
    private readonly store: Store,
    options: RunnerOptions = {},
  ) {
    this.sleep = options.sleep ?? defaultSleep;
    this.speed = options.speed ?? 1;
    this.onError =
      options.onError ??
      ((jobId, error) => {
        process.stderr.write(`mock runner: job ${jobId} stopped: ${String(error)}\n`);
      });
  }

  /** Attach a scenario to a job and start playing it. */
  begin(jobId: string, script: Scenario): void {
    this.runs.set(jobId, {
      script,
      labels: labelIndex(script),
      position: 0,
      attemptId: null,
      refs: new Map(),
    });
    this.spawn(jobId);
  }

  scriptFor(jobId: string): Scenario | null {
    return this.runs.get(jobId)?.script ?? null;
  }

  /** Wake a parked job. Returns false when nothing was waiting. */
  signal(jobId: string, signal: GateSignal): boolean {
    const gate = this.gates.get(jobId);
    if (!gate) return false;
    this.gates.delete(jobId);
    gate(signal);
    return true;
  }

  /**
   * Resolves when every scenario has either finished or parked on a decision.
   * A parked drive never settles on its own, so waiting on its promise would
   * hang; what a test wants is "nothing is moving any more".
   */
  async settle(ticks = 5000): Promise<void> {
    for (let tick = 0; tick < ticks; tick += 1) {
      if (this.active === this.gates.size) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('the mock runner never went quiet');
  }

  private spawn(jobId: string): void {
    this.active += 1;
    void this.drive(jobId)
      .catch((error) => {
        this.onError(jobId, error);
      })
      .finally(() => {
        this.active -= 1;
      });
  }

  private park(jobId: string): Promise<GateSignal> {
    return new Promise((resolve) => {
      this.gates.set(jobId, resolve);
    });
  }

  private async pause(ms: number): Promise<void> {
    await this.sleep(Math.round(ms * this.speed));
  }

  private startAttempt(jobId: string, run: RunState): Attempt {
    const job = this.store.move(jobId, { kind: 'attempt_started' }, { wait: { kind: 'none' } });
    const attempt: Attempt = {
      id: newId(ID_PREFIXES.attempt),
      job_id: jobId,
      epoch: job.lease_epoch,
      runtime_version: run.script.runtime_version,
      provider: run.script.provider,
      model: run.script.model,
      model_actual: run.script.model,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        requests: 0,
        usd_est: 0,
      },
      started_at: this.store.now().toISOString(),
      ended_at: null,
      outcome: null,
      outcome_detail: null,
      context_snapshot_ref: null,
    };
    this.store.attempts.set(attempt.id, attempt);
    this.store.patchJob(jobId, { lease_epoch: job.lease_epoch + 1 });
    run.attemptId = attempt.id;
    this.store.append({
      type: 'attempt_started',
      job_id: jobId,
      attempt_id: attempt.id,
      payload: {
        provider: attempt.provider,
        model: attempt.model,
        runtime_version: attempt.runtime_version,
        epoch: attempt.epoch,
      },
    });
    return attempt;
  }

  private endAttempt(run: RunState, outcome: Attempt['outcome'], detail: Record<string, unknown>) {
    const attemptId = run.attemptId;
    if (!attemptId) return;
    const attempt = this.store.patchAttempt(attemptId, {
      ended_at: this.store.now().toISOString(),
      outcome,
      outcome_detail: detail as Attempt['outcome_detail'],
      usage: {
        input_tokens: 1800,
        output_tokens: 240,
        cached_input_tokens: 1200,
        requests: 3,
        usd_est: 0.012,
      },
    });
    this.store.append({
      type: 'attempt_ended',
      job_id: attempt.job_id,
      attempt_id: attempt.id,
      payload: { outcome, ...detail },
    });
    run.attemptId = null;
  }

  private jobActions(jobId: string) {
    return [...this.store.actions.values()].filter((action) => action.job_id === jobId);
  }

  /** What the state machine needs to know before it lets a job say "done". */
  private completionFacts(jobId: string) {
    const job = this.store.requireJob(jobId);
    const actions = this.jobActions(jobId);
    const terminal = new Set(['succeeded', 'failed', 'denied']);
    const deliverable = job.constraints.deliverable;
    const satisfied =
      deliverable.kind === 'none' ||
      deliverable.kind === 'answer' ||
      (deliverable.kind === 'message_sent' &&
        actions.some(
          (action) =>
            action.connection_id === deliverable.connection_id && action.status === 'succeeded',
        )) ||
      deliverable.kind === 'artifact';
    return {
      all_actions_terminal: actions.every((action) => terminal.has(action.status)),
      has_unknown_action: actions.some(
        (action) => action.status === 'unknown' || action.status === 'unresolved',
      ),
      deliverable_declared: deliverable.kind !== 'none',
      deliverable_satisfied: satisfied,
    };
  }

  private cancelled(jobId: string): boolean {
    return this.store.requireJob(jobId).state === 'cancelled';
  }

  // ------------------------------------------------------------------
  // the loop
  // ------------------------------------------------------------------

  private async drive(jobId: string): Promise<void> {
    const run = this.runs.get(jobId);
    if (!run) return;

    while (run.position < run.script.steps.length) {
      if (this.cancelled(jobId)) return;
      if (!run.attemptId) this.startAttempt(jobId, run);

      const step = run.script.steps[run.position];
      if (!step) return;
      run.position += 1;

      await this.pause(step.delay_ms);
      if (this.cancelled(jobId)) return;

      const parked = await this.perform(jobId, run, step);
      if (parked === 'stop') return;
    }

    // A script that runs out without completing leaves the job waiting rather
    // than claiming a result nobody produced.
    if (!this.cancelled(jobId) && run.attemptId) {
      this.endAttempt(run, 'waiting_for_input', { reason: 'the scenario ended' });
      this.store.move(
        jobId,
        { kind: 'attempt_waiting_for_input' },
        { wait: { kind: 'user_input', question: 'The scenario ended. What next?' } },
      );
    }
  }

  private async perform(
    jobId: string,
    run: RunState,
    step: Scenario['steps'][number],
  ): Promise<'continue' | 'stop'> {
    const attemptId = run.attemptId;

    switch (step.step) {
      case 'text': {
        this.store.append({
          type: 'text_delta',
          job_id: jobId,
          attempt_id: attemptId,
          payload: { text: step.text },
        });
        return 'continue';
      }

      case 'tool': {
        this.store.append({
          type: 'tool_call_proposed',
          job_id: jobId,
          attempt_id: attemptId,
          payload: { name: step.name, arguments: step.arguments },
        });
        await this.pause(120);
        this.store.append({
          type: 'tool_result',
          job_id: jobId,
          attempt_id: attemptId,
          payload: { name: step.name, result: step.result },
        });
        return 'continue';
      }

      case 'propose': {
        this.propose(jobId, run, step);
        return 'continue';
      }

      case 'await_approval':
        return this.awaitApproval(jobId, run, step);

      case 'await_input': {
        this.endAttempt(run, 'waiting_for_input', { question: step.question });
        this.store.move(
          jobId,
          { kind: 'attempt_waiting_for_input' },
          { wait: { kind: 'user_input', question: step.question } },
        );
        // The route that accepted the answer has already moved the job to
        // queued; waking here must not try to move it a second time.
        const signal = await this.park(jobId);
        if (signal.kind === 'cancelled') return 'stop';
        return 'continue';
      }

      case 'dispatch': {
        this.dispatch(jobId, run, step);
        return 'continue';
      }

      case 'notice': {
        this.store.append({
          type: 'notice',
          job_id: jobId,
          attempt_id: attemptId,
          payload: { level: step.level, title: step.title, body: step.body },
        });
        return 'continue';
      }

      case 'complete':
        return this.complete(jobId, run, step);

      case 'fail': {
        this.endAttempt(run, 'failed', { reason: step.reason });
        this.store.move(jobId, {
          kind: 'attempt_failed',
          retryable: step.retryable,
          attempts_remaining: 0,
        });
        return 'stop';
      }

      default:
        return 'continue';
    }
  }

  private propose(
    jobId: string,
    run: RunState,
    step: Extract<Scenario['steps'][number], { step: 'propose' }>,
  ): void {
    const job = this.store.requireJob(jobId);
    const attemptId = run.attemptId;
    if (!attemptId) throw new MockConflict('no_attempt', 'propose outside an attempt');

    const connection = [...this.store.connections.values()].find(
      (candidate) => candidate.label === step.connection || candidate.id === step.connection,
    );
    if (!connection) {
      throw new MockConflict('unknown_connection', `no connection named ${step.connection}`);
    }

    const { canonical, hash } = canonicalizePayload(step.payload);
    const needsApproval = step.effect_class === 'write_external' || step.effect_class === 'spend';
    const actionId = newId(ID_PREFIXES.action);
    const now = this.store.now().toISOString();

    this.store.actions.set(actionId, {
      id: actionId,
      job_id: jobId,
      attempt_id: attemptId,
      connection_id: connection.id,
      kind: step.kind,
      effect_class: step.effect_class,
      canonical_payload: canonical,
      payload_hash: hash,
      status: needsApproval ? 'needs_approval' : 'admitted',
      authorization_ref: null,
      budget_reservation: null,
      idempotency_key: actionId,
      dispatched_at: null,
      receipt: null,
      resolved_at: null,
      reconciliation: null,
      created_at: now,
    });
    run.refs.set(step.ref, actionId);

    this.store.append({
      type: 'action_requested',
      job_id: jobId,
      attempt_id: attemptId,
      payload: {
        action_id: actionId,
        kind: step.kind,
        effect_class: step.effect_class,
        payload_hash: hash,
        requires_approval: needsApproval,
      },
    });

    if (!needsApproval) return;

    const approvalId = newId(ID_PREFIXES.approval);
    this.store.approvals.set(approvalId, {
      id: approvalId,
      action_id: actionId,
      job_revision: job.revision,
      payload_hash: hash,
      requested_at: now,
      decided_at: null,
      decision: null,
      decided_by: null,
      expires_at: null,
    });
    this.store.append({
      type: 'approval_requested',
      job_id: jobId,
      attempt_id: attemptId,
      payload: { approval_id: approvalId, action_id: actionId, payload_hash: hash },
    });
  }

  private async awaitApproval(
    jobId: string,
    run: RunState,
    step: Extract<Scenario['steps'][number], { step: 'await_approval' }>,
  ): Promise<'continue' | 'stop'> {
    const actionId = run.refs.get(step.ref);
    if (!actionId) throw new MockConflict('unknown_ref', `no action proposed as ${step.ref}`);

    this.endAttempt(run, 'waiting_for_approval', { action_id: actionId });
    this.store.move(
      jobId,
      { kind: 'attempt_waiting_for_approval' },
      { wait: { kind: 'approval', action_ids: [actionId] } },
    );

    // The approval route records the decision and moves the job back to queued,
    // so the runner only has to decide which step comes next.
    const signal = await this.park(jobId);
    if (signal.kind === 'cancelled') return 'stop';
    if (signal.kind !== 'approval') return 'continue';

    if (signal.decision === 'denied') {
      if (step.on_denied) {
        const target = run.labels.get(step.on_denied);
        if (target === undefined) {
          throw new MockConflict('unknown_label', `no step labelled ${step.on_denied}`);
        }
        run.position = target;
      }
      return 'continue';
    }
    return 'continue';
  }

  private dispatch(
    jobId: string,
    run: RunState,
    step: Extract<Scenario['steps'][number], { step: 'dispatch' }>,
  ): void {
    const actionId = run.refs.get(step.ref);
    if (!actionId) throw new MockConflict('unknown_ref', `no action proposed as ${step.ref}`);
    const action = this.store.requireAction(actionId);
    if (action.status === 'denied') return;

    const now = this.store.now().toISOString();
    this.store.patchAction(actionId, { status: 'dispatched', dispatched_at: now });

    if (step.outcome === 'succeeded') {
      this.store.patchAction(actionId, {
        status: 'succeeded',
        resolved_at: now,
        receipt: {
          action_id: actionId,
          connection_id: action.connection_id,
          external_ref: step.external_ref,
          detail: step.detail as Record<string, never>,
          received_at: now,
          late: false,
        },
      });
      return;
    }

    if (step.outcome === 'failed') {
      this.store.patchAction(actionId, {
        status: 'failed',
        resolved_at: now,
        reconciliation: { reason: step.reason },
      });
      return;
    }

    // The dispatch left the process and the answer never came back. Nothing is
    // resent; the action rests at unknown until verify or a person decides.
    this.store.patchAction(actionId, {
      status: 'unknown',
      reconciliation: { reason: step.reason || 'the connector did not answer' },
    });
    this.store.append({
      type: 'notice',
      job_id: jobId,
      attempt_id: run.attemptId,
      payload: {
        level: 'problem',
        title: 'One action came back unknown',
        body: step.reason || 'The connector did not answer. Nothing was sent a second time.',
      },
    });
  }

  private async complete(
    jobId: string,
    run: RunState,
    step: Extract<Scenario['steps'][number], { step: 'complete' }>,
  ): Promise<'continue' | 'stop'> {
    const facts = this.completionFacts(jobId);
    this.endAttempt(run, 'completed', { answer: step.answer });
    const job = this.store.move(
      jobId,
      { kind: 'attempt_completed', ...facts },
      { wait: { kind: 'none' } },
    );

    if (job.state === 'completed') {
      if (step.answer) {
        this.store.append({
          type: 'notice',
          job_id: jobId,
          payload: { level: 'info', title: 'Done', body: step.answer },
        });
      }
      return 'stop';
    }

    // An unresolved external effect outranks a happy summary: the job waits for
    // a person to say what really happened, and `/actions/:id/resolve` wakes it.
    if (job.state === 'needs_reconciliation') {
      const signal = await this.park(jobId);
      return signal.kind === 'cancelled' ? 'stop' : 'continue';
    }

    if (job.state === 'waiting_for_input') {
      this.store.patchJob(jobId, {
        wait: { kind: 'user_input', question: 'I have no evidence the deliverable exists.' },
      });
      const signal = await this.park(jobId);
      return signal.kind === 'cancelled' ? 'stop' : 'continue';
    }

    return 'continue';
  }
}
