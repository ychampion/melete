/**
 * Phone presence. A person subscribes a device; Melete records what is worth
 * saying once, as a push intent, and sends it when the policy allows: inside
 * their day, under their daily cap, folded with whatever else arrived close to
 * it, and always saying why.
 *
 * Decisions are found by reading the state that already exists (open approvals
 * and questions) rather than by hooking every place one is raised, and only
 * those raised after the person's first device subscribed: turning push on
 * never floods a phone with the past. A chase settling is recorded where the
 * ledger item is marked settled (see `recordSettled`).
 *
 * Conversations and jobs are read the same way (`collectStatus`): one that
 * stopped on the person, or a conversation that answered while they were
 * away, becomes one intent per change of state.
 */

import { createHash } from 'node:crypto';
import {
  type PushSettings,
  type PushSubscriptionRequest,
  pushPayload,
  type pushSettingsUpdate,
} from '@melete/contracts';
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { z } from 'zod';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import {
  clientFocus,
  experienceProfile,
  owner,
  pushIntent,
  pushSetting,
  pushSubscription,
  space,
} from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { newId } from '../ids.ts';
import { QUEUES } from '../jobs/queue.ts';
import { workQuiet } from '../jobs/quiet.ts';
import { assistantName } from '../names.ts';
import {
  type DayWindow,
  type IntentKind,
  localTime,
  planPush,
  type SentToday,
  type Waiting,
} from './policy.ts';
import { type PushOutcome, sendPush, subscriptionKeysUsable, type VapidKeys } from './webpush.ts';

/**
 * Browser push services, by host. An endpoint anywhere else is refused, so a
 * subscription cannot turn this service into a way to reach arbitrary hosts.
 */
const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  'notify.windows.com',
];

export type PushConfig = {
  keys: VapidKeys | null;
  /** `mailto:` or an https URL the push services can reach the operator at. */
  subject: string | null;
  /** Origins added by the operator, for a self-hosted push server or a test. */
  extraOrigins: string[];
  fetcher?: typeof fetch;
};

export const DEFAULT_SETTINGS = {
  decisions: true,
  settled: true,
  weeklySummary: true,
  dailyCap: 4,
  batchMinutes: 10,
};

type SubscriptionRow = typeof pushSubscription.$inferSelect;

function allowedEndpoint(endpoint: string, extraOrigins: string[]): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (extraOrigins.includes(url.origin)) return true;
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  return PUSH_SERVICE_HOSTS.some(
    (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
  );
}

/**
 * Names an endpoint without revealing it, so a browser can find its own row in
 * the list by hashing its own subscription's endpoint the same way.
 */
export const endpointHash = (endpoint: string) =>
  createHash('sha256').update(endpoint).digest('base64url');

const view = (row: SubscriptionRow) => ({
  id: row.id,
  device_label: row.deviceLabel,
  endpoint_hash: endpointHash(row.endpoint),
  created_at: row.createdAt.toISOString(),
  last_used_at: row.lastUsedAt?.toISOString() ?? null,
});

const clip = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

/** The lane a reminder the person timed is recorded as sent in: no lane's cap counts it. */
const ON_TIME_LANE = 'reminder';
/** How far back a change of state is still news. */
export const STATUS_LOOKBACK_MS = 60 * 60_000;
/**
 * One push per conversation and kind in this window; what changes inside it is
 * recorded and not sent. A reminder the person timed is never held by it.
 */
export const STATUS_THROTTLE_MINUTES = 10;
/** A client focused this close to an answer, or after it, means the person saw it. */
export const FOCUS_GRACE_MINUTES = 2;
/**
 * How long a push that went out, was dropped or never went is kept. Longer than
 * every window that reads them back: the lookback, the throttle, a day's count,
 * a run's spacing and the weekly summary's day.
 */
export const INTENT_KEEP_MS = 7 * 86_400_000;
/** The clearing of old pushes rides on the dispatch pass at most this often. */
export const INTENT_SWEEP_EVERY_MS = 60 * 60_000;

/** The answer's first words, as plain text, for a lock screen. */
export function answerPreview(answer: string): string {
  const plain = answer
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(plain, 200);
}

/**
 * A settled chase, recorded in the transaction that settled it. Only for a
 * person with a device to tell who has not turned this kind off; the dedup key
 * makes a second settle a no-op.
 */
