import { browserControlResponse, type HandOff, type HandOffReason } from '@melete/contracts';
import type { Hono } from 'hono';
import type { Sql } from 'postgres';
import { ServiceError } from '../../api/errors.ts';
import { appendEvent } from '../../broker/records.ts';
import type { ConnectorContext } from '../../connectors/types.ts';
import { lockEventOrderIn } from '../../db/transaction.ts';
import { recordPathOutcome, taskKindOf } from '../../paths/registry.ts';
import type { BrowserWorkerClient } from './client.ts';
import { BrowserLiveService, type BrowserLiveServiceOptions } from './live-service.ts';
import {
  BrowserFault,
  type BrowserPolicy,
  type BrowserRegion,
  type BrowserSession,
  browserRegion,
} from './sessions.ts';
import { BrowserSiteService } from './sites.ts';

export type BrowserWorkers = {
  get(spaceId: string): Promise<BrowserWorkerClient>;
  /** Where one directory per space lives, and how one space's worker stops: see forgetSpace. */
  readonly spacesRoot?: string;
  release?(spaceId: string): Promise<void>;
};
type Binding = Pick<BrowserSession, 'id' | 'space_id' | 'job_id' | 'control_epoch' | 'control'>;
export const browserInputReasons = new Set([
  'stale_control_epoch',
  'human_control',
  'fresh_observation_required',
  'sensitive_input_require_takeover',
]);

/** The database maps a worker session to service-owned authority; tool arguments cannot rebind it. */
export class BrowserSessionService {
  onPark?: (jobId: string, attemptIds: string[]) => void;
  /**
   * Called once a person hands back a browser they were handed: the work it
   * was handed over from settles what it can by reading the page, then goes on.
   */
  onHandedBack?: (scope: { space_id: string; job_id: string }, sessionId: string) => Promise<void>;
  /** The live views of these sessions, in memory for as long as the process runs. */
  readonly live: BrowserLiveService;
  /** The sites these sessions have signed in to, recorded over the space's one profile. */
  readonly sites: BrowserSiteService;
  /** How long a lease waits for another job's browser to come free, and how often it looks. */
  private readonly busyWaitMs: number;
  private readonly busyPollMs: number;
  constructor(
    readonly sql: Sql,
    readonly workers: BrowserWorkers,
    options: { live?: BrowserLiveServiceOptions; busyWaitMs?: number; busyPollMs?: number } = {},
  ) {
    this.live = new BrowserLiveService(this, options.live);
    this.sites = new BrowserSiteService(sql, workers);
    this.busyWaitMs = options.busyWaitMs ?? 20_000;
    this.busyPollMs = options.busyPollMs ?? 500;
  }

  async record(session: BrowserSession, scope: { space_id: string; job_id: string }) {
    if (session.space_id !== scope.space_id || session.job_id !== scope.job_id)
      throw new BrowserFault('session_scope_mismatch');
    await this
      .sql`insert into browser_session_binding (id, space_id, job_id, control_epoch, control)
      values (${session.id}, ${scope.space_id}, ${scope.job_id}, ${session.control_epoch}, ${session.control})
      on conflict (id) do update set control_epoch = excluded.control_epoch,
        control = excluded.control, updated_at = now()
      where browser_session_binding.space_id = excluded.space_id
        and browser_session_binding.job_id = excluded.job_id
        and browser_session_binding.control_epoch <= excluded.control_epoch`;
  }

