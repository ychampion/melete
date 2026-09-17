import {
  experienceCalendarEvent,
  experienceConnection,
  experienceSearch,
  experienceTask,
  profileInput,
  taskInput,
  unavailable,
} from '@melete/contracts';
import { and, desc, eq, ilike, inArray, ne, sql } from 'drizzle-orm';
import { describeDate } from '../dates.ts';
import type { Database } from '../db/client.ts';
import { action, connection, experienceProfile, job, task } from '../db/schema.ts';
import { newId } from '../ids.ts';
import { ownJob } from '../principals/authority.ts';
import type { ExperienceEffects } from './effects.ts';
import { actionLabel, appName, object, plainText, safeUrl } from './projectors.ts';
import { experienceMissing } from './service.ts';

export const taskView = (row: typeof task.$inferSelect) =>
  experienceTask.parse({
    id: row.id,
    title: plainText(row.title, 'Task'),
    due_at: row.dueAt?.toISOString() ?? null,
    done: row.done,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });

export function dayGreeting(profile: ReturnType<typeof profileInput.parse>, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: profile.time_zone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = hour * 60 + Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  const minutes = (at: string) => {
    const [hours, minutes] = at.split(':').map(Number);
    return (hours ?? 0) * 60 + (minutes ?? 0);
  };
  const start = minutes(profile.day_hours.start),
    end = minutes(profile.day_hours.end);
  const salutation = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return {
    greeting:
      profile.name === 'there' ? salutation : `${salutation}, ${plainText(profile.name, 'there')}`,
    date: describeDate(now, profile.time_zone),
    time_zone: profile.time_zone,
    within_day_hours:
      start === end ||
      (start < end ? minute >= start && minute < end : minute >= start || minute < end),
  };
}

