/**
 * Situations and clocks: noticing what may need the person, at the right time.
 *
 * Three ways in, all deterministic, none calling a model:
 *
 * 1. **Observations.** `observe` runs inside the transaction that delivers a
 *    connector event. A meeting that moved or was cancelled within a day
 *    raises `meeting.changed`; new mail that answers a message the person is
 *    waiting on settles that wait.
 * 2. **Calendar state.** After each calendar read, `afterCalendarRead` moves
 *    the clocks that follow a meeting's time, clears those whose meeting was
 *    cancelled, and looks for meetings that overlap (`meeting.conflict`).
 * 3. **Clocks.** `sweep` fires the clocks that are due. A clock reads its
 *    subject again first, from its source when it can, and settles quietly
 *    when what it guards is already done. Only a deadline still unmet raises
 *    `deadline.at_risk`; only `reply.overdue`'s clock raises that.
 *
 * Properties it keeps:
 *
 * - **One live situation per key.** A second sighting adds to it.
 * - **Fires once.** A clock moves from `checking` to `fired` in the
 *   transaction that raises its situation, and the situation's key names the
 *   deadline, so two sweeps at once raise one.
 * - **Never on stale state.** A clock whose subject moved while it was being
 *   checked goes back to waiting at the new time; one whose fresh read fails
 *   is tried again and, if its time passes unread, is marked missed rather
 *   than raised.
 * - **Urgent only by the person.** A situation is urgent only when it comes
 *   from a deadline the person set or accepted; the database refuses any
 *   other urgent row.
 * - **Who hears what.** A situation is for one person: the owner of the
 *   account it came from (a room's accounts raise none), or whoever set the
 *   deadline. It reaches work only in the same space, for the same person,
 *   and only work the account serves.
 */
import { createHash } from 'node:crypto';
import {
  evaluateWatch,
  isTerminal,
  type JsonObject,
  jobState,
  LIVE_SITUATION_STATES,
  producesEvent,
  SITUATION_KINDS,
  type SituationView,
  situationEventName,
  type Urgency,
  type WatchPredicate,
  waitSpec,
  watchPredicate,
  watchPredicateProblem,
} from '@melete/contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { space, trigger } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import { jobMayUseConnection } from '../jobs/scopes.ts';
import type { JobService } from '../jobs/service.ts';
import type { TriggerService } from '../jobs/triggers.ts';
import type { Occurrence, SignalSource } from '../signals/types.ts';
import {
  type Awaited,
  answers,
  conflictReason,
  type Finding,
  higher,
  type KeptMeeting,
  meetingChange,
  meetingConflicts,
  situationKey,
  spokenTime,
  urgencyFor,
} from './detectors.ts';
import { clock, situation } from './schema.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How often clocks are swept; clocks due sooner than this are also timed in-process. */
export const SWEEP_SECONDS = 60;
/** A check holds its clock this long; one held longer is checked again. */
export const CHECK_SECONDS = 120;
/** A fresh read that fails is tried again after this, while there is time. */
export const RETRY_SECONDS = 60;
/** A clock checked this late, after its due time, is missed rather than raised. */
export const LATE_MS = 15 * MINUTE;
/** Mail must have been read since a reply clock was set before its absence means anything. */
export const MAX_REPLY_TRIES = 12;
/** One situation wakes one piece of work at most this often; later ones wait for its next wake. */
export const WAKE_SPACING_MS = 5 * MINUTE;
/** How far ahead a commitment's due date is watched. */
export const COMMITMENT_HORIZON_MS = 14 * DAY;
/** How long before a commitment is due Melete looks. */
export const COMMITMENT_LEAD_SECONDS = 24 * 3600;
/** How long after a message was sent its wait is looked at, and the longest it is watched. */
export const REPLY_AFTER_MS = 3 * DAY;
export const REPLY_WINDOW_MS = 30 * DAY;
/** Most entries `because` keeps as sightings fold in. */
const MAX_BECAUSE = 20;

const OPEN_LEDGER = ['found', 'handling', 'waiting'];
const ACCEPTED_LEDGER = ['handling', 'waiting'];
const OPEN_AWAITED = ['found', 'handling', 'waiting'];

/** What a deadline's clock checks at fire time. */
export type ClockCheck = {
  /** Still at risk while this holds against the subject's fresh fields. */
  at_risk: WatchPredicate;
  /** Read the subject at its source when the clock fires (the default). */
  fresh?: boolean;
  /** The highest urgency what it raises may have. */
  ceiling?: Urgency;
  /** For a reply clock: the wait it guards. */
  awaited?: Awaited & { id: string };
};

/** A connector that can read one subject's fields now, for a clock's fresh check. */
export type SubjectReader = {
  read(subject: { key: string; ref: string | null }): Promise<Record<string, unknown> | 'gone'>;
};

type Readable = { signals?: SignalSource; subjects?: SubjectReader } | undefined;

export type SituationDeps = {
  jobs: JobService;
  triggers: Pick<TriggerService, 'registerWait'>;
  /** The connectors this instance has open, for fresh reads. */
  connectors?: { get(id: string): Readable };
  /** Opens a connection this instance has not opened yet. */
  load?: (connectionId: string) => Promise<Readable>;
  /** Called after an urgent situation commits, to push it now rather than at the next pass. */
  notify?: (principalId: string) => Promise<unknown>;
  /** The built-in detectors; off leaves only deadlines that work sets. */
  detectors?: boolean;
  now?: () => number;
};

type SituationRow = typeof situation.$inferSelect;
type ClockRow = typeof clock.$inferSelect;

type Raise = Finding & {
  spaceId: string;
  principalId: string;
  connectionId: string | null;
  personSet: boolean;
  because: string[];
  origin: 'external_content' | 'person' | 'service';
  /** The work it reaches beside what is linked to its subject. */
  jobIds?: string[];
  /** What a push says it is because of. */
  pushBecause: string;
};

const rows = <T>(value: unknown) => value as T[];
const iso = (at: Date | string | null | undefined) =>
  at == null ? null : new Date(at).toISOString();

/** The person an account's situations are for: its space's owner. Null for a room's account. */
const OWNER_OF_CONNECTION = (connectionId: string) => sql`
  select c.id, c.space_id, c.provider, c.shared_use, c.status,
    coalesce(s.owner_principal_id, (select id from owner limit 1)) as principal_id,
    s.kind as space_kind
  from connection c join space s on s.id = c.space_id
  where c.id = ${connectionId} and s.removed_at is null`;

