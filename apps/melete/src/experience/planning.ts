import {
  automationCreate,
  experienceAutomation,
  experiencePlan,
  isTerminal,
  jobState,
  planCreate,
  triggerSpec,
  unavailable,
} from '@melete/contracts';
import { and, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { databaseNow } from '../db/clock.ts';
import {
  artifact,
  attempt,
  event,
  experienceProfile,
  experienceTurn,
  job,
  planMilestone,
  trigger,
} from '../db/schema.ts';
import { newId } from '../ids.ts';
import type { JobRow } from '../jobs/service.ts';
import type { TriggerService } from '../jobs/triggers.ts';
import { ownJob } from '../principals/authority.ts';
import { answerText, object, plainText } from './projectors.ts';
import { removeJobs } from './removal.ts';
import { type ExperienceService, experienceMissing } from './service.ts';

export const stateLabel = (
  state: string,
): 'idle' | 'queued' | 'working' | 'needs_you' | 'done' | 'failed' | 'stopped' => {
  if (state === 'completed') return 'done';
  if (state === 'failed') return 'failed';
  if (state === 'cancelled') return 'stopped';
  if (state === 'running') return 'working';
  if (state === 'queued') return 'queued';
  if (['waiting_for_input', 'waiting_for_approval', 'needs_reconciliation'].includes(state))
    return 'needs_you';
  return 'idle';
};

export function scheduleSentence(cron: string, zone: string): string {
  const [minute, hour, day, month, weekday] = cron.trim().split(/\s+/);
  if (!/^\d+$/.test(minute ?? '') || !/^\d+$/.test(hour ?? '') || day !== '*' || month !== '*')
    return `On a custom schedule (${zone})`;
  const weekdays =
    weekday === '*' || weekday === '0,1,2,3,4,5,6'
      ? 'Every day'
      : weekday === '1,2,3,4,5'
        ? 'Every weekday'
        : `Every ${(weekday ?? '')
            .split(',')
            .map(
              (value) =>
                ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
                  Number(value)
                ] ?? '',
            )
            .filter(Boolean)
            .join(', ')}`;
  const clock = `${Number(hour) % 12 || 12}:${String(minute).padStart(2, '0')} ${Number(hour) < 12 ? 'AM' : 'PM'}`;
  return `${weekdays} at ${clock} (${zone})`;
}

/** The first lines of an answer, short enough for a card. */
export function excerpt(answer: string, limit = 280): string | null {
  const text = answerText(answer).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/** Why a run did not simply finish, in words the person can act on. */
function runReason(status: string, outcome: string | null, detail: unknown): string | null {
  if (status === 'done' || status === 'working' || status === 'queued') return null;
  const value = object(detail);
  if (outcome === 'failed') {
    const reason = plainText(value.reason, 'the run stopped with an error.', 300);
    // The model gateway's allowance is the usual cause, and it is reported by code.
    if (/token_cap_exceeded|\b429\b/.test(reason))
      return 'Today’s model allowance ran out, so it stopped. It runs again at its next time, or you can choose another model in Settings › Models.';
    return `It failed: ${reason}`;
  }
  if (outcome === 'budget_exhausted') return 'It ran out of time or allowance before it finished.';
  if (outcome === 'fenced') return 'It was stopped before it finished.';
  if (outcome === 'completed')
    return 'It finished, but something it did could not be confirmed. Open the result to check.';
  return 'It is waiting for you. Open the result to answer.';
}

export class ExperiencePlanning {
  constructor(
    readonly service: ExperienceService,
    readonly triggers?: TriggerService,
  ) {}
  get db() {
    return this.service.db;
  }
  async requirePlan(spaceId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(job)
      .where(and(eq(job.id, id), eq(job.spaceId, spaceId), eq(job.kind, 'plan'), ownJob()));
    if (!row) throw experienceMissing();
    return row;
  }
  async view(row: JobRow) {
    const milestones = await this.db
      .select({ milestone: planMilestone, child: job })
      .from(planMilestone)
      .leftJoin(job, and(eq(job.id, planMilestone.childJobId), eq(job.spaceId, row.spaceId)))
      .where(eq(planMilestone.planId, row.id))
      .orderBy(planMilestone.ordinal);
    // A step an assistant does keeps what it last said, so the plan can show it.
    const children = milestones.flatMap(({ child }) => (child ? [child.id] : []));
    const ended = children.length
      ? await this.db
          .select({ jobId: attempt.jobId, detail: attempt.outcomeDetail })
          .from(attempt)
          .where(and(inArray(attempt.jobId, children), isNotNull(attempt.endedAt)))
          .orderBy(desc(attempt.endedAt))
      : [];
    const said = new Map<string, string>();
    for (const entry of ended) {
      const detail = object(entry.detail);
      const words = detail.summary ?? detail.question;
      const text = typeof words === 'string' ? answerText(words).trim() : '';
      if (text && !said.has(entry.jobId))
        said.set(entry.jobId, text.length > 2000 ? `${text.slice(0, 1999).trimEnd()}…` : text);
    }
    const values = milestones.map(({ milestone, child }) => ({
      id: milestone.id,
      title: plainText(milestone.title, 'Next step'),
      assignee: milestone.agentId
        ? { kind: 'agent' as const, agent_id: milestone.agentId }
        : { kind: 'person' as const },
      ...(milestone.scheduleAt ? { schedule_at: milestone.scheduleAt.toISOString() } : {}),
      done: child ? child.state === 'completed' : milestone.done,
      status: child
        ? stateLabel(child.state)
        : milestone.done
          ? ('done' as const)
          : ('idle' as const),
      ...(child ? { output: said.get(child.id) ?? null } : {}),
    }));
    const chats = await this.db
      .select({ id: job.id })
      .from(job)
      .where(and(eq(job.planId, row.id), eq(job.spaceId, row.spaceId), eq(job.kind, 'chat')));
    const related = [
      row.id,
      ...chats.map((entry) => entry.id),
      ...milestones.flatMap((entry) => (entry.child ? [entry.child.id] : [])),
    ];
    const files = await this.db
      .select({ id: artifact.id })
      .from(artifact)
      .where(and(eq(artifact.spaceId, row.spaceId), inArray(artifact.jobId, related)));
    return experiencePlan.parse({
      id: row.id,
      title: plainText(row.title, 'Plan'),
      category: plainText(row.experienceCategory, 'Personal'),
      milestones: values,
      next_step: values.find((item) => !item.done)?.title ?? null,
      progress_percent: values.length
        ? Math.round((values.filter((item) => item.done).length * 100) / values.length)
        : 0,
      conversation_ids: chats.map((entry) => entry.id),
      file_ids: files.map((entry) => entry.id),
      updated_at: row.updatedAt.toISOString(),
    });
  }
  async plans(spaceId: string) {
    const rows = await this.db
      .select()
      .from(job)
      .where(and(eq(job.spaceId, spaceId), eq(job.kind, 'plan'), ownJob()))
      .orderBy(desc(job.updatedAt))
      .limit(100);
    const plans = [];
    for (const row of rows) plans.push(await this.view(row));
    return { plans };
  }
  async create(spaceId: string, raw: unknown) {
    const input = planCreate.parse(raw);
    if (!this.service.jobs) return unavailable('Plans are not connected yet.');
    for (const milestone of input.milestones)
      if (milestone.assignee.kind === 'agent')
        await this.service.requireAgent(spaceId, milestone.assignee.agent_id);
    const jobs = this.service.jobs;
    const row = await jobs.transaction(async (tx) => {
      const row = await jobs.createInTransaction(
        tx,
        { space_id: spaceId, title: input.title, objective: input.title },
        { kind: 'plan' },
        'owner_request',
      );
      await tx.update(job).set({ experienceCategory: input.category }).where(eq(job.id, row.id));
      for (const [ordinal, milestone] of input.milestones.entries()) {
        const assignee = milestone.assignee.kind === 'agent' ? milestone.assignee.agent_id : null;
        const at = milestone.schedule_at ? new Date(milestone.schedule_at) : null;
        const child = assignee
          ? await jobs.createInTransaction(
              tx,
              {
                space_id: spaceId,
                title: milestone.title,
                objective: `Plan: ${input.title}\nStep: ${milestone.title}`,
                scheduling_class: 'background',
                importance: 'routine',
              },
              {
                kind: 'milestone',
                agentId: assignee,
                planId: row.id,
                ...(at ? { scheduledAt: at } : {}),
              },
            )
          : null;
        await tx.insert(planMilestone).values({
          id: newId('mile'),
          planId: row.id,
          title: milestone.title,
          ordinal,
          agentId: assignee,
          childJobId: child?.id,
          scheduleAt: at,
        });
      }
      return { ...row, experienceCategory: input.category };
    });
    return { plan: await this.view(row) };
  }
  async complete(spaceId: string, id: string, milestoneId: string, done: boolean) {
    await this.requirePlan(spaceId, id);
    const [row] = await this.db
      .select()
      .from(planMilestone)
      .where(and(eq(planMilestone.id, milestoneId), eq(planMilestone.planId, id)));
    if (!row) throw experienceMissing();
    if (row.agentId)
      return unavailable('This step is completed when the assigned assistant finishes it.');
    await this.db.transaction(async (tx) => {
      await tx.update(planMilestone).set({ done }).where(eq(planMilestone.id, milestoneId));
      await tx.update(job).set({ updatedAt: new Date() }).where(eq(job.id, id));
    });
    return { plan: await this.view(await this.requirePlan(spaceId, id)) };
  }
  /**
   * Delete a plan and its steps. Work on a step is stopped first, the way a
   * deleted chat's is; chats started from the plan stay, no longer linked.
   */
  async remove(spaceId: string, id: string, raw: Sql | undefined) {
    await this.requirePlan(spaceId, id);
    const jobs = this.service.jobs;
    if (!jobs || !raw) return unavailable('Plans are not connected yet.');
    const steps = await this.db
      .select({ id: job.id })
      .from(job)
      .where(
        and(eq(job.planId, id), eq(job.spaceId, spaceId), eq(job.kind, 'milestone'), ownJob()),
      );
    await removeJobs(
      { jobs, sql: raw, runner: this.service.runner, workspaces: this.service.workspaces },
      [id, ...steps.map((step) => step.id)],
    );
    await this.triggers?.syncSchedules();
    return { status: 'ok' as const };
  }
  async conversation(spaceId: string, id: string, agentId: string) {
    const plan = await this.requirePlan(spaceId, id);
    return this.service.createConversation(spaceId, {
      title: plan.title,
      agent_id: agentId,
      plan_id: id,
    });
  }
  /**
   * A routine as the person sees it. It is on while its schedule is enabled and
   * its job can still run: a routine whose job was stopped is off, whatever its
   * schedule says.
   */
  async automation(row: typeof trigger.$inferSelect, title: string, state: string) {
    const spec = triggerSpec.parse(row.spec);
    const runs = await this.db
      .select()
      .from(attempt)
      .where(eq(attempt.jobId, row.jobId))
      .orderBy(desc(attempt.startedAt))
      .limit(20);
    const turnIds = runs.flatMap((run) => (run.turnId ? [run.turnId] : []));
    const turns = turnIds.length
      ? await this.db
          .select()
          .from(experienceTurn)
          .where(and(eq(experienceTurn.jobId, row.jobId), inArray(experienceTurn.id, turnIds)))
      : [];
    const turnById = new Map(turns.map((turn) => [turn.id, turn]));
    const endings = runs.length
      ? await this.db
          .select({ attemptId: event.attemptId, payload: event.payload })
          .from(event)
          .where(
            and(
              inArray(
                event.attemptId,
                runs.map((run) => run.id),
              ),
              eq(event.type, 'attempt_ended'),
            ),
          )
      : [];
    const incomplete = new Set(
      endings
        .filter((entry) => object(entry.payload).experience_completed === false)
        .map((entry) => entry.attemptId),
    );
    return experienceAutomation.parse({
      id: row.id,
      title: plainText(title, 'Routine'),
      schedule:
        spec.kind === 'schedule'
          ? scheduleSentence(spec.cron, spec.timezone)
          : 'When the connected app has an update',
      enabled: row.enabled && !isTerminal(jobState.parse(state)),
      ended: isTerminal(jobState.parse(state)),
      conversation_id: row.jobId,
      runs: runs.map((run, index) => {
        const status =
          run.outcome === 'completed'
            ? incomplete.has(run.id)
              ? 'needs_you'
              : 'done'
            : run.outcome === 'failed' || run.outcome === 'budget_exhausted'
              ? 'failed'
              : run.outcome === 'fenced'
                ? 'stopped'
                : run.endedAt
                  ? 'needs_you'
                  : 'working';
        const turn = run.turnId ? turnById.get(run.turnId) : undefined;
        // Each run shows what it said itself. The turn holds only the newest
        // answer, so it speaks for a run still under way and for no other.
        const said = object(run.outcomeDetail).summary;
        const newest = !runs.slice(0, index).some((other) => other.turnId === run.turnId);
        return {
          id: run.id,
          status,
          started_at: run.startedAt.toISOString(),
          finished_at: run.endedAt?.toISOString() ?? null,
          conversation_id: turn ? row.jobId : null,
          turn_id: turn?.id ?? null,
          summary:
            typeof said === 'string'
              ? excerpt(said)
              : turn && newest && !run.endedAt
                ? excerpt(turn.answer)
                : null,
          reason: runReason(status, run.outcome, run.outcomeDetail),
        };
      }),
    });
  }
  /** The newest run of each routine that ran in the last day, newest first. */
  async recentResults(spaceId: string) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await this.db
      .select({ trigger, title: job.title, state: job.state })
      .from(trigger)
      .innerJoin(job, eq(job.id, trigger.jobId))
      .where(
        and(
          eq(job.spaceId, spaceId),
          eq(job.kind, 'routine'),
          eq(trigger.kind, 'schedule'),
          ownJob(),
          inArray(
            job.id,
            this.db
              .select({ id: attempt.jobId })
              .from(attempt)
              .where(and(isNotNull(attempt.turnId), gt(attempt.startedAt, since))),
          ),
        ),
      )
      .limit(20);
    const results = [];
    for (const entry of rows) {
      const view = await this.automation(entry.trigger, entry.title, entry.state);
      const run = view.runs.find(
        (item) => item.turn_id && Date.parse(item.started_at) > since.getTime(),
      );
      if (run)
        results.push({
          automation_id: view.id,
          title: view.title,
          conversation_id: view.conversation_id,
          run,
        });
    }
    return results.sort((a, b) => b.run.started_at.localeCompare(a.run.started_at));
  }
  /**
   * Moves every routine in the space to a new time zone. A routine set for
   * 8:30 stays at 8:30 on the person's clock, and the zone's own rules carry
   * it across daylight-saving changes.
   */
  async retimeSchedules(spaceId: string, zone: string) {
    const rows = await this.db
      .select({ trigger })
      .from(trigger)
      .innerJoin(job, eq(job.id, trigger.jobId))
      .where(and(eq(job.spaceId, spaceId), eq(job.kind, 'routine'), eq(trigger.kind, 'schedule')));
    let changed = 0;
    for (const { trigger: row } of rows) {
      const spec = triggerSpec.parse(row.spec);
      if (spec.kind !== 'schedule' || spec.timezone === zone) continue;
      await this.db
        .update(trigger)
        .set({ spec: triggerSpec.parse({ ...spec, timezone: zone }) })
        .where(eq(trigger.id, row.id));
      changed++;
    }
    if (changed) await this.triggers?.syncSchedules();
  }
  async automations(spaceId: string) {
    const rows = await this.db
      .select({ trigger, title: job.title, state: job.state })
      .from(trigger)
      .innerJoin(job, eq(job.id, trigger.jobId))
      .where(
        and(
          eq(job.spaceId, spaceId),
          eq(job.kind, 'routine'),
          eq(trigger.kind, 'schedule'),
          ownJob(),
        ),
      )
      .orderBy(trigger.createdAt)
      .limit(100);
    return {
      automations: await Promise.all(
        rows.map((entry) => this.automation(entry.trigger, entry.title, entry.state)),
      ),
    };
  }
  async createAutomation(spaceId: string, raw: unknown) {
    const input = automationCreate.parse(raw);
    if (!this.triggers || !this.service.jobs)
      return unavailable('Scheduled routines are not connected yet.');
    const runner = await this.service.agentOrDefault(spaceId, input.agent_id);
    const [profile] = await this.db
      .select()
      .from(experienceProfile)
      .where(eq(experienceProfile.spaceId, spaceId));
    const [hour, minute] = input.at.split(':').map(Number);
    const days = [...new Set(input.weekdays)].sort().join(',');
    const spec = triggerSpec.parse({
      kind: 'schedule',
      cron: `${minute} ${hour} * * ${days}`,
      timezone: profile?.timeZone ?? 'UTC',
    });
    return this.register(spaceId, {
      title: input.title,
      objective: input.instruction,
      agentId: runner.id,
      spec,
    });
  }
  /**
   * Saves a routine: its own thread, resting until its schedule fires. A
   * routine started again from an ended one takes the old one's place, so the
   * ended registration goes in the same transaction.
   */
  private async register(
    spaceId: string,
    routine: {
      title: string;
      objective: string;
      agentId: string;
      spec: ReturnType<typeof triggerSpec.parse>;
    },
    replaces?: string,
  ) {
    const jobs = this.service.jobs;
    if (!this.triggers || !jobs) return unavailable('Scheduled routines are not connected yet.');
    const registration = await jobs.transaction(async (tx) => {
      const row = await jobs.createInTransaction(
        tx,
        {
          space_id: spaceId,
          title: routine.title,
          objective: routine.objective,
          scheduling_class: 'background',
          importance: 'routine',
        },
        { kind: 'routine', agentId: routine.agentId, dormant: true },
      );
      const [registration] = await tx
        .insert(trigger)
        .values({ id: newId('trg'), jobId: row.id, kind: 'schedule', spec: routine.spec })
        .returning();
      if (!registration) throw new Error('Routine was not saved.');
      await tx
        .update(job)
        .set({
          state: 'waiting_for_event_or_time',
          wait: { kind: 'event', trigger_id: registration.id, deadline_at: null },
          nextWakeAt: null,
        })
        .where(eq(job.id, row.id));
      if (replaces) {
        // A second start of the same ended routine finds it gone and saves nothing.
        const gone = await tx
          .delete(trigger)
          .where(eq(trigger.id, replaces))
          .returning({ id: trigger.id });
        if (!gone.length) throw experienceMissing();
      }
      return registration;
    });
    await this.triggers.syncSchedules();
    return {
      automation: await this.automation(registration, routine.title, 'waiting_for_event_or_time'),
    };
  }
  private async requireAutomation(spaceId: string, id: string) {
    const [row] = await this.db
      .select({ trigger, job })
      .from(trigger)
      .innerJoin(job, eq(job.id, trigger.jobId))
      .where(
        and(
          eq(trigger.id, id),
          eq(job.spaceId, spaceId),
          eq(job.kind, 'routine'),
          eq(trigger.kind, 'schedule'),
          ownJob(),
        ),
      );
    if (!row) throw experienceMissing();
    return row;
  }
  async testAutomation(spaceId: string, id: string) {
    const row = await this.requireAutomation(spaceId, id);
    if (!this.triggers) return unavailable('Scheduled routines are not connected yet.');
    if (isTerminal(jobState.parse(row.job.state))) throw routineEnded();
    if (!row.trigger.enabled) return unavailable('Resume this routine before testing it.');
    if (row.job.state !== 'waiting_for_event_or_time')
      throw new ServiceError(
        'routine_busy',
        'This routine is already running or needs your answer.',
        409,
      );
    // The person asked for this run of it, so it is theirs, not background work.
    await this.triggers.fireSchedule(id, newId('op'), { principalId: null });
    return { status: 'ok' };
  }
  /**
   * Pausing turns the schedule off and leaves the routine's thread as it is. A
   * run already under way finishes, and the routine then rests until resumed.
   */
  async setAutomationEnabled(spaceId: string, id: string, enabled: boolean) {
    const row = await this.requireAutomation(spaceId, id);
    if (!this.triggers) return unavailable('Scheduled routines are not connected yet.');
    if (enabled && isTerminal(jobState.parse(row.job.state))) throw routineEnded();
    // Occurrences that arrived before the change are not owed a run: a resumed
    // routine waits for its next time rather than catching up. The routine's
    // lock is the one an arriving occurrence takes, so none lands in between.
    const jobs = this.service.jobs;
    if (!jobs) return unavailable('Scheduled routines are not connected yet.');
    await jobs.transaction(async (tx) => {
      const locked = await jobs.lock(tx, row.job.id);
      const [latest] = await tx
        .select({ seq: sql<number>`coalesce(max(${event.seq}), 0)::bigint` })
        .from(event);
      await tx
        .update(trigger)
        .set({ enabled, cursor: String(latest?.seq ?? 0) })
        .where(eq(trigger.id, id));
      // A routine paused for waking with nothing to show was held as it was
      // about to run; resumed, it runs that once.
      if (enabled && locked?.paused) {
        const now = await databaseNow(tx);
        const [resumed] = await tx
          .update(job)
          .set({ paused: false, ...(locked.state === 'queued' ? { nextWakeAt: now } : {}) })
          .where(eq(job.id, locked.id))
          .returning();
        if (resumed?.state === 'queued') await jobs.enqueue(tx, resumed, 'recovery');
      }
    });
    await this.triggers.syncSchedules();
    return {
      automation: await this.automation({ ...row.trigger, enabled }, row.job.title, row.job.state),
    };
  }
  /**
   * Starts an ended routine again: a new routine with the same title,
   * instruction, assistant and schedule takes the ended one's place on the
   * list. The ended one's thread and runs stay as they were.
   */
  async restartAutomation(spaceId: string, id: string) {
    const row = await this.requireAutomation(spaceId, id);
    if (!isTerminal(jobState.parse(row.job.state)))
      throw new ServiceError(
        'routine_not_ended',
        'This routine has not ended. Resume it instead of starting it again.',
        409,
      );
    const runner = await this.service.agentOrDefault(spaceId, row.job.agentId ?? undefined);
    return this.register(
      spaceId,
      {
        title: row.job.title,
        objective: row.job.objective,
        agentId: runner.id,
        spec: triggerSpec.parse(row.trigger.spec),
      },
      row.trigger.id,
    );
  }
  /**
   * Stops the routine, a run under way included, and deletes it with its
   * thread, the way a deleted chat goes: nothing of it is left to open.
   */
  async deleteAutomation(spaceId: string, id: string, raw: Sql | undefined) {
    const row = await this.requireAutomation(spaceId, id);
    const jobs = this.service.jobs;
    if (!this.triggers || !jobs || !raw)
      return unavailable('Scheduled routines are not connected yet.');
    // One transaction disables the schedule, cancels the run and fences it, so
    // no occurrence can start a run behind it; then the rows go.
    await removeJobs(
      { jobs, sql: raw, runner: this.service.runner, workspaces: this.service.workspaces },
      [row.job.id],
    );
    await this.triggers.syncSchedules();
    return { status: 'ok' as const };
  }
}

const routineEnded = () =>
  new ServiceError(
    'routine_ended',
    'This routine was stopped and cannot run again. Delete it and create a new one.',
    409,
  );
