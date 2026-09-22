import {
  automationCreate,
  experienceAutomation,
  experiencePlan,
  planCreate,
  triggerSpec,
  unavailable,
} from '@melete/contracts';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import {
  artifact,
  attempt,
  event,
  experienceProfile,
  job,
  planMilestone,
  trigger,
} from '../db/schema.ts';
import { newId } from '../ids.ts';
import type { JobRow } from '../jobs/service.ts';
import type { TriggerService } from '../jobs/triggers.ts';
import { ownJob } from '../principals/authority.ts';
import { object, plainText } from './projectors.ts';
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
    weekday === '*'
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
  async conversation(spaceId: string, id: string, agentId: string) {
    const plan = await this.requirePlan(spaceId, id);
    return this.service.createConversation(spaceId, {
      title: plan.title,
      agent_id: agentId,
      plan_id: id,
    });
  }
  async automation(row: typeof trigger.$inferSelect, title: string) {
    const spec = triggerSpec.parse(row.spec);
    const runs = await this.db
      .select()
      .from(attempt)
      .where(eq(attempt.jobId, row.jobId))
      .orderBy(desc(attempt.startedAt))
      .limit(20);
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
      enabled: row.enabled,
      runs: runs.map((run) => ({
        id: run.id,
        status:
          run.outcome === 'completed'
            ? incomplete.has(run.id)
              ? 'needs_you'
              : 'done'
            : run.outcome === 'failed'
              ? 'failed'
              : run.outcome === 'fenced'
                ? 'stopped'
                : run.endedAt
                  ? 'needs_you'
                  : 'working',
        started_at: run.startedAt.toISOString(),
        finished_at: run.endedAt?.toISOString() ?? null,
      })),
    });
  }
  async automations(spaceId: string) {
    const rows = await this.db
      .select({ trigger, title: job.title })
      .from(trigger)
      .innerJoin(job, eq(job.id, trigger.jobId))
      .where(and(eq(job.spaceId, spaceId), eq(trigger.kind, 'schedule'), ownJob()))
      .orderBy(trigger.createdAt)
      .limit(100);
    return {
      automations: await Promise.all(
        rows.map((entry) => this.automation(entry.trigger, entry.title)),
      ),
    };
  }
  async createAutomation(spaceId: string, raw: unknown) {
    const input = automationCreate.parse(raw);
    if (!this.triggers || !this.service.jobs)
      return unavailable('Scheduled routines are not connected yet.');
    await this.service.requireAgent(spaceId, input.agent_id);
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
    const jobs = this.service.jobs;
    const registration = await jobs.transaction(async (tx) => {
      const row = await jobs.createInTransaction(
        tx,
        {
          space_id: spaceId,
          title: input.title,
          objective: input.instruction,
          scheduling_class: 'background',
          importance: 'routine',
        },
        { kind: 'routine', agentId: input.agent_id, dormant: true },
      );
      const [registration] = await tx
        .insert(trigger)
        .values({ id: newId('trg'), jobId: row.id, kind: 'schedule', spec })
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
      return registration;
    });
    await this.triggers.syncSchedules();
    return { automation: await this.automation(registration, input.title) };
  }
  async testAutomation(spaceId: string, id: string) {
    const [row] = await this.db
      .select({ trigger, job })
      .from(trigger)
      .innerJoin(job, eq(job.id, trigger.jobId))
      .where(
        and(eq(trigger.id, id), eq(job.spaceId, spaceId), eq(trigger.kind, 'schedule'), ownJob()),
      );
    if (!row) throw experienceMissing();
    if (!this.triggers) return unavailable('Scheduled routines are not connected yet.');
    if (!row.trigger.enabled) return unavailable('Enable this routine before testing it.');
    if (row.job.state !== 'waiting_for_event_or_time')
      throw new ServiceError(
        'routine_busy',
        'This routine is already running or needs your answer.',
        409,
      );
    await this.triggers.fireSchedule(id, newId('op'));
    return { status: 'ok' };
  }
}