  /**
   * The job's browser session, opened on first use. `publicWeb` says the job may open any public
   * page, decided by the caller from the same public-read setting web reads follow; it applies
   * only to a job with no domain list of its own.
   *
   * A space has one browser. A session held by a job that has finished is taken over, its pages
   * closed; one held by work still going is waited for briefly, and then refused in plain words.
   */
  async lease(ctx: ConnectorContext, sessionId?: string, options: { publicWeb?: boolean } = {}) {
    if (sessionId) await this.authorize(sessionId, ctx);
    const worker = await this.workers.get(ctx.space_id);
    const policy: BrowserPolicy = {
      public_compartment: ctx.constraints.public_compartment,
      allowed_domains: [...ctx.constraints.allowed_domains],
      // Sent only when it applies, so the policy a list or a compartment gives is unchanged.
      ...(options.publicWeb &&
      !ctx.constraints.public_compartment &&
      !ctx.constraints.allowed_domains.length
        ? { public_web: true }
        : {}),
    };
    const region = await this.region(ctx.space_id);
    const deadline = Date.now() + this.busyWaitMs;
    let replace: string | undefined;
    let session: BrowserSession;
    for (;;) {
      try {
        session = await worker.lease(ctx.job_id, policy, region, replace);
        break;
      } catch (error) {
        if (!(error instanceof BrowserFault && error.reason === 'session_busy')) throw error;
        // A named session belongs to this job; another job's browser is never it.
        if (sessionId) throw new BrowserFault('session_not_found');
        const late = Date.now() >= deadline || ctx.signal?.aborted === true;
        const holder = await worker.holder();
        if (!holder && !late) {
          replace = undefined;
          continue;
        }
        if (
          holder?.control === 'automation' &&
          holder.job_id &&
          holder.job_id !== ctx.job_id &&
          replace !== holder.job_id &&
          (await this.finished(ctx.space_id, holder.job_id))
        ) {
          replace = holder.job_id;
          continue;
        }
        if (late)
          throw new BrowserFault(holder?.control === 'human' ? BROWSER_WITH_PERSON : BROWSER_BUSY);
        replace = undefined;
        await Bun.sleep(this.busyPollMs);
      }
    }
    if (sessionId && session.id !== sessionId) throw new BrowserFault('session_not_found');
    // A session with no binding yet was started by this lease, for this job.
    const [known] = await this.sql`select 1 from browser_session_binding where id = ${session.id}`;
    await this.record(session, ctx);
    return { session, worker, opened: !known };
  }

  /**
   * Whether a job is done with the browser, so another job may take it: the job is gone or has
   * ended, or nothing of it is running and it waits on nothing the browser holds (a person
   * handed the page, a browser step awaiting approval or a check of what one did).
   */
  private async finished(spaceId: string, jobId: string): Promise<boolean> {
    const [job] = await this.sql<
      { state: string; wait: { question?: unknown; handoff?: unknown } | null; busy: boolean }[]
    >`select j.state, j.wait,
        exists (select 1 from attempt a where a.job_id = j.id and a.ended_at is null)
        or exists (select 1 from action x where x.job_id = j.id and x.kind like 'browser.%'
          and x.status in ('proposed', 'needs_approval', 'approved', 'admitted', 'dispatched',
            'unknown')) as busy
      from job j where j.id = ${jobId} and j.space_id = ${spaceId}`;
    if (!job || ['completed', 'failed', 'cancelled'].includes(job.state)) return true;
    if (job.busy || ['queued', 'running'].includes(job.state)) return false;
    const question = typeof job.wait?.question === 'string' ? job.wait.question : '';
    return !job.wait?.handoff && !question.startsWith('Browser control:');
  }

  /**
   * After an attempt has ended, however it ended: a job that was stopped or failed, or long
   * work that finished, closes its browser and its pages. A conversation that finished a turn
   * keeps them for its next message, and other work may take the browser over meanwhile.
   */
  async afterAttempt(attemptId: string): Promise<void> {
    const [row] = await this.sql<{ job_id: string; space_id: string; ended: boolean }[]>`
      select j.id as job_id, j.space_id,
        j.state in ('failed', 'cancelled')
        or (j.state = 'completed' and j.kind <> 'chat')
        or (j.kind = 'chat' and exists (select 1 from experience_turn t
          where t.id = j.current_turn_id and t.status = 'stopped')) as ended
      from attempt a join job j on j.id = a.job_id
      where a.id = ${attemptId}
        and exists (select 1 from browser_session_binding b
          where b.job_id = j.id and b.space_id = j.space_id)`;
    if (!row?.ended) return;
    const worker = await this.workers.get(row.space_id);
    await worker.end(row.job_id);
  }