export async function recordSettled(
  tx: Transaction | Database,
  item: { id: string; principalId: string; summary: string; jobId: string | null },
): Promise<void> {
  await tx.execute(sql`
    insert into push_intent (id, principal_id, kind, title, body, because, url, dedup_key)
    select ${newId('pint')}, ${item.principalId}, 'settled', 'A chase settled',
           ${clip(item.summary, 300)}, ${`Because you asked ${assistantName()} to chase this.`},
           ${item.jobId ? `/#/chat/${item.jobId}` : '/#/companies'}, ${`settled:${item.id}`}
    where exists (select 1 from push_subscription s where s.principal_id = ${item.principalId})
      and coalesce((select p.settled from push_setting p where p.principal_id = ${item.principalId}), true)
    on conflict (dedup_key) do nothing`);
}

/**
 * A room's permissions that wait for this person: those of the room's work in
 * rooms they are in, that the room's rule for each lets them answer now.
 * Nobody else in the room is told.
 *
 * This is the SQL form of `approverRuleFor`, `isTeamAccount` and
 * `eligibleApprovers` in `rooms/approvals.ts`, which decide who may answer: a
 * change to the rule there changes it here too. The room approval tests check
 * that the people pushed are the people the card names.
 */
function roomDecisions(principalId: string, since: Date) {
  // Several people may be told of one permission, so each one's key names them.
  return sql`select 'approval:' || a.id || ':' || ${principalId}, j.id, r.title,
           'Because it can’t go on until someone it names decides.', a.requested_at,
           '/#/rooms/' || r.space_id || coalesce('/' || r.room_thread_id, '')
    from approval a
    join action ac on ac.id = a.action_id
    join job j on j.id = ac.job_id
    left join job parent on parent.id = j.experience_parent_id and parent.space_id = j.space_id
    join job r on r.id = case when parent.audience = 'room' then parent.id else j.id end
    join principal holder on holder.id = j.principal_id
    join space s on s.id = r.space_id and s.kind = 'shared' and s.removed_at is null
    join space_membership m on m.space_id = r.space_id and m.principal_id = ${principalId}
      and m.revoked_at is null and m.role in ('owner', 'member')
    join principal p on p.id = m.principal_id and p.kind = 'person'
    left join room_policy rp on rp.space_id = r.space_id
    -- One of the room's own accounts: its own rule decides what goes through it.
    left join connection team on team.id = ac.connection_id and team.space_id = r.space_id
      and team.shared_use = 'room' and not (team.configuration ? 'builtin')
    where a.decided_at is null
      and (a.expires_at is null or a.expires_at > now())
      and (parent.audience = 'room' or j.audience = 'room' or holder.kind = 'room')
      and case when team.id is not null then
        coalesce(rp.team_account_approvers, 'any_member') = 'any_member' or m.role = 'owner'
      else case coalesce(rp.approvers, 'requester')
        when 'requester' then r.requested_by_principal_id = m.principal_id
          -- A guest never answers: the owners answer a guest's request.
          or (m.role = 'owner' and exists (select 1 from principal g
            where g.id = r.requested_by_principal_id and g.kind = 'guest'))
        when 'any_member' then true
        when 'owners' then m.role = 'owner'
        else false end end
      and a.requested_at >= ${since.toISOString()}::timestamptz`;
}

/**
 * Where a decision is answered: long work's own page (a helper's is its
 * run's), otherwise the conversation.
 */
/**
 * The job under `j` stopped on its person and nothing else already says so: it
 * waits for them, its turn (for a conversation) says it needs them, and no open
 * question or approval tells of it as a decision. True for as long as the stop
 * lasts, however long ago it began.
 */
const STOPPED_ON_PERSON = sql`j.audience = 'principal'
  and j.experience_parent_id is null
  and j.state = 'waiting_for_input'
  -- A conversation that finished waits for the next message; its turn says done.
  and (j.kind <> 'chat' or exists (select 1 from experience_turn t
    where t.id = j.current_turn_id and t.status = 'needs_you'))
  and not exists (select 1 from question q where q.job_id = j.id and q.state = 'open')
  and not exists (select 1 from approval a join action ac on ac.id = a.action_id
    where ac.job_id = j.id and a.decided_at is null)`;

function pageOf(alias: ReturnType<typeof sql>) {
  return sql`case ${alias}.kind
      when 'run' then '/#/runs/' || ${alias}.id
      when 'run_step' then '/#/runs/' || coalesce((select r.parent_run_id from run_state r
        where r.job_id = ${alias}.id), ${alias}.id)
      else '/#/chat/' || ${alias}.id end`;
}

export class PushService {
  /** When old pushes were last cleared; the first pass of a process clears them. */
  private sweptAt = 0;

  constructor(
    readonly db: Database,
    readonly config: PushConfig,
  ) {}

  get enabled(): boolean {
    return this.config.keys !== null;
  }

  publicKey(): string | null {
    return this.config.keys?.publicKey ?? null;
  }

  async subscribe(principalId: string, input: PushSubscriptionRequest) {
    if (!this.enabled)
      throw new ServiceError('push_not_configured', 'Push is not configured here.', 503);
    if (!allowedEndpoint(input.endpoint, this.config.extraOrigins))
      throw new ServiceError(
        'push_endpoint_refused',
        'That is not a push service this installation sends to.',
        400,
      );
    if (!(await subscriptionKeysUsable(input.keys)))
      throw new ServiceError(
        'push_keys_invalid',
        'Those keys are not ones a browser subscribes with.',
        400,
      );
    // One endpoint is one browser. Signing in as someone else on it moves it to them.
    const [row] = await this.db
      .insert(pushSubscription)
      .values({
        id: newId('psub'),
        principalId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        deviceLabel: input.device_label,
      })
      .onConflictDoUpdate({
        target: pushSubscription.endpoint,
        set: {
          principalId,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          deviceLabel: input.device_label,
        },
      })
      .returning();
    if (!row) throw new Error('subscription insert lost');
    return view(row);
  }

  async list(principalId: string) {
    const rows = await this.db
      .select()
      .from(pushSubscription)
      .where(eq(pushSubscription.principalId, principalId))
      .orderBy(asc(pushSubscription.createdAt));
    return rows.map(view);
  }

  /** Only the person's own device: another person's id is not found, not refused. */
  async remove(principalId: string, id: string) {
    const [row] = await this.db
      .delete(pushSubscription)
      .where(and(eq(pushSubscription.id, id), eq(pushSubscription.principalId, principalId)))
      .returning();
    if (!row) throw new ServiceError('not_found', 'No such device.', 404);
    // With no device left, what was waiting has nowhere to go.
    const left = await this.list(principalId);
    if (left.length === 0) await this.dropWaiting(principalId);
    return view(row);
  }

  private async dayOf(principalId: string): Promise<DayWindow> {
    const [row] = await this.db
      .select({
        start: experienceProfile.dayStart,
        end: experienceProfile.dayEnd,
        timeZone: experienceProfile.timeZone,
      })
      .from(experienceProfile)
      .innerJoin(space, eq(space.id, experienceProfile.spaceId))
      .where(and(eq(space.ownerPrincipalId, principalId), eq(space.kind, 'personal')))
      .limit(1);
    return row ?? { start: '08:00', end: '22:00', timeZone: 'UTC' };
  }

  private async pacingOf(principalId: string) {
    const [row] = await this.db
      .select()
      .from(pushSetting)
      .where(eq(pushSetting.principalId, principalId));
    return row ?? { principalId, ...DEFAULT_SETTINGS };
  }

  async settings(principalId: string): Promise<PushSettings> {
    const [row, day] = await Promise.all([this.pacingOf(principalId), this.dayOf(principalId)]);
    return {
      decisions: row.decisions,
      settled: row.settled,
      weekly_summary: row.weeklySummary,
      daily_cap: row.dailyCap,
      batch_minutes: row.batchMinutes,
      // Quiet is the rest of the day: from the day's end until its start.
      quiet_hours: { from: day.end, until: day.start, time_zone: day.timeZone },
    };
  }

  async updateSettings(principalId: string, patch: z.infer<typeof pushSettingsUpdate>) {
    const current = await this.pacingOf(principalId);
    const next = {
      principalId,
      decisions: patch.decisions ?? current.decisions,
      settled: patch.settled ?? current.settled,
      weeklySummary: patch.weekly_summary ?? current.weeklySummary,
      dailyCap: patch.daily_cap ?? current.dailyCap,
      batchMinutes: patch.batch_minutes ?? current.batchMinutes,
    };
    await this.db
      .insert(pushSetting)
      .values(next)
      .onConflictDoUpdate({ target: pushSetting.principalId, set: next });
    // A kind turned off stops what of it was still waiting.
    const off: IntentKind[] = [
      ...(next.decisions ? [] : (['decision', 'needs_you'] as const)),
      ...(next.settled ? [] : (['settled', 'progress', 'done', 'reminder'] as const)),
      ...(next.weeklySummary ? [] : (['weekly'] as const)),
    ];
    if (off.length) await this.dropWaiting(principalId, off);
    return this.settings(principalId);
  }

  private async dropWaiting(principalId: string, kinds?: IntentKind[]) {
    await this.db
      .update(pushIntent)
      .set({ droppedAt: new Date() })
      .where(
        and(
          eq(pushIntent.principalId, principalId),
          isNull(pushIntent.sentAt),
          isNull(pushIntent.droppedAt),
          kinds ? inArray(pushIntent.kind, kinds) : undefined,
        ),
      );
  }

  /** People with at least one device, and when their first one subscribed. */
  private async subscribers(): Promise<Array<{ principalId: string; since: Date }>> {
    const rows = await this.db
      .select({
        principalId: pushSubscription.principalId,
        since: sql<Date>`min(${pushSubscription.createdAt})`.mapWith((v) => new Date(v)),
      })
      .from(pushSubscription)
      .groupBy(pushSubscription.principalId);
    return rows;
  }

  /**
   * Open approvals and questions become decision intents once, and one that was
   * decided before it went out is dropped instead of sent.
   */
  async collectDecisions(principalId: string, since: Date): Promise<void> {
    const pacing = await this.pacingOf(principalId);
    if (!pacing.decisions) return;
    const open = (await this.db.execute(sql`
      select 'approval:' || a.id as key, j.id as job_id, j.title as title,
             'Because it can’t go on until you decide.' as because, a.requested_at as at,
             ${pageOf(sql`j`)} as url
      from approval a
      join action ac on ac.id = a.action_id
      join job j on j.id = ac.job_id
      where a.decided_at is null
        and (a.expires_at is null or a.expires_at > now())
        and j.principal_id = ${principalId}
        and a.requested_at >= ${since.toISOString()}::timestamptz
      union all
      select 'question:' || q.id, j.id, q.text,
             coalesce(q.why,
                      -- A handle such as attempt:… names a record, not a reason a person reads.
                      case when q.because->>0 !~ '^[a-z]+:[A-Za-z0-9]'
                        then 'Because ' || lower(left(q.because->>0, 1)) || substr(q.because->>0, 2) end,
                      'Because it asked you something only you can answer.'),
             q.created_at, ${pageOf(sql`j`)}
      from question q
      join job j on j.id = q.job_id
      where q.state = 'open' and j.principal_id = ${principalId} and q.created_at >= ${since.toISOString()}::timestamptz
      union all
      ${roomDecisions(principalId, since)}
    `)) as unknown as Array<{
      key: string;
      job_id: string;
      title: string;
      because: string;
      url: string;
    }>;
    for (const row of open) {
      await this.db
        .insert(pushIntent)
        .values({
          id: newId('pint'),
          principalId,
          kind: 'decision',
          title: 'One decision is waiting',
          body: clip(row.title, 300),
          because: clip(row.because.replace(/^Because because /i, 'Because '), 200),
          url: row.url,
          dedupKey: `decision:${row.key}`,
        })
        .onConflictDoNothing({ target: pushIntent.dedupKey });
    }
    // Decided while it waited: nothing to tell any more.
    const openKeys = open.map((row) => `decision:${row.key}`);
    await this.db
      .update(pushIntent)
      .set({ droppedAt: new Date() })
      .where(
        and(
          eq(pushIntent.principalId, principalId),
          eq(pushIntent.kind, 'decision'),
          isNull(pushIntent.sentAt),
          isNull(pushIntent.droppedAt),
          openKeys.length
            ? sql`${pushIntent.dedupKey} not in (${sql.join(
                openKeys.map((key) => sql`${key}`),
                sql`, `,
              )})`
            : undefined,
        ),
      );
  }

  /** A client of this person is in front of them now. */
  async focus(principalId: string): Promise<Date> {
    const [row] = await this.db
      .insert(clientFocus)
      .values({ principalId, focusedAt: sql`now()` })
      .onConflictDoUpdate({ target: clientFocus.principalId, set: { focusedAt: sql`now()` } })
      .returning({ focusedAt: clientFocus.focusedAt });
    if (!row) throw new Error('focus upsert lost');
    return row.focusedAt;
  }

  /**
   * Changes of state worth a push, read from the jobs and turns themselves.
   *
   * - `needs_you`: a conversation or job of this person stopped on them (a
   *   hand-off, a deliverable it could not prove) and no open approval or
   *   question already says so: those are decisions, pushed once by
   *   `collectDecisions`. A conversation resting on a reminder's timer, or one
   *   that finished and only waits for the next message, is not stopped.
   * - `done`: a conversation's turn finished with an answer while no client of
   *   the person had focus. Long work is told by its own run reports.
   * - `reminder`: a turn the person timed finished with an answer: a
   *   conversation's own timer or schedule coming due, or a routine's scheduled
   *   run. It goes out at that time, whatever the hour, and no throttle holds it
   *   back. An open window does not count as seeing it: a tab left visible on
   *   another screen would otherwise swallow the alert.
   *
   * One per change of state, by its dedup key. Within the throttle window a
   * second change in the same conversation, of the same kind, is recorded as
   * dropped, so it is never reconsidered and never sent. A `needs_you` whose
   * job moved on, or a `done` the person has since looked at, is dropped
   * before it goes out.
   */
  async collectStatus(principalId: string, subscribedSince: Date, now: Date): Promise<void> {
    const pacing = await this.pacingOf(principalId);
    const since = new Date(
      Math.max(subscribedSince.getTime(), now.getTime() - STATUS_LOOKBACK_MS),
    ).toISOString();
    const candidates: Array<{
      kind: IntentKind;
      key: string;
      job: string;
      title: string;
      body: string;
      because: string;
      url: string;
    }> = [];
    if (pacing.decisions) {
      const stopped = (await this.db.execute(sql`
        select j.id as job_id, j.title, j.state_version as version,
               coalesce(nullif(trim(j.wait->>'question'), ''), 'It stopped and is waiting for you.') as reason,
               ${pageOf(sql`j`)} as url
        from job j
        where j.principal_id = ${principalId}
          and ${STOPPED_ON_PERSON}
          and j.updated_at >= ${since}::timestamptz
        order by j.updated_at
      `)) as unknown as Array<{
        job_id: string;
        title: string;
        version: number;
        reason: string;
        url: string;
      }>;
      for (const row of stopped)
        candidates.push({
          kind: 'needs_you',
          key: `status:needs_you:${row.job_id}:${row.version}`,
          job: row.job_id,
          title: clip(row.title.trim() || 'A conversation needs you', 120),
          body: clip(row.reason, 300),
          because: 'Because it can’t go on without you.',
          url: row.url,
        });
      // Moved on while the push waited: nothing to tell any more. A stop that
      // still holds keeps its push, however old it is: only the job settles it.
      await this.db.execute(sql`update push_intent p set dropped_at = now()
        where p.principal_id = ${principalId} and p.kind = 'needs_you'
          and p.sent_at is null and p.dropped_at is null
          and not exists (select 1 from job j
            where p.dedup_key = 'status:needs_you:' || j.id || ':' || j.state_version
              and ${STOPPED_ON_PERSON})`);
    }
    if (pacing.settled) {
      // A turn its own timer or schedule opened (see jobs/wake-turn.ts), or a routine's run.
      const timed = sql`((j.kind = 'chat' and starts_with(t.submission_id, 'wake:'))
        or (j.kind = 'routine' and starts_with(t.submission_id, 'routine:')))`;
      const answered = (await this.db.execute(sql`
        select t.id as turn_id, j.id as job_id, j.kind, j.title, t.answer,
               ${timed} as timed,
               ${pageOf(sql`j`)} as url
        from experience_turn t
        join job j on j.id = t.job_id
        where j.principal_id = ${principalId}
          and j.kind in ('chat', 'routine')
          and j.audience = 'principal'
          and j.experience_parent_id is null
          and t.status = 'done'
          and t.finished_at >= ${since}::timestamptz
          and length(trim(t.answer)) > 0
          -- A window that is open is not a person looking: what they timed still reaches them.
          and (${timed} or not exists (select 1 from client_focus f
            where f.principal_id = ${principalId}
              and f.focused_at >= t.finished_at - make_interval(mins => ${FOCUS_GRACE_MINUTES})))
        order by t.finished_at
      `)) as unknown as Array<{
        turn_id: string;
        job_id: string;
        kind: string;
        title: string;
        answer: string;
        timed: boolean;
        url: string;
      }>;
      for (const row of answered) {
        // What the person timed comes due as a reminder; any other answer is news Melete tells.
        const kind: IntentKind = row.timed ? 'reminder' : 'done';
        candidates.push({
          kind,
          key: `status:${kind}:${row.job_id}:${row.turn_id}`,
          job: row.job_id,
          title: clip(row.title.trim() || 'Your answer is ready', 120),
          body: answerPreview(row.answer),
          because: row.timed
            ? row.kind === 'routine'
              ? 'Because your routine ran at the time you set.'
              : 'Because you asked for this at this time.'
            : 'Because it finished while you were away.',
          url: row.url,
        });
      }
      // Looked at since: the person has seen it.
      await this.db.execute(sql`update push_intent p set dropped_at = now()
        from client_focus f
        where p.principal_id = ${principalId} and p.kind = 'done'
          and p.sent_at is null and p.dropped_at is null
          and f.principal_id = p.principal_id and f.focused_at >= p.created_at`);
    }
    for (const row of candidates) {
      const prefix = `status:${row.kind}:${row.job}:`;
      await this.db.execute(sql`
        insert into push_intent (id, principal_id, kind, title, body, because, url, dedup_key, urgency, dropped_at)
        values (${newId('pint')}, ${principalId}, ${row.kind}, ${row.title}, ${row.body}, ${row.because},
          ${row.url}, ${row.key}, 'soon',
          case when ${row.kind} <> 'reminder' and exists (select 1 from push_intent p
            where p.principal_id = ${principalId} and p.kind = ${row.kind}
              and starts_with(p.dedup_key, ${prefix}) and p.dropped_at is null
              and p.created_at > now() - make_interval(mins => ${STATUS_THROTTLE_MINUTES}))
          then now() end)
        on conflict (dedup_key) do nothing`);
    }
  }

  /**
   * Once a week, on the person's Monday, what came back: chases settled and
   * replies received in the seven days before. A quiet week says nothing.
   */
  async collectWeekly(principalId: string, now: Date): Promise<void> {
    const pacing = await this.pacingOf(principalId);
    if (!pacing.weeklySummary) return;
    const day = await this.dayOf(principalId);
    const local = localTime(now, day.timeZone);
    if (local.weekday !== 1) return;
    // Already made today: every later pass on this Monday stops here, before the counts.
    const dedupKey = `weekly:${principalId}:${local.day}`;
    const [made] = await this.db
      .select({ id: pushIntent.id })
      .from(pushIntent)
      .where(eq(pushIntent.dedupKey, dedupKey))
      .limit(1);
    if (made) return;
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const [counts] = (await this.db.execute(sql`
      select
        (select count(*) from ledger_item
          where principal_id = ${principalId} and status = 'settled'
            and settled_at >= ${weekAgo.toISOString()}::timestamptz)::int as settled,
        (select count(*) from event e
          join connection c on c.id = e.payload->>'connection_id'
          join space s on s.id = c.space_id
          where e.type = 'notice' and e.payload->>'kind' = 'connector_event'
            and e.payload->>'event_name' = 'mail.new'
            and s.owner_principal_id = ${principalId}
            and e.created_at >= ${weekAgo.toISOString()}::timestamptz)::int as replies
    `)) as unknown as Array<{ settled: number; replies: number }>;
    const settled = counts?.settled ?? 0;
    const replies = counts?.replies ?? 0;
    if (settled === 0 && replies === 0) return;
    const parts = [
      settled ? `${settled} settled` : null,
      replies ? `${replies} ${replies === 1 ? 'reply' : 'replies'} received` : null,
    ].filter(Boolean);
    await this.db
      .insert(pushIntent)
      .values({
        id: newId('pint'),
        principalId,
        kind: 'weekly',
        title: 'What came back this week',
        body: parts.join(', '),
        because: 'Because you get a summary each week. You can turn it off in Settings.',
        url: '/#/companies',
        dedupKey,
      })
      .onConflictDoNothing({ target: pushIntent.dedupKey });
  }

  /**
   * Pushes this person has had today, in their own day, in each lane. A batch
   * counts in the lane it actually went out in, which may be below the one its
   * intents asked for: what spilled past a lane's cap counts against the
   * lane that took it, so no lane's cap can be stepped round.
   */
  private async sentToday(principalId: string, day: DayWindow, now: Date): Promise<SentToday> {
    const today = localTime(now, day.timeZone).day;
    const rows = await this.db
      .selectDistinct({
        batchId: pushIntent.batchId,
        sentAt: pushIntent.sentAt,
        lane: pushIntent.sentLane,
      })
      .from(pushIntent)
      .where(
        and(
          eq(pushIntent.principalId, principalId),
          gte(pushIntent.sentAt, new Date(now.getTime() - 36 * 3600_000)),
        ),
      );
    const rank = { normal: 0, soon: 1, urgent: 2 } as const;
    const lanes = new Map<string, keyof SentToday>();
    for (const row of rows) {
      if (!row.sentAt || !row.batchId || localTime(row.sentAt, day.timeZone).day !== today)
        continue;
      // A reminder the person timed counts against no cap.
      if (row.lane === ON_TIME_LANE) continue;
      // Pushes sent before lanes were recorded went out in the normal lane.
      const lane = (row.lane && row.lane in rank ? row.lane : 'normal') as keyof SentToday;
      const before = lanes.get(row.batchId);
      if (!before || rank[lane] > rank[before]) lanes.set(row.batchId, lane);
    }
    const counted: SentToday = { normal: 0, soon: 0, urgent: 0 };
    for (const lane of lanes.values()) counted[lane] += 1;
    return counted;
  }

  /** One pass for one person: send what the policy allows, to each of their devices. */
  async dispatch(principalId: string, now: Date): Promise<'sent' | string> {
    if (!this.config.keys) return 'not_configured';
    const pacing = await this.pacingOf(principalId);
    // Only the kinds turned on, whatever was recorded around the moment one went off.
    // What Melete noticed has no switch of its own: it is paced by its urgency.
    const on: IntentKind[] = [
      ...(pacing.decisions ? (['decision', 'needs_you'] as const) : []),
      ...(pacing.settled ? (['settled', 'progress', 'done', 'reminder'] as const) : []),
      ...(pacing.weeklySummary ? (['weekly'] as const) : []),
      'situation',
    ];
    // A situation that was resolved, dismissed or removed has nothing left to say.
    await this.db.execute(sql`update push_intent p set dropped_at = now()
      where p.principal_id = ${principalId} and p.kind = 'situation'
        and p.sent_at is null and p.dropped_at is null
        and not exists (select 1 from situation x where x.id = p.situation_id
          and x.state in ('open', 'routed'))`);
    const waiting = on.length
      ? await this.db
          .select()
          .from(pushIntent)
          .where(
            and(
              eq(pushIntent.principalId, principalId),
              isNull(pushIntent.sentAt),
              isNull(pushIntent.droppedAt),
              inArray(pushIntent.kind, on),
            ),
          )
      : [];
    const day = await this.dayOf(principalId);
    const plan = planPush({
      waiting: waiting.map(
        (row): Waiting => ({
          id: row.id,
          kind: row.kind as IntentKind,
          title: row.title,
          body: row.body,
          because: row.because,
          url: row.url,
          createdAt: row.createdAt,
          urgency: row.urgency as Waiting['urgency'],
          personSet: row.personSet,
          ...(row.situationId ? { ack: `/situations/${row.situationId}/ack` } : {}),
        }),
      ),
      day,
      pacing,
      sentToday: await this.sentToday(principalId, day, now),
      now,
    });
    if ('hold' in plan) return plan.hold;
    const payload = pushPayload.parse(plan.send);
    const devices = await this.db
      .select()
      .from(pushSubscription)
      .where(eq(pushSubscription.principalId, principalId));
    const subject = this.config.subject ?? (await this.defaultSubject());
    const outcomes: PushOutcome[] = [];
    for (const device of devices) {
      const outcome = await sendPush(
        { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
        payload,
        { keys: this.config.keys, subject },
        {
          urgency: payload.tag === 'decision' || plan.urgency !== 'normal' ? 'high' : 'normal',
          ...(this.config.fetcher ? { fetcher: this.config.fetcher } : {}),
        },
      );
      outcomes.push(outcome);
      if (outcome === 'gone')
        await this.db.delete(pushSubscription).where(eq(pushSubscription.id, device.id));
      if (outcome === 'sent')
        await this.db
          .update(pushSubscription)
          .set({ lastUsedAt: now })
          .where(eq(pushSubscription.id, device.id));
    }
    // Nothing reached a device: it waits for the next pass rather than being lost.
    if (!outcomes.includes('sent')) return 'failed';
    await this.db
      .update(pushIntent)
      .set({
        sentAt: now,
        batchId: newId('pbat'),
        sentLane: plan.onTime ? ON_TIME_LANE : plan.urgency,
      })
      .where(inArray(pushIntent.id, plan.ids));
    return 'sent';
  }

  /** `mailto:` the installation owner, when the operator named no subject. */
  private async defaultSubject(): Promise<string> {
    const [row] = await this.db.select({ email: owner.email }).from(owner).limit(1);
    return `mailto:${row?.email ?? 'owner@localhost'}`;
  }

  /**
   * Clears pushes that went out, were dropped, or never went, once they are
   * older than the keeping period. A decision still open, or a situation still
   * open, keeps its row: that row is what says it was already told, and without
   * it the same news would be told again. So does a stop still waiting on its
   * person.
   */
  async sweep(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - INTENT_KEEP_MS).toISOString();
    const gone = (await this.db.execute(sql`delete from push_intent p
      where coalesce(p.sent_at, p.dropped_at, p.created_at) < ${before}::timestamptz
        and not (p.kind = 'decision' and split_part(p.dedup_key, ':', 2) = 'approval'
          and exists (select 1 from approval a where a.id = split_part(p.dedup_key, ':', 3)
            and a.decided_at is null and (a.expires_at is null or a.expires_at > now())))
        and not (p.kind = 'decision' and split_part(p.dedup_key, ':', 2) = 'question'
          and exists (select 1 from question q where q.id = split_part(p.dedup_key, ':', 3)
            and q.state = 'open'))
        and not (p.situation_id is not null and exists (select 1 from situation x
          where x.id = p.situation_id and x.state in ('open', 'routed')))
        and not (p.kind = 'needs_you' and exists (select 1 from job j
          where p.dedup_key = 'status:needs_you:' || j.id || ':' || j.state_version
            and ${STOPPED_ON_PERSON}))
      returning p.id`)) as unknown as Array<{ id: string }>;
    return gone.length;
  }

  /** One pass for everyone with a device. One person's failure is theirs alone. */
  async runOnce(now: Date = new Date()): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    // Rides on this pass rather than a timer of its own, at most once an hour.
    if (now.getTime() - this.sweptAt >= INTENT_SWEEP_EVERY_MS) {
      this.sweptAt = now.getTime();
      try {
        await this.sweep(now);
      } catch (error) {
        process.stderr.write(
          `push: sweep_failed ${error instanceof Error ? error.name : 'error'}\n`,
        );
      }
    }
    for (const { principalId, since } of await this.subscribers()) {
      try {
        await this.collectDecisions(principalId, since);
        await this.collectStatus(principalId, since, now);
        await this.collectWeekly(principalId, now);
        results[principalId] = await this.dispatch(principalId, now);
      } catch (error) {
        results[principalId] = 'error';
        process.stderr.write(
          `push: dispatch_failed_for_one ${error instanceof Error ? error.name : 'error'}\n`,
        );
      }
    }
    return results;
  }
}

/**
 * Runs a pass once a minute on the service's own scheduling, pg-boss, like the
 * reply poller. There is no timer of its own.
 */
export class PushDispatcher {
  private started = false;

  constructor(
    readonly push: PushService,
    readonly boss: PgBoss,
  ) {}

  async start(): Promise<void> {
    if (this.started || !this.push.enabled) return;
    await workQuiet(
      this.boss,
      QUEUES.pushDispatch,
      { batchSize: 1, pollingIntervalSeconds: 1 },
      async () => {
        try {
          await this.push.runOnce();
        } catch (error) {
          process.stderr.write(
            `push: dispatch_failed ${error instanceof Error ? error.name : 'error'}\n`,
          );
        }
      },
    );
    await this.boss.schedule(QUEUES.pushDispatch, '* * * * *');
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.started) await this.boss.offWork(QUEUES.pushDispatch, { wait: false });
    this.started = false;
  }
}

/** Read the service's push settings from its environment. */
export function pushConfig(env: {
  MELETE_VAPID_PUBLIC_KEY?: string | undefined;
  MELETE_VAPID_PRIVATE_KEY?: string | undefined;
  MELETE_VAPID_SUBJECT?: string | undefined;
  MELETE_PUSH_EXTRA_ORIGINS?: string | undefined;
}): PushConfig {
  const keys =
    env.MELETE_VAPID_PUBLIC_KEY && env.MELETE_VAPID_PRIVATE_KEY
      ? { publicKey: env.MELETE_VAPID_PUBLIC_KEY, privateKey: env.MELETE_VAPID_PRIVATE_KEY }
      : null;
  return {
    keys,
    subject: env.MELETE_VAPID_SUBJECT ?? null,
    extraOrigins: (env.MELETE_PUSH_EXTRA_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map((origin) => new URL(origin).origin),
  };
}