export class ExperienceHome {
  constructor(
    readonly db: Database,
    readonly effects?: ExperienceEffects,
  ) {}
  async profile(spaceId: string) {
    const [row] = await this.db
      .select()
      .from(experienceProfile)
      .where(eq(experienceProfile.spaceId, spaceId));
    return {
      profile: profileInput.parse(
        row
          ? {
              name: row.name,
              time_zone: row.timeZone,
              day_hours: { start: row.dayStart, end: row.dayEnd },
            }
          : { name: 'there', time_zone: 'UTC', day_hours: { start: '08:00', end: '22:00' } },
      ),
    };
  }
  async saveProfile(spaceId: string, raw: unknown) {
    const input = profileInput.parse(raw);
    const values = {
      spaceId,
      name: input.name,
      timeZone: input.time_zone,
      dayStart: input.day_hours.start,
      dayEnd: input.day_hours.end,
    };
    await this.db
      .insert(experienceProfile)
      .values(values)
      .onConflictDoUpdate({ target: experienceProfile.spaceId, set: values });
    return this.profile(spaceId);
  }
  async tasks(spaceId: string) {
    const rows = await this.db
      .select()
      .from(task)
      .where(eq(task.spaceId, spaceId))
      .orderBy(task.done, task.dueAt, desc(task.createdAt))
      .limit(200);
    return { tasks: rows.map(taskView) };
  }
  async saveTask(spaceId: string, raw: unknown, id?: string) {
    const input = taskInput.parse(raw);
    const values = {
      title: input.title,
      dueAt: input.due_at ? new Date(input.due_at) : null,
      done: input.done,
      updatedAt: new Date(),
    };
    const [row] = id
      ? await this.db
          .update(task)
          .set(values)
          .where(and(eq(task.id, id), eq(task.spaceId, spaceId)))
          .returning()
      : await this.db
          .insert(task)
          .values({ id: newId('task'), spaceId, ...values })
          .returning();
    if (!row) throw experienceMissing();
    return { task: taskView(row) };
  }
  async deleteTask(spaceId: string, id: string) {
    const rows = await this.db
      .delete(task)
      .where(and(eq(task.id, id), eq(task.spaceId, spaceId)))
      .returning({ id: task.id });
    if (!rows.length) throw experienceMissing();
    return { status: 'ok' };
  }
  async connections(spaceId: string) {
    const rows = await this.db
      .select()
      .from(connection)
      // A removed connection stays a row for the ledger, and is no longer something to show.
      .where(and(eq(connection.spaceId, spaceId), ne(connection.status, 'revoked')))
      .orderBy(connection.label);
    return {
      connections: rows.map((row) =>
        experienceConnection.parse({
          id: row.id,
          app: appName(row),
          label: plainText(row.label, appName(row)),
          status:
            row.setupState === 'connecting' || row.setupState === 'available'
              ? row.setupState
              : row.status !== 'active' || row.health === 'failing'
                ? 'error'
                : 'connected',
          access: row.scopes.some((scope) =>
            /(?:send|create|update|delete|write|move)$/.test(scope),
          )
            ? 'asks_before_acting'
            : row.scopes.some((scope) => scope.endsWith('.draft'))
              ? 'draft_only'
              : 'read_only',
          ...(row.configuration.builtin === undefined ? {} : { builtin: true }),
        }),
      ),
    };
  }
  calendarEvents(connectionId: string, detail: unknown) {
    const rows = object(detail).events;
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((raw) => {
      const item = object(raw);
      const url = safeUrl(item.url);
      const parsed = experienceCalendarEvent.safeParse({
        id: `${connectionId}:${plainText(item.uid, 'event', 160)}`,
        title: plainText(item.summary, 'Calendar event'),
        starts_at: item.start,
        ends_at: item.end,
        connection_id: connectionId,
        ...(url ? { url } : {}),
      });
      return parsed.success ? [parsed.data] : [];
    });
  }
  async upcoming(spaceId: string) {
    const rows = await this.db
      .select()
      .from(connection)
      .where(
        and(
          eq(connection.spaceId, spaceId),
          eq(connection.status, 'active'),
          inArray(connection.provider, ['caldav', 'ics']),
        ),
      );
    if (!rows.length || !this.effects)
      return unavailable('Connect a calendar to see upcoming events.');
    const events = [];
    for (const row of rows) {
      const result = await this.effects.read(spaceId, row.id, 'calendar.list', { limit: 100 });
      if ('reason' in result || result.status !== 'succeeded')
        return unavailable('Your calendar could not be read just now.');
      events.push(...this.calendarEvents(row.id, result.receipt?.detail));
    }
    return events
      .filter((event) => Date.parse(event.ends_at) >= Date.now())
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
      .slice(0, 30);
  }
  async home(spaceId: string) {
    const { profile } = await this.profile(spaceId);
    const { tasks } = await this.tasks(spaceId);
    const [counts] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(task)
      .where(and(eq(task.spaceId, spaceId), eq(task.done, false)));
    return {
      ...dayGreeting(profile),
      upcoming: await this.upcoming(spaceId),
      tasks: tasks.filter((item) => !item.done).slice(0, 20),
      open_task_count: counts?.count ?? 0,
    };
  }
  /**
   * Conversations, plans and actions are the caller's own jobs. Tasks and
   * connections belong to the space, so only its owner finds them here.
   */
  async search(spaceId: string, query: string, spaceOwner = true) {
    const pattern = `%${query.replace(/[\\%_]/g, (value) => `\\${value}`)}%`;
    const results = [];
    const jobs = await this.db
      .select()
      .from(job)
      .where(
        and(
          eq(job.spaceId, spaceId),
          inArray(job.kind, ['chat', 'plan']),
          ilike(job.title, pattern),
          ownJob(),
        ),
      )
      .orderBy(desc(job.updatedAt))
      .limit(50);
    for (const row of jobs)
      results.push({
        id: row.id,
        kind: row.kind === 'chat' ? 'conversation' : 'plan',
        title: plainText(row.title, 'Conversation'),
        meta: row.kind === 'chat' ? 'Conversation' : 'Plan',
        conversation_id: row.kind === 'chat' ? row.id : null,
      });
    const tasks = spaceOwner
      ? await this.db
          .select()
          .from(task)
          .where(and(eq(task.spaceId, spaceId), ilike(task.title, pattern)))
          .limit(50)
      : [];
    for (const row of tasks)
      results.push({
        id: row.id,
        kind: 'task',
        title: plainText(row.title, 'Task'),
        meta: row.done ? 'Completed task' : 'Task',
        conversation_id: null,
      });
    const connections = spaceOwner ? (await this.connections(spaceId)).connections : [];
    const matches = (value: string) =>
      value.toLocaleLowerCase().includes(query.toLocaleLowerCase());
    for (const row of connections.filter((item) => matches(`${item.label} ${item.app}`)))
      results.push({
        id: row.id,
        kind: 'connection',
        title: row.label,
        meta: row.app,
        conversation_id: null,
      });
    const effects = await this.db
      .select({ action, job, connection })
      .from(action)
      .innerJoin(job, eq(job.id, action.jobId))
      .innerJoin(connection, eq(connection.id, action.connectionId))
      .where(
        and(
          eq(job.spaceId, spaceId),
          eq(connection.spaceId, spaceId),
          eq(action.status, 'succeeded'),
          ownJob(),
        ),
      )
      .orderBy(desc(action.createdAt))
      .limit(500);
    const calendars = new Set<string>();
    for (const row of effects) {
      const title = actionLabel(row.action);
      const subject = plainText(
        object(row.action.canonicalPayload).subject ?? object(row.action.canonicalPayload).summary,
        '',
      );
      if (matches(`${title} ${subject}`))
        results.push({
          id: row.action.id,
          kind: 'action',
          title,
          meta: subject || appName(row.connection),
          conversation_id: row.job.kind === 'chat' ? row.job.id : row.job.experienceParentId,
        });
      if (row.action.kind === 'calendar.list' && !calendars.has(row.connection.id)) {
        calendars.add(row.connection.id);
        for (const event of this.calendarEvents(
          row.connection.id,
          object(row.action.receipt).detail,
        ).filter((item) => matches(item.title)))
          results.push({
            id: event.id,
            kind: 'event',
            title: event.title,
            meta: event.starts_at,
            conversation_id: null,
          });
      }
    }
    return experienceSearch.parse({ results: results.slice(0, 100) });
  }
}