  /**
   * The person's place for their browser: the time zone from their profile. The profile keeps
   * no language or region, so pages are asked for US English; a site that prices by the
   * network address it sees can still pick another currency.
   */
  async region(spaceId: string): Promise<BrowserRegion> {
    const [profile] = await this.sql<{ time_zone: string }[]>`select time_zone
      from experience_profile where space_id = ${spaceId}`;
    return browserRegion({ timezone_id: profile?.time_zone });
  }

  async authorize(
    sessionId: string,
    scope?: { space_id: string; job_id: string },
  ): Promise<Binding> {
    const [binding] = await this.sql<
      Binding[]
    >`select b.id, b.space_id, b.job_id, b.control_epoch, b.control
      from browser_session_binding b join job j on j.id = b.job_id and j.space_id = b.space_id
      join space s on s.id = b.space_id where b.id = ${sessionId}`;
    if (
      !binding ||
      (scope && (binding.space_id !== scope.space_id || binding.job_id !== scope.job_id))
    )
      throw new BrowserFault('session_not_found');
    return binding;
  }

  /** The epoch is fenced durably before any replacement runtime can start. No model decision is involved. */
  async park(
    scope: { space_id: string; job_id: string },
    sessionId: string,
    reason: string,
    expectedAttemptId?: string,
  ) {
    await this.authorize(sessionId, scope);
    const fenced = await this.sql.begin(async (tx) => {
      // Before the job lock, as every event writer does: event order is commit order.
      await lockEventOrderIn(tx);
      const [job] =
        await tx`select id, space_id, state, lease_epoch, wait from job where id = ${scope.job_id} for update`;
      if (
        !job ||
        job.space_id !== scope.space_id ||
        ['completed', 'cancelled', 'failed'].includes(job.state)
      )
        return [];
      if (expectedAttemptId) {
        const [execution] =
          await tx`select epoch, ended_at from attempt where id = ${expectedAttemptId} and job_id = ${scope.job_id}`;
        if (!execution || execution.epoch !== job.lease_epoch || execution.ended_at) return [];
      }
      if (job.state === 'waiting_for_input' && job.wait?.question?.startsWith('Browser control:'))
        return [];
      // Work handed to the person keeps its card while they take the browser:
      // it says what is left, and handing back is what carries the work on.
      if (
        job.state === 'waiting_for_input' &&
        job.wait?.handoff?.take_over?.session_id === sessionId
      )
        return [];
      const state =
        job.state === 'needs_reconciliation' ? 'needs_reconciliation' : 'waiting_for_input';
      const wait =
        state === 'needs_reconciliation'
          ? job.wait
          : {
              kind: 'user_input',
              question: `Browser control: ${reason}. Return control, then request a fresh observation before continuing.`,
            };
      await tx`update job set state = ${state}, wait = ${JSON.stringify(wait)}::jsonb,
        lease_epoch = lease_epoch + 1, state_version = state_version + 1,
        next_wake_at = null, updated_at = now() where id = ${scope.job_id}`;
      const attempts = await tx`update attempt set outcome = 'fenced',
        outcome_detail = ${JSON.stringify({ kind: 'browser_control', session_id: sessionId, reason })}::jsonb,
        ended_at = now(), lease_expires_at = null, lease_status = 'ended'
        where job_id = ${scope.job_id} and ended_at is null returning id`;
      for (const attempt of attempts)
        await appendEvent(
          tx,
          scope.job_id,
          attempt.id,
          'attempt_ended',
          { kind: 'browser_control', session_id: sessionId, reason },
          `${attempt.id}:ended`,
        );
      await appendEvent(tx, scope.job_id, null, 'job_state_changed', {
        from: job.state,
        to: state,
        reason,
        session_id: sessionId,
      });
      return attempts.map((attempt) => String(attempt.id));
    });
    // Signal only attempts fenced by this transaction; a newly resumed attempt is a different lease.
    if (fenced.length) this.onPark?.(scope.job_id, fenced);
  }