type ConnectionOwner = {
  id: string;
  space_id: string;
  provider: string;
  shared_use: string;
  status: string;
  principal_id: string | null;
  space_kind: string;
};

export function situationView(row: SituationRow): SituationView {
  return {
    id: row.id,
    kind: row.kind,
    subject_key: row.subjectKey,
    urgency: row.urgency as Urgency,
    person_set: row.personSet,
    title: row.title,
    reason: row.reason,
    because: row.because,
    state: row.state as SituationView['state'],
    deadline_at: iso(row.deadlineAt),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    fired_at: iso(row.firedAt),
    acked_at: iso(row.ackedAt),
  };
}

export class SituationService {
  private started = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAt = Number.POSITIVE_INFINITY;

  constructor(readonly deps: SituationDeps) {}

  get db(): Database {
    return this.deps.jobs.db;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  get detectors(): boolean {
    return this.deps.detectors !== false;
  }

  /** The person's own time zone, for the times a situation names. */
  private async timeZoneOf(tx: Transaction | Database, principalId: string): Promise<string> {
    const [row] = rows<{ time_zone: string }>(
      await tx.execute(sql`select p.time_zone from experience_profile p
        join space s on s.id = p.space_id
        where s.owner_principal_id = ${principalId} and s.kind = 'personal' limit 1`),
    );
    return row?.time_zone ?? 'UTC';
  }

  private async connectionOwner(
    tx: Transaction | Database,
    connectionId: string,
  ): Promise<ConnectionOwner | null> {
    const [row] = rows<ConnectionOwner>(await tx.execute(OWNER_OF_CONNECTION(connectionId)));
    // A room's account raises nothing here: who would hear it is the room's to say.
    if (!row || row.status !== 'active' || row.shared_use !== 'owner' || !row.principal_id)
      return null;
    return row;
  }

  // ------------------------------------------------------------------------
  // raising
  // ------------------------------------------------------------------------

  /**
   * Raise a situation, or fold this sighting into the live one with its key.
   * Returns the row and whether it is new or more urgent than before, which is
   * when the person is told and linked work is woken.
   */
  async raise(
    tx: Transaction,
    input: Raise,
  ): Promise<{ row: SituationRow; fresh: boolean; louder: boolean }> {
    // Nothing a detector reads on its own can make a situation urgent.
    const urgency: Urgency =
      input.urgency === 'urgent' && !input.personSet ? 'soon' : input.urgency;
    const key = situationKey(input.kind, input.subjectKey, input.window);
    const at = new Date(this.now());
    const inserted = rows<{ id: string }>(
      await tx.execute(sql`insert into situation (id, space_id, principal_id, kind, subject_key,
          connection_id, key, urgency, person_set, title, reason, because, evidence, origin,
          deadline_at, state, created_at, updated_at, expires_at)
        values (${newId('sit')}, ${input.spaceId}, ${input.principalId}, ${input.kind},
          ${input.subjectKey}, ${input.connectionId}, ${key}, ${urgency}, ${input.personSet},
          ${input.title}, ${input.reason}, ${JSON.stringify(input.because)}::jsonb,
          ${JSON.stringify(input.evidence)}::jsonb, ${input.origin},
          ${input.deadlineAt}::timestamptz, 'open', ${at.toISOString()}::timestamptz,
          ${at.toISOString()}::timestamptz, ${input.expiresAt}::timestamptz)
        on conflict (key) where state in ('open', 'routed') do nothing
        returning id`),
    );
    if (inserted[0]) {
      const [row] = await tx.select().from(situation).where(eq(situation.id, inserted[0].id));
      if (!row) throw new Error('situation insert lost');
      return { row, fresh: true, louder: false };
    }
    const [live] = await tx
      .select()
      .from(situation)
      .where(and(eq(situation.key, key), inArray(situation.state, [...LIVE_SITUATION_STATES])))
      .for('update');
    if (!live) throw new Error('live situation vanished under its key');
    const raised = higher(live.urgency as Urgency, urgency);
    const because = [...new Set([...live.because, ...input.because])].slice(-MAX_BECAUSE);
    const [row] = await tx
      .update(situation)
      .set({
        sightings: live.sightings + 1,
        because,
        evidence: input.evidence,
        title: input.title,
        reason: input.reason,
        urgency: raised,
        personSet: live.personSet || input.personSet,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : live.expiresAt,
        updatedAt: at,
      })
      .where(eq(situation.id, live.id))
      .returning();
    if (!row) throw new Error('situation update lost');
    return { row, fresh: false, louder: raised !== live.urgency };
  }

  /**
   * Tell the person, and hand it to linked work: a new situation, or one that
   * just became more urgent. A `normal` one waits on Home for the person to
   * look; `soon` and `urgent` ones go to their devices, paced by urgency.
   */
  private async attend(
    tx: Transaction,
    raised: { row: SituationRow; fresh: boolean; louder: boolean },
    input: Raise,
  ): Promise<boolean> {
    const { row } = raised;
    if (!raised.fresh && !raised.louder) return false;
    let told = false;
    if (row.urgency !== 'normal') {
      const made = rows<{ id: string }>(
        await tx.execute(sql`
          insert into push_intent (id, principal_id, kind, title, body, because, url, dedup_key,
            urgency, person_set, situation_id)
          select ${newId('pint')}, ${row.principalId}, 'situation', ${clip(row.title, 120)},
                 ${clip(row.reason, 300)}, ${clip(input.pushBecause, 200)}, '/#/',
                 ${`situation:${row.id}:${row.urgency}`}, ${row.urgency}, ${row.personSet}, ${row.id}
          where exists (select 1 from push_subscription s where s.principal_id = ${row.principalId})
          on conflict (dedup_key) do nothing
          returning id`),
      );
      told = made.length > 0;
    }
    const routed = raised.fresh ? await this.route(tx, row, input.jobIds ?? []) : [];
    if (told || routed.length)
      await tx
        .update(situation)
        .set({
          firedAt: new Date(this.now()),
          ...(routed.length
            ? { routedJobIds: [...new Set([...row.routedJobIds, ...routed])], state: 'routed' }
            : {}),
        })
        .where(eq(situation.id, row.id));
    return told && row.urgency === 'urgent';
  }

  /**
   * Hand a situation to the live work linked to its subject: in its space, for
   * its person, and served by its account. Work waiting on a trigger wakes
   * with it, at most once in five minutes; any other work reads it at its
   * next wake.
   */
  private async route(tx: Transaction, row: SituationRow, extra: string[]): Promise<string[]> {
    const linked = rows<{ job_id: string }>(
      await tx.execute(sql`select job_id from subject_link
        where subject_key = ${row.subjectKey} and space_id = ${row.spaceId}`),
    ).map((link) => link.job_id);
    const routed: string[] = [];
    const [parent] = await tx.select().from(space).where(eq(space.id, row.spaceId));
    for (const jobId of [...new Set([...linked, ...extra])].sort()) {
      const current = await this.deps.jobs.lock(tx, jobId);
      if (!current || current.spaceId !== row.spaceId) continue;
      if (isTerminal(jobState.parse(current.state))) continue;
      if ((current.principalId ?? row.principalId) !== row.principalId) continue;
      if (row.connectionId && !(await jobMayUseConnection(tx, jobId, row.connectionId))) continue;
      const event = {
        kind: 'operation_event',
        event_name: situationEventName(row.kind),
        policy_generation: parent?.policyGeneration ?? 0,
        // The meter reads which situation a wake was for from here.
        situation_id: row.id,
        payload: {
          situation_id: row.id,
          kind: row.kind,
          urgency: row.urgency,
          title: row.title,
          reason: row.reason,
          deadline_at: iso(row.deadlineAt),
          subject_key: row.subjectKey,
          evidence: row.evidence as JsonObject,
          origin: row.origin,
        },
      } satisfies JsonObject;
      const wait = waitSpec.safeParse(current.wait);
      const waitingOn =
        current.state === 'waiting_for_event_or_time' && wait.success && wait.data.kind === 'event'
          ? wait.data.trigger_id
          : null;
      const [recent] = rows<{ n: number }>(
        await tx.execute(sql`select count(*)::int as n from event
          where job_id = ${jobId} and type = 'notice'
            and payload->>'kind' = 'operation_event' and payload ? 'situation_id'
            and created_at > ${new Date(this.now() - WAKE_SPACING_MS).toISOString()}::timestamptz`),
      );
      const [registration] = waitingOn
        ? await tx.select().from(trigger).where(eq(trigger.id, waitingOn))
        : [];
      if (registration?.enabled && Number(recent?.n ?? 0) === 0) {
        await appendEvent(tx, {
          jobId,
          type: 'notice',
          payload: { ...event, trigger_id: registration.id },
          dedupKey: `${row.id}:${jobId}:situation`,
        });
        await this.deps.triggers.registerWait(tx, current);
      } else {
        // Read at its next wake, beside whatever wakes it.
        await appendEvent(tx, {
          jobId,
          type: 'notice',
          payload: {
            kind: 'trigger_event',
            trigger_id: null,
            event,
            because: [`situation:${row.id}`],
          },
          dedupKey: `${row.id}:${jobId}:situation`,
        });
      }
      routed.push(jobId);
    }
    return routed;
  }

  private async raiseAndAttend(tx: Transaction, input: Raise) {
    const raised = await this.raise(tx, input);
    const urgent = await this.attend(tx, raised, input);
    return { ...raised, urgent };
  }

  /** Close live situations: their subject stopped being a problem, or their moment passed. */
  private async settle(
    tx: Transaction,
    where: ReturnType<typeof sql>,
    state: 'resolved' | 'expired',
  ): Promise<number> {
    const closed = rows<{ id: string }>(
      await tx.execute(sql`update situation set state = ${state},
          resolved_at = ${new Date(this.now()).toISOString()}::timestamptz,
          updated_at = ${new Date(this.now()).toISOString()}::timestamptz
        where state in ('open', 'routed') and (${where})
        returning id`),
    );
    if (closed.length)
      await this.dropPushes(
        tx,
        closed.map((row) => row.id),
      );
    return closed.length;
  }

  /** What was still waiting to be pushed about these situations is not sent. */
  private async dropPushes(tx: Transaction | Database, ids: string[]) {
    if (!ids.length) return;
    await tx.execute(sql`update push_intent set dropped_at = now()
      where situation_id in ${sqlList(ids)} and sent_at is null and dropped_at is null`);
  }

  // ------------------------------------------------------------------------
  // observations
  // ------------------------------------------------------------------------

  /**
   * One observation, inside the transaction that delivered it: a meeting
   * that changed close to its time, or mail that answers a wait.
   */
  async observe(
    tx: Transaction,
    delivery: { connection_id: string; event_name: string; payload: Record<string, unknown> },
    seq: number,
  ): Promise<void> {
    if (!this.detectors) return;
    const name = delivery.event_name;
    const calendar = name === 'calendar.event.changed' || name === 'calendar.event.cancelled';
    if (!calendar && name !== 'mail.received') return;
    const owner = await this.connectionOwner(tx, delivery.connection_id);
    if (!owner?.principal_id) return;
    const principalId = owner.principal_id;
    if (calendar) {
      const zone = await this.timeZoneOf(tx, principalId);
      const found = meetingChange(name, delivery.payload, this.now(), zone);
      if (!found) return;
      await this.raiseAndAttend(tx, {
        ...found,
        spaceId: owner.space_id,
        principalId,
        connectionId: owner.id,
        personSet: false,
        because: [`event:${seq}`],
        origin: 'external_content',
        pushBecause: 'Because it changed within a day of the meeting.',
      });
      return;
    }
    // New mail: does it answer something the person is waiting on?
    const waiting = rows<{
      id: string;
      message_id: string;
      to_address: string;
      subject: string;
      sent_at: Date;
    }>(
      await tx.execute(sql`select id, message_id, to_address, subject, sent_at from awaited_reply
        where space_id = ${owner.space_id} and principal_id = ${principalId}
          and status in ${sqlList(OPEN_AWAITED)}
          and sent_at > ${new Date(this.now() - REPLY_WINDOW_MS).toISOString()}::timestamptz`),
    );
    for (const entry of waiting) {
      const awaited: Awaited = {
        messageId: entry.message_id,
        toAddress: entry.to_address,
        subject: entry.subject,
        sentAt: new Date(entry.sent_at).toISOString(),
      };
      if (!answers(awaited, delivery.payload)) continue;
      const subject = `awaited:${entry.id}`;
      await this.settle(
        tx,
        sql`kind = ${SITUATION_KINDS.replyOverdue} and subject_key = ${subject}`,
        'resolved',
      );
      await tx.execute(sql`update clock set state = 'met', note = ${'An answer came.'},
          updated_at = now()
        where rule = ${SITUATION_KINDS.replyOverdue} and subject_key = ${subject}
          and state in ('armed', 'checking')`);
    }
  }

  // ------------------------------------------------------------------------
  // calendar state
  // ------------------------------------------------------------------------

  /**
   * After a calendar read has kept its fields: move every clock that follows
   * a meeting's time, clear those whose meeting is gone or cancelled, and
   * look at the person's calendars for meetings that overlap.
   */
  async afterCalendarRead(connectionId: string): Promise<void> {
    const pendingUrgent: string[] = [];
    await this.deps.jobs.transaction(async (tx) => {
      const owner = await this.connectionOwner(tx, connectionId);
      // Clocks follow their subject whoever owns the account.
      await this.followSubjects(tx, connectionId);
      if (!owner?.principal_id || !this.detectors) return;
      const principalId = owner.principal_id;
      const calendars = rows<{ id: string; provider: string }>(
        await tx.execute(sql`select id, provider from connection
          where space_id = ${owner.space_id} and status = 'active' and shared_use = 'owner'`),
      ).filter((row) => producesEvent(row.provider, 'calendar.event.changed'));
      if (!calendars.length) return;
      const kept = rows<{ subject_key: string; connection_id: string; fields: KeptFields }>(
        await tx.execute(sql`select subject_key, connection_id, fields from subject_state
          where type = 'calendar_occurrence'
            and connection_id in ${sqlList(calendars.map((row) => row.id))}`),
      );
      const now = this.now();
      const meetings: KeptMeeting[] = kept.map((row) => ({
        subjectKey: row.subject_key,
        connectionId: row.connection_id,
        uid: String(row.fields.uid ?? ''),
        title: String(row.fields.title ?? ''),
        start: String(row.fields.start ?? ''),
        end: String(row.fields.end ?? ''),
        allDay: row.fields.all_day === true,
        status: String(row.fields.status ?? ''),
        attendees: Number(row.fields.attendees ?? 0) || 0,
      }));
      const conflicts = meetingConflicts(meetings, now);
      const zone = await this.timeZoneOf(tx, principalId);
      const current = new Set<string>();
      for (const conflict of conflicts) {
        current.add(conflict.subjectKey);
        const raised = await this.raiseAndAttend(tx, {
          ...conflict,
          reason: conflictReason(conflict, zone),
          spaceId: owner.space_id,
          principalId,
          // Two calendars may be involved; each meeting names its own.
          connectionId: null,
          personSet: false,
          because: conflict.pair.map((key) => `subject:${key}`),
          origin: 'external_content',
          pushBecause: 'Because two meetings on your calendar overlap.',
        });
        if (raised.urgent) pendingUrgent.push(principalId);
      }
      // An overlap that is no longer there is over: one meeting moved or was cancelled.
      await this.settle(
        tx,
        sql`kind = ${SITUATION_KINDS.meetingConflict} and space_id = ${owner.space_id}
          and principal_id = ${principalId}
          ${current.size ? sql`and subject_key not in ${sqlList([...current])}` : sql``}`,
        'resolved',
      );
    });
    await this.notifyAll(pendingUrgent);
  }

  /** Clocks that follow a meeting on this account: moved with it, or cleared when it is gone. */
  private async followSubjects(tx: Transaction, connectionId: string) {
    const following = await tx
      .select()
      .from(clock)
      .where(
        and(
          eq(clock.connectionId, connectionId),
          inArray(clock.state, ['armed']),
          sql`${clock.anchor} is not null`,
        ),
      )
      .for('update');
    for (const entry of following) {
      const [kept] = rows<{ fields: KeptFields; version: string }>(
        await tx.execute(sql`select fields, version from subject_state
          where subject_key = ${entry.subjectKey}`),
      );
      if (!kept || kept.fields.status === 'cancelled') {
        await tx
          .update(clock)
          .set({
            state: 'cleared',
            note: 'What it followed was cancelled or is gone.',
            updatedAt: new Date(this.now()),
          })
          .where(eq(clock.id, entry.id));
        continue;
      }
      const due = anchoredDue(kept.fields, entry.anchor);
      if (due === null || due === entry.dueAt.getTime()) continue;
      await tx
        .update(clock)
        .set({
          dueAt: new Date(due),
          fireAt: new Date(due - entry.leadSeconds * 1000),
          updatedAt: new Date(this.now()),
        })
        .where(eq(clock.id, entry.id));
      this.timeNext(due - entry.leadSeconds * 1000);
    }
  }

  // ------------------------------------------------------------------------
  // deadlines
  // ------------------------------------------------------------------------

  /**
   * Keep a deadline: at `due` less `lead`, look at the subject again and, if
   * it is still at risk, raise `deadline.at_risk`. One live deadline per
   * subject: setting it again moves it. A deadline that follows a meeting's
   * time (`anchor`) moves when the meeting moves and is cleared when it is
   * cancelled.
   */
  async setDeadline(input: {
    spaceId: string;
    principalId: string;
    subjectKey: string;
    connectionId?: string | null;
    subjectRef?: string | null;
    title: string;
    dueAt?: Date;
    anchor?: { field: string; offset_s: number } | null;
    leadSeconds: number;
    atRisk: WatchPredicate;
    fresh?: boolean;
    personSet: boolean;
    jobId?: string | null;
  }): Promise<ClockRow> {
    const atRisk = watchPredicate.parse(input.atRisk);
    const problem = watchPredicateProblem(atRisk, 'clock');
    if (problem) throw new ServiceError('invalid_predicate', problem, 400);
    if (!Number.isSafeInteger(input.leadSeconds) || input.leadSeconds < 0)
      throw new ServiceError('invalid_deadline', 'The lead is a whole number of seconds.', 400);
    const made = await this.deps.jobs.transaction(async (tx) => {
      let due = input.dueAt?.getTime() ?? null;
      if (input.anchor) {
        const [kept] = rows<{ fields: KeptFields }>(
          await tx.execute(sql`select fields from subject_state
            where subject_key = ${input.subjectKey} and space_id = ${input.spaceId}`),
        );
        due = kept ? anchoredDue(kept.fields, input.anchor) : null;
      }
      if (due === null || Number.isNaN(due))
        throw new ServiceError('invalid_deadline', 'The deadline has no time to keep.', 400);
      const fireAt = new Date(due - input.leadSeconds * 1000);
      const check: ClockCheck = { at_risk: atRisk, fresh: input.fresh ?? true };
      const values = {
        spaceId: input.spaceId,
        principalId: input.principalId,
        connectionId: input.connectionId ?? null,
        subjectRef: input.subjectRef ?? null,
        title: input.title,
        dueAt: new Date(due),
        leadSeconds: input.leadSeconds,
        fireAt,
        anchor: input.anchor ?? null,
        check: check as Record<string, unknown>,
        personSet: input.personSet,
        jobId: input.jobId ?? null,
        updatedAt: new Date(this.now()),
      };
      const [live] = await tx
        .select()
        .from(clock)
        .where(
          and(
            eq(clock.rule, SITUATION_KINDS.deadlineAtRisk),
            eq(clock.subjectKey, input.subjectKey),
            inArray(clock.state, ['armed', 'checking']),
          ),
        )
        .for('update');
      const [row] = live
        ? await tx
            .update(clock)
            .set({ ...values, state: 'armed', claimedUntil: null, tries: 0 })
            .where(eq(clock.id, live.id))
            .returning()
        : await tx
            .insert(clock)
            .values({
              id: newId('clk'),
              rule: SITUATION_KINDS.deadlineAtRisk,
              subjectKey: input.subjectKey,
              ...values,
            })
            .returning();
      if (!row) throw new Error('clock write lost');
      if (input.jobId) await this.link(tx, input.subjectKey, input.jobId, 'deadline');
      return row;
    });
    this.timeNext(made.fireAt.getTime());
    return made;
  }

  /** Name the work that cares about a subject, so a situation about it reaches that work. */
  async link(
    tx: Transaction,
    subjectKey: string,
    jobId: string,
    role: 'deadline' | 'watch' | 'handling',
  ): Promise<void> {
    await tx.execute(sql`insert into subject_link (subject_key, job_id, space_id, role)
      select ${subjectKey}, j.id, j.space_id, ${role} from job j where j.id = ${jobId}
      on conflict (subject_key, job_id) do nothing`);
  }

  // ------------------------------------------------------------------------
  // the sweep
  // ------------------------------------------------------------------------

  /** One pass: keep clocks for commitments and waits, fire what is due, let go of what is over. */
  async sweep(): Promise<{ fired: number; met: number; missed: number; deferred: number }> {
    if (this.detectors) await this.armDetectorClocks();
    await this.expire();
    const totals = { fired: 0, met: 0, missed: 0, deferred: 0 };
    for (;;) {
      const due = await this.claim();
      if (!due.length) break;
      for (const entry of due) {
        const outcome = await this.check(entry);
        totals[outcome] += 1;
      }
      if (due.length < 20) break;
    }
    await this.timeUpcoming();
    return totals;
  }

  /** Take the clocks that are due, and those a check left behind, so no other sweep checks them. */
  private async claim(): Promise<ClockRow[]> {
    const at = new Date(this.now()).toISOString();
    const until = new Date(this.now() + CHECK_SECONDS * 1000).toISOString();
    const claimed = rows<{ id: string }>(
      await this.db.execute(sql`update clock c set state = 'checking',
          claimed_until = ${until}::timestamptz, updated_at = ${at}::timestamptz
        from (
          select id from clock
          where (state = 'armed' and fire_at <= ${at}::timestamptz)
             or (state = 'checking' and claimed_until < ${at}::timestamptz)
          order by fire_at limit 20
          for update skip locked
        ) due
        where c.id = due.id
        returning c.id`),
    );
    if (!claimed.length) return [];
    return this.db
      .select()
      .from(clock)
      .where(
        inArray(
          clock.id,
          claimed.map((row) => row.id),
        ),
      );
  }

  /**
   * Check one due clock against what is true now. The read happens outside
   * any transaction; the outcome is written only if the clock is still the
   * one that was read for.
   */
  private async check(entry: ClockRow): Promise<'fired' | 'met' | 'missed' | 'deferred'> {
    const now = this.now();
    if (now > entry.fireAt.getTime() + LATE_MS && now > entry.dueAt.getTime())
      return this.settleClock(entry, 'missed', 'Melete could not look at this before it was due.');
    const check = entry.check as ClockCheck;
    const read = await this.readSubject(entry, check);
    if (read === 'retry') {
      const again = now + RETRY_SECONDS * 1000;
      const tries = entry.tries + 1;
      if (
        again >= entry.dueAt.getTime() ||
        (entry.rule === SITUATION_KINDS.replyOverdue && tries >= MAX_REPLY_TRIES)
      )
        return this.settleClock(
          entry,
          'missed',
          entry.rule === SITUATION_KINDS.replyOverdue
            ? 'The mailbox could not be read, so whether an answer came is not known.'
            : 'What this deadline is about could not be read before it was due.',
        );
      await this.db
        .update(clock)
        .set({ state: 'armed', fireAt: new Date(again), tries, claimedUntil: null })
        .where(and(eq(clock.id, entry.id), eq(clock.state, 'checking')));
      this.timeNext(again);
      return 'deferred';
    }
    if (read === 'gone')
      return this.settleClock(entry, 'cleared', 'What it was about no longer exists.');
    const atRisk = evaluateWatch(watchPredicate.parse(check.at_risk), read.fields, null, {
      now,
      seen: (kind, since) => read.seen(kind, since),
    });
    if (!atRisk) return this.settleClock(entry, 'met', 'It was done in time.');
    return this.fire(entry, check);
  }

  /** Settle a checked clock without raising anything, if it is still the clock that was checked. */
  private async settleClock(
    entry: ClockRow,
    state: 'met' | 'missed' | 'cleared',
    note: string,
  ): Promise<'met' | 'missed'> {
    await this.db
      .update(clock)
      .set({ state, note, claimedUntil: null, updatedAt: new Date(this.now()) })
      .where(
        and(eq(clock.id, entry.id), eq(clock.state, 'checking'), eq(clock.fireAt, entry.fireAt)),
      );
    return state === 'missed' ? 'missed' : 'met';
  }

  /**
   * The subject's fields as they are now: read at the source when the clock
   * asks for a fresh look and the source can be read; otherwise what Melete
   * keeps. `retry` when the source could not be read this time.
   */
  private async readSubject(
    entry: ClockRow,
    check: ClockCheck,
  ): Promise<
    | 'retry'
    | 'gone'
    | { fields: Record<string, unknown>; seen: (kind: string, since: number | null) => boolean }
  > {
    const none = () => false;
    if (entry.rule === SITUATION_KINDS.replyOverdue) return this.readWait(entry, check);
    if (entry.subjectKey.startsWith('ledger:')) {
      const [item] = rows<{ status: string; due_at: Date | null }>(
        await this.db.execute(sql`select status, due_at from ledger_item
          where id = ${entry.subjectKey.slice('ledger:'.length)}`),
      );
      if (!item) return 'gone';
      return { fields: { status: item.status, due_at: iso(item.due_at) }, seen: none };
    }
    const kept = async () => {
      const [row] = rows<{ fields: Record<string, unknown> }>(
        await this.db.execute(sql`select fields from subject_state
          where subject_key = ${entry.subjectKey}`),
      );
      return row?.fields ?? null;
    };
    if (check.fresh === false || !entry.connectionId) {
      const fields = await kept();
      return fields ? { fields, seen: none } : 'gone';
    }
    let source: Readable;
    try {
      source =
        this.deps.connectors?.get(entry.connectionId) ??
        (await this.deps.load?.(entry.connectionId));
    } catch {
      source = undefined;
    }
    try {
      if (source?.subjects) {
        const fields = await source.subjects.read({ key: entry.subjectKey, ref: entry.subjectRef });
        return fields === 'gone' ? 'gone' : { fields, seen: none };
      }
      if (source?.signals?.stream === 'calendar' && source.signals.confirm) {
        const fields = await kept();
        if (!fields) return 'gone';
        const found = await source.signals.confirm({
          uid: String(fields.uid ?? ''),
          occurrence: (fields.occurrence as string | null) ?? null,
          ref: entry.subjectRef ?? (fields.ref as string | null) ?? null,
        });
        if (found === 'gone') return 'gone';
        if (found === 'unknown') return 'retry';
        return { fields: { ...fields, ...occurrenceFields(found) }, seen: none };
      }
    } catch {
      return 'retry';
    }
    // Nothing here can read it fresh: it cannot be checked, so nothing is raised on it.
    return 'retry';
  }

  /**
   * A wait on a reply, as it is now: still open on the person's list, and
   * whether an answer was seen since the clock was set. It counts only once
   * the mailbox has been read since then, so silence means no answer rather
   * than nobody looking.
   */
  private async readWait(entry: ClockRow, check: ClockCheck) {
    const awaitedId = check.awaited?.id ?? entry.subjectKey.slice('awaited:'.length);
    const [wait] = rows<{ status: string }>(
      await this.db.execute(sql`select status from awaited_reply where id = ${awaitedId}`),
    );
    if (!wait) return 'gone' as const;
    const [read] = rows<{ n: number }>(
      await this.db.execute(sql`select count(*)::int as n from source_cursor sc
        join connection c on c.id = sc.connection_id
        where c.space_id = ${entry.spaceId} and c.status = 'active' and c.shared_use = 'owner'
          and sc.stream = 'mail' and sc.last_ok_at >= ${entry.createdAt.toISOString()}::timestamptz`),
    );
    if (!Number(read?.n ?? 0)) return 'retry' as const;
    return {
      fields: { status: wait.status },
      // `observe` settles the clock the moment an answer arrives, so by the
      // time it fires, any answer read since it was set has already met it.
      seen: () => false,
    };
  }

  /**
   * Raise what a due clock guards, once: the clock goes from `checking` to
   * `fired` in the same transaction, and only if nobody moved it meanwhile.
   */
  private async fire(entry: ClockRow, check: ClockCheck): Promise<'fired' | 'deferred'> {
    const pendingUrgent: string[] = [];
    const result = await this.deps.jobs.transaction(async (tx) => {
      const [current] = await tx.select().from(clock).where(eq(clock.id, entry.id)).for('update');
      // Moved, re-set or settled while it was read: the new time stands.
      if (
        !current ||
        current.state !== 'checking' ||
        current.fireAt.getTime() !== entry.fireAt.getTime() ||
        current.dueAt.getTime() !== entry.dueAt.getTime()
      ) {
        if (current?.state === 'checking')
          await tx
            .update(clock)
            .set({ state: 'armed', claimedUntil: null })
            .where(eq(clock.id, current.id));
        return 'deferred' as const;
      }
      const zone = await this.timeZoneOf(tx, current.principalId);
      const reply = current.rule === SITUATION_KINDS.replyOverdue;
      const due = current.dueAt.toISOString();
      const urgency = reply
        ? ('normal' as Urgency)
        : urgencyFor({
            personSet: current.personSet,
            leadSeconds: Math.max(0, Math.round((current.dueAt.getTime() - this.now()) / 1000)),
            ...(check.ceiling ? { ceiling: check.ceiling } : {}),
          });
      const raised = await this.raiseAndAttend(tx, {
        kind: reply ? SITUATION_KINDS.replyOverdue : SITUATION_KINDS.deadlineAtRisk,
        subjectKey: current.subjectKey,
        window: reply ? '' : due,
        urgency,
        title: current.title,
        reason: reply
          ? 'You asked for something, and nobody has answered yet.'
          : `Due ${spokenTime(due, zone)}, and it is not done yet.`,
        evidence: {
          due_at: due,
          checked_at: new Date(this.now()).toISOString(),
          fresh: check.fresh !== false,
        },
        deadlineAt: reply ? null : due,
        expiresAt: reply
          ? new Date(this.now() + REPLY_WINDOW_MS).toISOString()
          : new Date(current.dueAt.getTime() + HOUR).toISOString(),
        spaceId: current.spaceId,
        principalId: current.principalId,
        connectionId: current.connectionId,
        personSet: current.personSet,
        because: [`clock:${current.id}`],
        origin: current.personSet ? 'person' : 'service',
        jobIds: current.jobId ? [current.jobId] : [],
        pushBecause: current.personSet
          ? 'Because you asked Melete to keep this deadline.'
          : 'Because it has a due date.',
      });
      await tx
        .update(clock)
        .set({
          state: 'fired',
          situationId: raised.row.id,
          firedAt: new Date(this.now()),
          claimedUntil: null,
          updatedAt: new Date(this.now()),
        })
        .where(eq(clock.id, current.id));
      if (raised.urgent) pendingUrgent.push(current.principalId);
      return 'fired' as const;
    });
    await this.notifyAll(pendingUrgent);
    return result;
  }

  private async notifyAll(principals: string[]) {
    for (const principalId of new Set(principals)) {
      try {
        await this.deps.notify?.(principalId);
      } catch {
        process.stderr.write('situations: notify_failed\n');
      }
    }
  }

  /**
   * Clocks for what Melete already knows is due: a commitment with a due date
   * (urgent never; `soon` once the person took it up, Home only before), and
   * a message the person sent that is still waiting on an answer. Each gets
   * one clock; one already settled is not made again for the same due time.
   * A commitment settled or a wait answered on the person's list ends its
   * clock and its situation.
   */
  async armDetectorClocks(): Promise<void> {
    const now = this.now();
    await this.deps.jobs.transaction(async (tx) => {
      const items = rows<{
        id: string;
        space_id: string;
        principal_id: string;
        status: string;
        due_at: Date;
        due_date_only: boolean;
        job_id: string | null;
      }>(
        await tx.execute(sql`select li.id, li.space_id, li.principal_id, li.status, li.due_at,
            li.due_date_only, li.job_id
          from ledger_item li join space s on s.id = li.space_id and s.removed_at is null
          where li.due_at is not null and li.status in ${sqlList(OPEN_LEDGER)}
            and li.due_at > ${new Date(now).toISOString()}::timestamptz
            and li.due_at <= ${new Date(now + COMMITMENT_HORIZON_MS).toISOString()}::timestamptz
            and not exists (select 1 from clock k
              where k.rule = ${SITUATION_KINDS.deadlineAtRisk} and k.subject_key = 'ledger:' || li.id
                and (k.state in ('armed', 'checking') or k.due_at = li.due_at))
          limit 200`),
      );
      for (const item of items) {
        const accepted = ACCEPTED_LEDGER.includes(item.status);
        const due = new Date(item.due_at).getTime();
        const check: ClockCheck = {
          at_risk: watchPredicate.parse({
            all: [{ field: 'status', op: 'matches', value: `^(${OPEN_LEDGER.join('|')})$` }],
          }),
          fresh: true,
          ...(accepted ? {} : { ceiling: 'normal' as Urgency }),
        };
        await tx.insert(clock).values({
          id: newId('clk'),
          spaceId: item.space_id,
          principalId: item.principal_id,
          rule: SITUATION_KINDS.deadlineAtRisk,
          subjectKey: `ledger:${item.id}`,
          title: 'A commitment is due',
          dueAt: new Date(due),
          leadSeconds: COMMITMENT_LEAD_SECONDS,
          fireAt: new Date(Math.max(now, due - COMMITMENT_LEAD_SECONDS * 1000)),
          check: check as Record<string, unknown>,
          personSet: accepted,
          jobId: item.job_id,
        });
        if (item.job_id) await this.link(tx, `ledger:${item.id}`, item.job_id, 'handling');
      }
      // A commitment the person took up after its clock was set is now theirs.
      await tx.execute(sql`update clock k set person_set = true,
          "check" = k."check" - 'ceiling', updated_at = now()
        from ledger_item li
        where k.rule = ${SITUATION_KINDS.deadlineAtRisk} and k.subject_key = 'ledger:' || li.id
          and k.state = 'armed' and not k.person_set
          and li.status in ${sqlList(ACCEPTED_LEDGER)}`);
      // Settled or dropped: its clock and its situation end.
      await tx.execute(sql`update clock k set state = 'met', note = 'It was settled.',
          updated_at = now()
        from ledger_item li
        where k.subject_key = 'ledger:' || li.id and k.state = 'armed'
          and li.status not in ${sqlList(OPEN_LEDGER)}`);
      await this.settle(
        tx,
        sql`subject_key like 'ledger:%' and exists (select 1 from ledger_item li
          where 'ledger:' || li.id = situation.subject_key
            and li.status not in ${sqlList(OPEN_LEDGER)})`,
        'resolved',
      );
      const waits = rows<{
        id: string;
        space_id: string;
        principal_id: string;
        message_id: string;
        to_address: string;
        subject: string;
        sent_at: Date;
        job_id: string | null;
      }>(
        await tx.execute(sql`select a.id, a.space_id, a.principal_id, a.message_id, a.to_address,
            a.subject, a.sent_at, a.job_id
          from awaited_reply a join space s on s.id = a.space_id and s.removed_at is null
          where a.status in ${sqlList(OPEN_AWAITED)}
            and a.sent_at > ${new Date(now - REPLY_WINDOW_MS).toISOString()}::timestamptz
            and not exists (select 1 from clock k
              where k.rule = ${SITUATION_KINDS.replyOverdue} and k.subject_key = 'awaited:' || a.id)
          limit 200`),
      );
      for (const wait of waits) {
        const sentAt = new Date(wait.sent_at);
        // Long enough for a read of the mailbox to have happened since it was set.
        const fireAt = Math.max(sentAt.getTime() + REPLY_AFTER_MS, now + 2 * 5 * MINUTE);
        const check: ClockCheck = {
          at_risk: watchPredicate.parse({
            all: [{ field: 'status', op: 'matches', value: `^(${OPEN_AWAITED.join('|')})$` }],
          }),
          fresh: true,
          ceiling: 'normal',
          awaited: {
            id: wait.id,
            messageId: wait.message_id,
            toAddress: wait.to_address,
            subject: wait.subject,
            sentAt: sentAt.toISOString(),
          },
        };
        await tx.insert(clock).values({
          id: newId('clk'),
          spaceId: wait.space_id,
          principalId: wait.principal_id,
          rule: SITUATION_KINDS.replyOverdue,
          subjectKey: `awaited:${wait.id}`,
          title: 'Still no answer',
          dueAt: new Date(sentAt.getTime() + REPLY_WINDOW_MS),
          leadSeconds: 0,
          fireAt: new Date(fireAt),
          check: check as Record<string, unknown>,
          personSet: false,
          jobId: wait.job_id,
        });
        if (wait.job_id) await this.link(tx, `awaited:${wait.id}`, wait.job_id, 'handling');
      }
      await tx.execute(sql`update clock k set state = 'met', note = 'It was answered or let go.',
          updated_at = now()
        from awaited_reply a
        where k.subject_key = 'awaited:' || a.id and k.state = 'armed'
          and a.status not in ${sqlList(OPEN_AWAITED)}`);
      await this.settle(
        tx,
        sql`subject_key like 'awaited:%' and exists (select 1 from awaited_reply a
          where 'awaited:' || a.id = situation.subject_key
            and a.status not in ${sqlList(OPEN_AWAITED)})`,
        'resolved',
      );
    });
  }

  /** Situations whose moment passed. */
  private async expire() {
    await this.deps.jobs.transaction((tx) =>
      this.settle(
        tx,
        sql`expires_at is not null and expires_at < ${new Date(this.now()).toISOString()}::timestamptz`,
        'expired',
      ),
    );
  }

  // ------------------------------------------------------------------------
  // what the poller reads for detectors
  // ------------------------------------------------------------------------

  /**
   * The accounts the detectors need read, beside those triggers listen to:
   * every calendar a person connected for themselves, and a mailbox while a
   * wait on a reply is watched in its space. A calendar with a deadline due
   * within the hour is read every minute.
   */
  async demand(): Promise<
    Array<{ connectionId: string; spaceId: string; stream: 'mail' | 'calendar'; seconds: number }>
  > {
    if (!this.detectors) return [];
    const now = this.now();
    const accounts = rows<{
      id: string;
      space_id: string;
      provider: string;
      soon: boolean;
      waits: boolean;
    }>(
      await this.db.execute(sql`select c.id, c.space_id, c.provider,
          exists (select 1 from clock k where k.connection_id = c.id and k.state = 'armed'
            and k.fire_at <= ${new Date(now + HOUR).toISOString()}::timestamptz) as soon,
          exists (select 1 from clock k where k.space_id = c.space_id and k.state = 'armed'
            and k.rule = ${SITUATION_KINDS.replyOverdue}) as waits
        from connection c join space s on s.id = c.space_id and s.removed_at is null
        where c.status = 'active' and c.shared_use = 'owner'`),
    );
    const wanted: Array<{
      connectionId: string;
      spaceId: string;
      stream: 'mail' | 'calendar';
      seconds: number;
    }> = [];
    for (const account of accounts) {
      if (producesEvent(account.provider, 'calendar.event.changed'))
        wanted.push({
          connectionId: account.id,
          spaceId: account.space_id,
          stream: 'calendar',
          seconds: account.soon ? 60 : 300,
        });
      if (account.waits && producesEvent(account.provider, 'mail.received'))
        wanted.push({
          connectionId: account.id,
          spaceId: account.space_id,
          stream: 'mail',
          seconds: 300,
        });
    }
    return wanted;
  }

  // ------------------------------------------------------------------------
  // the person
  // ------------------------------------------------------------------------

  /** The person's live situations, newest first. */
  async list(principalId: string): Promise<SituationView[]> {
    const found = await this.db
      .select()
      .from(situation)
      .where(
        and(
          eq(situation.principalId, principalId),
          inArray(situation.state, [...LIVE_SITUATION_STATES]),
        ),
      )
      .orderBy(sql`${situation.createdAt} desc`)
      .limit(100);
    return found.map(situationView);
  }

  /** The person saw it: nothing more is pushed about it. Only their own. */
  async ack(principalId: string, id: string): Promise<SituationView> {
    return this.mark(principalId, id, false);
  }

  /** The person said it was not useful: it is closed, and that is kept as feedback. */
  async dismiss(principalId: string, id: string): Promise<SituationView> {
    return this.mark(principalId, id, true);
  }

  private async mark(principalId: string, id: string, dismiss: boolean) {
    return this.deps.jobs.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(situation)
        .where(and(eq(situation.id, id), eq(situation.principalId, principalId)))
        .for('update');
      if (!row) throw new ServiceError('not_found', 'Nothing like that is waiting for you.', 404);
      const at = new Date(this.now());
      const live = (LIVE_SITUATION_STATES as readonly string[]).includes(row.state);
      const [updated] = await tx
        .update(situation)
        .set({
          ackedAt: row.ackedAt ?? at,
          ...(dismiss && live ? { state: 'dismissed', resolvedAt: at } : {}),
          updatedAt: at,
        })
        .where(eq(situation.id, row.id))
        .returning();
      await this.dropPushes(tx, [row.id]);
      return situationView(updated ?? row);
    });
  }

  // ------------------------------------------------------------------------
  // running
  // ------------------------------------------------------------------------

  /**
   * Time the next check in-process when it is due within ten minutes, so a
   * deadline set for 14:55 is looked at near 14:55 rather than at the next
   * minute's sweep. The sweep remains what makes it durable.
   */
  private timeNext(at: number) {
    if (!this.started) return;
    const wait = at - this.now();
    if (wait > 10 * MINUTE || at >= this.timerAt) return;
    clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(
      () => {
        this.timerAt = Number.POSITIVE_INFINITY;
        void this.sweep().catch(() => process.stderr.write('situations: sweep_failed\n'));
      },
      Math.max(0, wait),
    );
  }

  private async timeUpcoming() {
    if (!this.started) return;
    const [next] = await this.db
      .select({ fireAt: clock.fireAt })
      .from(clock)
      .where(eq(clock.state, 'armed'))
      .orderBy(clock.fireAt)
      .limit(1);
    if (next) this.timeNext(next.fireAt.getTime());
  }

  /** Sweeps on the service's own scheduling, pg-boss, once a minute. */
  async start(queue: string): Promise<void> {
    if (this.started) return;
    const boss = this.deps.jobs.boss;
    await boss.work(queue, { batchSize: 1, pollingIntervalSeconds: 1 }, async () => {
      try {
        await this.sweep();
      } catch {
        process.stderr.write('situations: sweep_failed\n');
      }
    });
    await boss.schedule(queue, '* * * * *', {});
    this.started = true;
    await this.timeUpcoming();
  }

  async stop(queue: string): Promise<void> {
    clearTimeout(this.timer);
    this.timerAt = Number.POSITIVE_INFINITY;
    if (this.started) await this.deps.jobs.boss.offWork(queue, { wait: false });
    this.started = false;
  }
}

type KeptFields = Record<string, unknown> & {
  uid?: unknown;
  start?: unknown;
  end?: unknown;
  status?: unknown;
};

/** When a deadline that follows a subject's time is due: that time plus the offset. */
export function anchoredDue(
  fields: Record<string, unknown>,
  anchor: { field: string; offset_s: number } | null,
): number | null {
  if (!anchor) return null;
  const value = fields[anchor.field];
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at + anchor.offset_s * 1000;
}

const occurrenceFields = (found: Occurrence) => ({
  title: found.title,
  start: found.start,
  end: found.end,
  all_day: found.all_day,
  location: found.location,
  status: found.status,
  attendees: found.attendees,
});

const clip = (value: string, length: number) =>
  value.length > length ? `${value.slice(0, length - 1)}…` : value;

/** A parenthesised SQL list of values, for `in`. */
function sqlList(values: readonly string[]) {
  return sql`(${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}

/** A short stable id for a subject made of several, for keys and links. */
export const compositeKey = (prefix: string, parts: string[]) =>
  `${prefix}:${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40)}`;
