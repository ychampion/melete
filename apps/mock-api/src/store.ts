/**
 * The mock's whole world, in memory.
 *
 * It is a fake service, not a fake contract: every row it holds is shaped by a
 * schema from @melete/contracts, every job moves through the real `transition`
 * function, and the event log is append-only with a monotonic `seq`, because
 * that is what `Last-Event-ID` resumption is built on.
 */
import {
  type Action,
  type ApiEvent,
  type Approval,
  type Artifact,
  type Attempt,
  type Connection,
  type ConnectionView,
  type EventType,
  ID_PREFIXES,
  type Job,
  type JobState,
  type KnowledgeFrontmatter,
  type SkillFrontmatter,
  type Space,
  type TransitionInput,
  transition,
} from '@melete/contracts';
import { ulid } from 'ulid';

export const newId = (prefix: string): string => `${prefix}_${ulid()}`;

export type KnowledgeEntry = {
  id: string;
  space_id: string;
  path: string;
  frontmatter: KnowledgeFrontmatter;
  body: string;
};

export type SkillEntry = {
  id: string;
  space_id: string | null;
  path: string;
  enabled: boolean;
  frontmatter: SkillFrontmatter;
};

export type EventInput = {
  type: EventType;
  job_id?: string | null;
  attempt_id?: string | null;
  payload?: Record<string, unknown>;
};

export type Subscriber = (event: ApiEvent) => void;

/** Thrown when a caller asks for something the state machine refuses. */
export class MockConflict extends Error {
  readonly code: string;
  readonly detail: Record<string, unknown> | undefined;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'MockConflict';
    this.code = code;
    this.detail = detail;
  }
}

export class Store {
  readonly spaces = new Map<string, Space>();
  readonly connections = new Map<string, Connection>();
  readonly jobs = new Map<string, Job>();
  readonly attempts = new Map<string, Attempt>();
  readonly actions = new Map<string, Action>();
  readonly approvals = new Map<string, Approval>();
  readonly artifacts = new Map<string, { artifact: Artifact; bytes: Uint8Array }>();
  readonly knowledge = new Map<string, KnowledgeEntry>();
  readonly skills = new Map<string, SkillEntry>();
  readonly proposals = new Map<string, { path: string; diff: string }>();

  private readonly events: ApiEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private seq = 0;
  private localSeq = 0;

  /** Injected so tests can run a whole scenario at a fixed instant. */
  now: () => Date = () => new Date();

  private stamp(): string {
    return this.now().toISOString();
  }

  // ------------------------------------------------------------------
  // events
  // ------------------------------------------------------------------

  append(input: EventInput): ApiEvent {
    this.seq += 1;
    this.localSeq += 1;
    const event: ApiEvent = {
      seq: this.seq,
      job_id: input.job_id ?? null,
      attempt_id: input.attempt_id ?? null,
      type: input.type,
      payload: (input.payload ?? {}) as ApiEvent['payload'],
      dedup_key: `${input.attempt_id ?? 'service'}:${this.localSeq}`,
      created_at: this.stamp(),
    };
    this.events.push(event);
    for (const subscriber of this.subscribers) subscriber(event);
    return event;
  }

  /** Replay from the cursor. This is what both `after` and `Last-Event-ID` mean. */
  eventsAfter(
    after: number,
    options: { jobId?: string; types?: EventType[]; limit?: number } = {},
  ) {
    const limit = options.limit ?? 200;
    const matching = this.events.filter(
      (event) =>
        event.seq > after &&
        (!options.jobId || event.job_id === options.jobId) &&
        (!options.types?.length || options.types.includes(event.type)),
    );
    return { events: matching.slice(0, limit), total: matching.length };
  }

  get lastSeq(): number {
    return this.seq;
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  // ------------------------------------------------------------------
  // jobs
  // ------------------------------------------------------------------

  /**
   * The only way a job changes state. The decision is the contract's pure
   * function; the mock only records the answer and says so on the event stream.
   */
  move(jobId: string, input: TransitionInput, patch: Partial<Job> = {}): Job {
    const job = this.requireJob(jobId);
    const result = transition(job.state, input);
    if (!result.ok) {
      throw new MockConflict(result.error.code, result.error.message, {
        from: result.error.from,
        input: result.error.input,
      });
    }
    const from: JobState = job.state;
    const next: Job = {
      ...job,
      ...patch,
      state: result.value,
      state_version: job.state_version + 1,
      updated_at: this.stamp(),
    };
    this.jobs.set(jobId, next);
    if (from !== next.state) {
      this.append({
        type: 'job_state_changed',
        job_id: jobId,
        payload: { from, to: next.state, input: input.kind },
      });
    }
    return next;
  }

  patchJob(jobId: string, patch: Partial<Job>): Job {
    const next: Job = { ...this.requireJob(jobId), ...patch, updated_at: this.stamp() };
    this.jobs.set(jobId, next);
    return next;
  }

  requireJob(jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new MockConflict('not_found', `no job ${jobId}`);
    return job;
  }

  requireAction(actionId: string): Action {
    const action = this.actions.get(actionId);
    if (!action) throw new MockConflict('not_found', `no action ${actionId}`);
    return action;
  }

  requireApproval(approvalId: string): Approval {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new MockConflict('not_found', `no approval ${approvalId}`);
    return approval;
  }

  patchAction(actionId: string, patch: Partial<Action>): Action {
    const next: Action = { ...this.requireAction(actionId), ...patch };
    this.actions.set(actionId, next);
    this.append({
      type: 'action_status_changed',
      job_id: next.job_id,
      attempt_id: next.attempt_id,
      payload: { action_id: next.id, status: next.status, kind: next.kind },
    });
    return next;
  }

  patchAttempt(attemptId: string, patch: Partial<Attempt>): Attempt {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new MockConflict('not_found', `no attempt ${attemptId}`);
    const next: Attempt = { ...attempt, ...patch };
    this.attempts.set(attemptId, next);
    return next;
  }

  /** Connections leave the service without their secret pointer. Always. */
  view(connection: Connection): ConnectionView {
    const { secret_ref: _secret, ...rest } = connection;
    return rest;
  }

  listConnections(): ConnectionView[] {
    return [...this.connections.values()].map((connection) => this.view(connection));
  }
}

export const PREFIXES = ID_PREFIXES;