  /**
   * Hand the work to the person: the job waits for them with a card saying
   * what is done, what is left and where to take over the browser, and its
   * attempt is fenced as a park fences it. Handing the browser back carries
   * the work on (`onHandedBack`). Returns the card, or null when the job has
   * ended or moved to another attempt meanwhile.
   */
  async handOff(
    scope: { space_id: string; job_id: string },
    sessionId: string,
    input: {
      reason: HandOffReason;
      service: string;
      action_id?: string | null;
      /** The action it was handed over at (`paths/operations.ts`), when not the submit's own. */
      operation?: string;
    },
    expectedAttemptId?: string,
  ): Promise<HandOff | null> {
    await this.authorize(sessionId, scope);
    const card = await this.card(scope, sessionId, input);
    const fenced = await this.sql.begin(async (tx) => {
      // Before the job lock, as every event writer does: event order is commit order.
      await lockEventOrderIn(tx);
      const [job] =
        await tx`select id, space_id, state, lease_epoch from job where id = ${scope.job_id} for update`;
      if (
        !job ||
        job.space_id !== scope.space_id ||
        ['completed', 'cancelled', 'failed'].includes(job.state)
      )
        return null;
      if (expectedAttemptId) {
        const [execution] =
          await tx`select epoch, ended_at from attempt where id = ${expectedAttemptId} and job_id = ${scope.job_id}`;
        if (!execution || execution.epoch !== job.lease_epoch || execution.ended_at) return null;
      }
      const wait = { kind: 'user_input', question: handOffWords(card), handoff: card };
      await tx`update job set state = 'waiting_for_input', wait = ${JSON.stringify(wait)}::jsonb,
        lease_epoch = lease_epoch + 1, state_version = state_version + 1,
        next_wake_at = null, updated_at = now() where id = ${scope.job_id}`;
      // The conversation's turn waits on the person, as the conversation is read after a reload.
      await tx`update experience_turn set status = 'needs_you'
        where id = (select current_turn_id from job where id = ${scope.job_id})
          and status in ('queued', 'working', 'streaming')`;
      const detail = { kind: 'handed_to_person', session_id: sessionId, reason: card.reason };
      const attempts = await tx`update attempt set outcome = 'fenced',
        outcome_detail = ${JSON.stringify(detail)}::jsonb,
        ended_at = now(), lease_expires_at = null, lease_status = 'ended'
        where job_id = ${scope.job_id} and ended_at is null returning id`;
      for (const attempt of attempts)
        await appendEvent(
          tx,
          scope.job_id,
          attempt.id,
          'attempt_ended',
          detail,
          `${attempt.id}:ended`,
        );
      await appendEvent(tx, scope.job_id, null, 'job_state_changed', {
        from: job.state,
        to: 'waiting_for_input',
        reason: 'handed_to_person',
        session_id: sessionId,
      });
      await appendEvent(tx, scope.job_id, null, 'notice', { kind: 'handed_to_person', ...card });
      // An unclear submit was counted when it landed unknown; a blocker met on
      // the way, or the policy's own choice of the person, is counted here,
      // against the action it was met at.
      const [submitted] = card.action_id
        ? await tx`select operation_key from action where id = ${card.action_id}`
        : [];
      await recordPathOutcome(tx, {
        spaceId: scope.space_id,
        service: card.service,
        operation: String(submitted?.operation_key ?? input.operation ?? `page ${card.service}`),
        taskKind: await taskKindOf(tx, scope.job_id),
        path: card.reason === 'path' ? 'person' : 'browser',
        outcome: 'handed',
        attempt: card.reason !== 'unclear',
        fault: card.reason,
      });
      return attempts.map((attempt) => String(attempt.id));
    });
    if (fenced === null) return null;
    if (fenced.length) this.onPark?.(scope.job_id, fenced);
    return card;
  }

  /** What the person is handed: the steps done in this browser, what is left, and where to take over. */
  private async card(
    scope: { space_id: string; job_id: string },
    sessionId: string,
    input: { reason: HandOffReason; service: string; action_id?: string | null },
  ): Promise<HandOff> {
    const steps = await this.sql`select kind, canonical_payload from action
      where job_id = ${scope.job_id} and status = 'succeeded'
        and kind in ('browser.open', 'browser.fill', 'browser.select', 'browser.click', 'browser.submit')
        and coalesce(canonical_payload->>'session_id', receipt->>'external_ref') = ${sessionId}
      order by created_at desc, id desc limit 12`;
    const done = [...steps].reverse().flatMap((step) => {
      const words = stepWords(String(step.kind), step.canonical_payload as Record<string, unknown>);
      return words ? [words] : [];
    });
    const [root] = await this.sql`select r.id, r.kind from job j
      join job r on r.id = coalesce(
        (select parent_run_id from run_state where job_id = j.id), j.experience_parent_id, j.id)
      where j.id = ${scope.job_id}`;
    const rootId = String(root?.id ?? scope.job_id);
    return {
      reason: input.reason,
      service: input.service,
      done,
      left: LEFT[input.reason],
      take_over: {
        surface: 'browser',
        session_id: sessionId,
        link: root?.kind === 'chat' ? `/chat/${rootId}?computer=1` : `/runs/${rootId}`,
      },
      action_id: input.action_id ?? null,
    };
  }

  /**
   * A person may steer only the browser of a job they own, in a space they may
   * still use. Anything else reads as an absent session, before the worker moves.
   * Every route a person reaches asks this one question.
   */
  async steerable(sessionId: string, principalId?: string): Promise<Binding & { job_id: string }> {
    const binding = await this.authorize(sessionId);
    if (!binding.job_id) throw new BrowserFault('session_not_found');
    if (principalId) {
      const [owned] = await this.sql`select 1 from job j join space s on s.id = j.space_id
        where j.id = ${binding.job_id} and j.space_id = ${binding.space_id}
          and coalesce(j.principal_id, (select id from owner limit 1)) = ${principalId}
          and ((s.kind = 'personal'
              and coalesce(s.owner_principal_id, (select id from owner limit 1)) = ${principalId})
            or (s.kind = 'shared' and exists (select 1 from space_membership m
              where m.space_id = s.id and m.principal_id = ${principalId} and m.revoked_at is null)))`;
      if (!owned) throw new BrowserFault('session_not_found');
    }
    return { ...binding, job_id: binding.job_id };
  }

  /**
   * A person's control is recorded before the worker is asked for it, so nothing can be learned
   * into a recipe in between. A worker that refuses leaves the binding as it found it.
   */
  private async hold(sessionId: string): Promise<Binding | undefined> {
    return this.sql.begin(async (tx) => {
      const [before] = await tx<
        Binding[]
      >`select id, space_id, job_id, control_epoch, control from browser_session_binding
        where id = ${sessionId} for update`;
      if (!before) return undefined;
      await tx`update browser_session_binding set control = 'human', updated_at = now()
        where id = ${sessionId}`;
      return before;
    });
  }

  private async release(before: Binding): Promise<void> {
    await this.sql`update browser_session_binding set control = ${before.control},
      updated_at = now() where id = ${before.id} and control = 'human'
        and control_epoch = ${before.control_epoch}`;
  }

  async control(sessionId: string, operation: 'takeover' | 'handback', principalId?: string) {
    const binding = await this.steerable(sessionId, principalId);
    const worker = await this.workers.get(binding.space_id);
    const held = operation === 'takeover' ? await this.hold(sessionId) : undefined;
    // The worker bumps immediately, before the database transaction can wait on any job row lock.
    const session: BrowserSession & { site?: string } = await worker[operation](sessionId).catch(
      async (error: unknown) => {
        // A refusal leaves control where it was. An unfinished call may have taken control, so
        // that binding stays with the person until a lease records what the worker really holds.
        if (held && error instanceof BrowserFault) await this.release(held);
        throw error;
      },
    );
    const scope = { space_id: binding.space_id, job_id: binding.job_id };
    await this.record(session, scope);
    // Any live view of this session belongs to the epoch that has just ended.
    this.live.ended(sessionId);
    if (operation === 'takeover') await this.park(scope, sessionId, 'human_control');
    else {
      await this.sql.begin(async (tx) => {
        await lockEventOrderIn(tx);
        await appendEvent(tx, scope.job_id, null, 'notice', {
          kind: 'browser_handback',
          session_id: sessionId,
          control_epoch: session.control_epoch,
          fresh_observation_required: true,
        });
      });
      // The takeover ended on a site whose cookies the profile now holds: the space is signed in.
      if (session.site) await this.sites.record(binding.space_id, session.site);
      // Work handed over carries on. The hand-back has happened whatever that finds.
      await this.onHandedBack?.(scope, sessionId).catch(() => {});
    }
    return {
      session_id: session.id,
      control_epoch: session.control_epoch,
      control: session.control,
      fresh_observation_required: true,
    };
  }
}

/** Mounted after the existing owner session and same-origin middleware. */
export function mountBrowserSessions(app: Hono, sessions: BrowserSessionService) {
  for (const operation of ['takeover', 'handback'] as const) {
    app.post(`/browser/sessions/:id/${operation}`, async (c) => {
      try {
        return c.json(
          browserControlResponse.parse(
            await sessions.control(c.req.param('id'), operation, c.get('owner').id),
          ),
        );
      } catch (error) {
        if (error instanceof BrowserFault)
          throw new ServiceError(
            error.reason,
            `Browser control could not change: ${error.reason}.`,
            error.reason === 'session_not_found' ? 404 : 409,
          );
        throw error;
      }
    });
  }
}

/** Said to the agent when another job's browser did not come free in time. */
export const BROWSER_BUSY =
  'The browser is in use by other work in this space and did not come free in time. Read the page with web.fetch instead, or try the browser again in a few minutes.';
export const BROWSER_WITH_PERSON =
  'A person has taken over the browser for other work in this space. Read the page with web.fetch instead, or try the browser again once they hand it back.';

/** What is left for the person, by why the work came to them. */
const LEFT: Record<HandOffReason, string> = {
  captcha:
    'The page wants to check a person is there. Take over, pass the check, then hand the browser back.',
  two_factor:
    'The page asks for a code sent to you. Take over, enter it yourself, then hand the browser back.',
  payment:
    'The page asks for payment details. Take over and pay yourself if you want to go ahead, then hand the browser back.',
  sign_in:
    'The page asks for something only you type: a password, a code or card details. Take over, enter it yourself, then hand the browser back.',
  unclear:
    'Melete sent the form, and the page does not say whether it went through. Take over, check, finish it if it did not, then hand the browser back.',
  path: 'Melete has not got through on this site lately. Take over and finish it yourself, then hand the browser back.',
};

/** The card in one paragraph, for anywhere that shows the question alone. */
export function handOffWords(card: HandOff): string {
  const done = card.done.length ? ` Done so far: ${card.done.join('; ')}.` : '';
  return `Over to you at ${card.service}. ${card.left}${done}`.slice(0, 3900);
}

const quoted = (value: unknown) =>
  typeof value === 'string' && value.trim() ? `"${value.trim().slice(0, 80)}"` : null;

/** One step the agent took in the browser, in plain words, never with what it typed. */
function stepWords(kind: string, payload: Record<string, unknown>): string | null {
  if (kind === 'browser.open') {
    try {
      return `Opened ${new URL(String(payload.url)).host}`;
    } catch {
      return 'Opened a page';
    }
  }
  if (kind === 'browser.fill') return quoted(payload.label) && `Filled ${quoted(payload.label)}`;
  if (kind === 'browser.select')
    return quoted(payload.label) && `Chose an option for ${quoted(payload.label)}`;
  if (kind === 'browser.click') return quoted(payload.name) && `Pressed ${quoted(payload.name)}`;
  const intent = (payload.intent ?? {}) as Record<string, unknown>;
  return quoted(intent.name) ? `Sent the form with ${quoted(intent.name)}` : 'Sent a form';
}
