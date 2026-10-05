/**
 * Situations and clocks: noticing what may need the person, at the right time.
 *
 * Three ways in, all deterministic, none calling a model:
 *
 * 1. **Observations.** `observe` runs inside the transaction that delivers a
 *    connector event (in a savepoint of its own, so a fault here never undoes
 *    the delivery). A meeting that moved or was cancelled within a day raises
 *    `meeting.changed`; new mail that answers a wait settles it.
 * 2. **Calendar state.** After each calendar read, `afterCalendarRead` moves
 *    the clocks that follow a meeting's time, clears those whose meeting was
 *    cancelled, and looks for meetings that overlap (`meeting.conflict`).
 * 3. **Clocks.** `sweep` fires the clocks that are due. A clock reads its
 *    subject again first, from its source when it can and when it is still
 *    allowed to, and settles quietly when what it guards is already done. A
 *    deadline on a Drive file settles only on that look; a change read
 *    after its alert went out resolves the alert.
 *
 * Properties it keeps:
 *
 * - **One live situation per person, kind, subject and moment.** A second
 *   sighting with the same fingerprint changes nothing; a different one folds
 *   in. A situation the person dismissed comes back only on a material change.
 * - **Fires once.** A clock moves from `checking` to `fired` (or on to its next
 *   look) in the transaction that raises its situation, and only if nobody
 *   moved it meanwhile and the account is still the one that was read.
 * - **Never on stale state.** A clock re-derives its due time from what it
 *   read; a fresh read that fails is tried again and, if its time passes
 *   unread, the person is told it could not be checked, never that it is undone.
 * - **Reads as the person would be allowed to.** A fresh read is refused when
 *   the account is not active, is being revoked or switched, is in another
 *   space, does not serve the work (or person) the deadline belongs to, or
 *   keeps its tools from that work's compartment. What it reads is tested and
 *   dropped: it is not stored, routed or shown to a model.
 * - **Urgent only by the person.** Only a deadline the person set or accepted
 *   can be urgent; the database refuses any other urgent row, situation or push.
 * - **Who hears what.** A situation is for one person: the owner of the
 *   account it came from (a room's accounts raise none), or whoever set the
 *   deadline. It reaches work only in the same space, for the same person, and
 *   only work every account it names serves.
 */
import {
  DOCUMENT_CHANGED,
  evaluateWatch,
  isTerminal,
  type JobConstraints,
  type JsonObject,
  jobConstraints,
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
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { type Connector, connectorAllowsAudience } from '../connectors/types.ts';
import type { Database } from '../db/client.ts';
import { space, trigger } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import { jobMayUseConnection } from '../jobs/scopes.ts';
import type { JobService } from '../jobs/service.ts';
import type { TriggerService } from '../jobs/triggers.ts';
import { isQuiet } from '../push/policy.ts';
import { documentSubjectKey } from '../signals/observations.ts';
import type { DocumentFile, Occurrence, SignalSource, SubjectReader } from '../signals/types.ts';
import {
  type Awaited,
  changedSince,
  conflictReason,
  DATE_ONLY_DUE,
  type DocumentToucher,
  documentAtRisk,
  dueWords,
  type Finding,
  fingerprintOf,
  higher,
  type KeptMeeting,
  localInstant,
  louder,
  meetingChange,
  meetingConflicts,
  replyVerdict,
  situationKey,
  urgencyFor,
  withinDay,
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
/** A wait whose mailbox stays unreadable this many tries (backing off to an hour) is let go. */
export const MAX_REPLY_TRIES = 30;
/** How long after a wait was found its mailbox must have been watched for silence to count. */
export const REPLY_COVER_MS = 10 * MINUTE;
/** Said of a wait when mail looked like its answer but its sender could not be verified. */
export const UNVERIFIED_REPLY = "A reply came that couldn't be verified as from them.";
/** One situation wakes one piece of work at most this often; later ones wait for its next wake. */
export const WAKE_SPACING_MS = 5 * MINUTE;
/** How far ahead a commitment's due date is watched. */
export const COMMITMENT_HORIZON_MS = 14 * DAY;
/** The looks a commitment gets before it is due: a day before, and fifteen minutes before. */
export const COMMITMENT_LEADS = [24 * 3600, 15 * 60] as const;
/** How long after a message was sent its wait is looked at, and the longest it is watched. */
export const REPLY_AFTER_MS = 3 * DAY;
export const REPLY_WINDOW_MS = 30 * DAY;
/** How often a calendar is read for the detectors: by day, by night, and near a deadline. */
export const DETECTOR_DAY_SECONDS = 300;
export const DETECTOR_QUIET_SECONDS = 1800;
export const DETECTOR_NEAR_SECONDS = 60;
/** Most entries `because` keeps as sightings fold in. */
const MAX_BECAUSE = 20;

const OPEN_LEDGER = ['found', 'handling', 'waiting'];
const OPEN_AWAITED = ['found', 'handling', 'waiting'];

/** What a deadline's clock checks at fire time. */
export type ClockCheck = {
  /** Still at risk while this holds against the subject's fresh fields. */
  at_risk: WatchPredicate;
  /** Read the subject at its source when the clock fires (the default). */
  fresh?: boolean;
  /** The highest urgency what it raises may have. */
  ceiling?: Urgency;
  /** Later looks, as leads in seconds before the due time, after this one. */
  leads?: number[];
  /**
   * A deadline given as a date alone: that date, said as a day. It is due at
   * the end of a working day there, is never urgent, and is never looked at
   * outside the person's day.
   */
  date_only?: string | null;
  /** For a commitment: the due date its clock was made from, to notice a rescan moving it. */
  ledger_due?: string | null;
  /** For a reply clock: the wait it guards. */
  awaited?: Awaited & { id: string; found_at: string };
  /** For a deadline on a Drive file: changes since when, by whom, count. */
  document?: { since: string; by: DocumentToucher };
  /** The file is in a shared drive, so the Drive's shared drives are read too. */
  shared_drive?: boolean;
};

export type { SubjectReader };

type Readable =
  | {
      signals?: SignalSource;
      subjects?: SubjectReader;
      catalog?: Connector['catalog'];
      /** A Drive file's metadata as it is now, to check a deadline's file when it is set. */
      file?(id: string): Promise<DocumentFile | 'gone'>;
    }
  | undefined;

export type SituationDeps = {
  jobs: JobService;
  triggers: Pick<TriggerService, 'registerWait'>;
  /** The connectors this instance has open, for fresh reads. */
  connectors?: { get(id: string): Readable };
  /** Opens a connection this instance has not opened yet. */
  load?: (connectionId: string) => Promise<Readable>;
  /** Called after an urgent situation commits, to push it now rather than at the next pass. */
  notify?: (principalId: string) => Promise<unknown>;
  /**
   * Called in the transaction that makes a situation urgent, with whether a
   * push was queued for it: the reach-me ladder starts there.
   */
  escalate?: (
    tx: Transaction,
    situation: {
      id: string;
      principalId: string;
      kind: string;
      urgency: string;
      personSet: boolean;
    },
    pushed: boolean,
  ) => Promise<void>;
  /** The built-in detectors; off leaves only deadlines that work sets. */
  detectors?: boolean;
  /** Other passes that run with each sweep, such as intents reaching their deadline. */
  sweeps?: Array<() => Promise<unknown>>;
  now?: () => number;
};

/** A deadline to keep: its subject, when it is due, and how it is looked at. */
export type DeadlineInput = {
  spaceId: string;
  principalId: string;
  subjectKey: string;
  connectionId?: string | null;
  subjectRef?: string | null;
  title: string;
  dueAt?: Date;
  anchor?: { field: string; offset_s: number } | null;
  /** How long before it is due Melete looks, in seconds; the first look when `leads` has more. */
  leadSeconds: number;
  /** Later looks, in seconds before the due time. */
  leads?: number[];
  atRisk: WatchPredicate;
  fresh?: boolean;
  personSet: boolean;
  jobId?: string | null;
  ceiling?: Urgency;
  dateOnly?: string | null;
  /** More of what the clock checks, for one kind of subject. */
  extra?: Pick<ClockCheck, 'document' | 'shared_drive'>;
};

type SituationRow = typeof situation.$inferSelect;
type ClockRow = typeof clock.$inferSelect;

export type Raise = Finding & {
  spaceId: string;
  principalId: string;
  connectionId: string | null;
  /** Every account its facts came from; work it reaches must be served by each. */
  connections?: string[];
  personSet: boolean;
  because: string[];
  origin: 'external_content' | 'person' | 'service';
  /** The work it reaches beside what is linked to its subject. */
  jobIds?: string[];
  /** What a push says it is because of. */
  pushBecause: string;
};

export type Raised = { row: SituationRow; fresh: boolean; louder: boolean; urgent: boolean };

type Read =
  | 'retry'
  | 'gone'
  | { refused: string }
  | {
      fields: Record<string, unknown>;
      seen: (kind: string, since: number | null) => boolean;
      generation: number | null;
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

  /** The time this service keeps deadlines by. */
  currentTime(): number {
    return this.now();
  }

  get detectors(): boolean {
    return this.deps.detectors !== false;
  }

  /** The person's day, read from their profile: when Melete may speak, and where. */
  private async dayOf(
    tx: Transaction | Database,
    principalId: string,
  ): Promise<{ start: string; end: string; timeZone: string }> {
    const [row] = rows<{ day_start: string; day_end: string; time_zone: string }>(
      await tx.execute(sql`select p.day_start, p.day_end, p.time_zone from experience_profile p
        join space s on s.id = p.space_id
        where s.owner_principal_id = ${principalId} and s.kind = 'personal' limit 1`),
    );
    return {
      start: row?.day_start ?? '08:00',
      end: row?.day_end ?? '22:00',
      timeZone: row?.time_zone ?? 'UTC',
    };
  }

  /** A look at a date-only deadline that would fall outside the person's day waits for its start. */
  private async lookAt(
    tx: Transaction | Database,
    principalId: string,
    at: number,
    check: Pick<ClockCheck, 'date_only'>,
  ): Promise<number> {
    if (!check.date_only) return at;
    const day = await this.dayOf(tx, principalId);
    return withinDay(at, day, (when) => isQuiet(new Date(when), day));
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
   * The same fingerprint again changes nothing. A key whose last situation
   * the person dismissed stays quiet until the fingerprint changes: null.
   */
  async raise(
    tx: Transaction,
    input: Raise,
  ): Promise<{ row: SituationRow; fresh: boolean; louder: boolean } | null> {
    // Nothing a detector reads on its own can make a situation urgent.
    const urgency: Urgency =
      input.urgency === 'urgent' && !input.personSet ? 'soon' : input.urgency;
    const scope = { spaceId: input.spaceId, principalId: input.principalId };
    const key = situationKey(scope, input.kind, input.subjectKey, input.window);
    const at = new Date(this.now());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [live] = await tx
        .select()
        .from(situation)
        .where(and(eq(situation.key, key), inArray(situation.state, [...LIVE_SITUATION_STATES])))
        .for('update');
      if (live) {
        const raised = higher(live.urgency as Urgency, urgency);
        const changed = live.fingerprint !== input.fingerprint;
        if (!changed && raised === live.urgency) return { row: live, fresh: false, louder: false };
        const because = [...new Set([...live.because, ...input.because])].slice(-MAX_BECAUSE);
        const [row] = await tx
          .update(situation)
          .set({
            sightings: changed ? live.sightings + 1 : live.sightings,
            fingerprint: input.fingerprint,
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
        return { row, fresh: false, louder: louder(raised, live.urgency as Urgency) };
      }
      // The person said this was not useful: it stays so until it changes.
      const [last] = await tx
        .select({ state: situation.state, fingerprint: situation.fingerprint })
        .from(situation)
        .where(eq(situation.key, key))
        .orderBy(desc(situation.createdAt))
        .limit(1);
      if (last?.state === 'dismissed' && last.fingerprint === input.fingerprint) return null;
      const inserted = rows<{ id: string }>(
        await tx.execute(sql`insert into situation (id, space_id, principal_id, kind, subject_key,
            connection_id, key, fingerprint, urgency, person_set, title, reason, because, evidence,
            origin, deadline_at, state, created_at, updated_at, expires_at)
          values (${newId('sit')}, ${input.spaceId}, ${input.principalId}, ${input.kind},
            ${input.subjectKey}, ${input.connectionId}, ${key}, ${input.fingerprint}, ${urgency},
            ${input.personSet}, ${input.title}, ${input.reason},
            ${JSON.stringify(input.because)}::jsonb, ${JSON.stringify(input.evidence)}::jsonb,
            ${input.origin}, ${input.deadlineAt}::timestamptz, 'open',
            ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz,
            ${input.expiresAt}::timestamptz)
          on conflict (key) where state in ('open', 'routed') do nothing
          returning id`),
      );
      if (inserted[0]) {
        const [row] = await tx.select().from(situation).where(eq(situation.id, inserted[0].id));
        if (!row) throw new Error('situation insert lost');
        return { row, fresh: true, louder: false };
      }
    }
    throw new Error('live situation vanished under its key');
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
    if (row.urgency === 'urgent' && row.personSet) await this.deps.escalate?.(tx, row, told);
    const routed = raised.fresh
      ? await this.route(tx, row, input.jobIds ?? [], input.connections ?? [])
      : [];
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
   * its person, and served by every account it names. Work waiting on a
   * trigger wakes with it, at most once in five minutes; any other work reads
   * it at its next wake.
   */
  private async route(
    tx: Transaction,
    row: SituationRow,
    extra: string[],
    connections: string[],
  ): Promise<string[]> {
    const linked = rows<{ job_id: string }>(
      await tx.execute(sql`select job_id from subject_link
        where subject_key = ${row.subjectKey} and space_id = ${row.spaceId}`),
    ).map((link) => link.job_id);
    const accounts = [
      ...new Set([...(row.connectionId ? [row.connectionId] : []), ...connections]),
    ];
    const routed: string[] = [];
    const [parent] = await tx.select().from(space).where(eq(space.id, row.spaceId));
    for (const jobId of [...new Set([...linked, ...extra])].sort()) {
      const current = await this.deps.jobs.lock(tx, jobId);
      if (!current || current.spaceId !== row.spaceId) continue;
      if (isTerminal(jobState.parse(current.state))) continue;
      if ((current.principalId ?? row.principalId) !== row.principalId) continue;
      let served = true;
      for (const account of accounts)
        if (!(await jobMayUseConnection(tx, jobId, account))) served = false;
      if (!served) continue;
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
            -- Both sides on the database's clock, which dated the event.
            and created_at > now() - ${`${WAKE_SPACING_MS / 1000} seconds`}::interval`),
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

  private async raiseAndAttend(tx: Transaction, input: Raise): Promise<Raised | null> {
    const raised = await this.raise(tx, input);
    if (!raised) return null;
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
    // A deadline someone kept on a file is theirs, not a detector's: it settles either way.
    if (delivery.event_name === DOCUMENT_CHANGED) return this.documentChanged(tx, delivery);
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
      const verdict = replyVerdict(awaited, delivery.payload);
      if (!verdict) continue;
      const subject = `awaited:${entry.id}`;
      if (verdict === 'unverified') {
        // Its From address matches, but nothing proves who sent it: the wait stays open.
        await tx.execute(sql`update clock set note = ${UNVERIFIED_REPLY}, updated_at = now()
          where rule = ${SITUATION_KINDS.replyOverdue} and subject_key = ${subject}
            and principal_id = ${principalId} and state in ('armed', 'checking', 'fired')`);
        continue;
      }
      await this.settle(
        tx,
        sql`kind = ${SITUATION_KINDS.replyOverdue} and subject_key = ${subject}
          and principal_id = ${principalId}`,
        'resolved',
      );
      await tx.execute(sql`update clock set state = 'met', note = ${'An answer came.'},
          updated_at = now()
        where rule = ${SITUATION_KINDS.replyOverdue} and subject_key = ${subject}
          and principal_id = ${principalId} and state in ('armed', 'checking')`);
    }
  }

  /**
   * A Drive file changed. A deadline on it settles only on its own fresh look,
   * so nothing here moves a clock. An alert that already went out about the
   * file is resolved when the change is the one the deadline asked for, so
   * no later reminder reaches the person about something done.
   */
  private async documentChanged(
    tx: Transaction,
    delivery: { connection_id: string; payload: Record<string, unknown> },
  ): Promise<void> {
    const { payload } = delivery;
    const key = (payload.about as { key?: unknown } | undefined)?.key;
    if (typeof key !== 'string' || payload.removed === true || payload.trashed === true) return;
    const raised = await tx
      .select()
      .from(clock)
      .where(
        and(
          eq(clock.connectionId, delivery.connection_id),
          eq(clock.subjectKey, key),
          eq(clock.rule, SITUATION_KINDS.deadlineAtRisk),
          inArray(clock.state, ['armed', 'checking', 'fired']),
          sql`${clock.situationId} is not null`,
        ),
      );
    for (const entry of raised) {
      const check = entry.check as ClockCheck;
      const atRisk = evaluateWatch(watchPredicate.parse(check.at_risk), payload, null, {
        now: this.now(),
        seen: () => false,
      });
      if (atRisk) continue;
      await this.settle(
        tx,
        sql`id = ${entry.situationId} and kind = ${SITUATION_KINDS.deadlineAtRisk}`,
        'resolved',
      );
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
        response: typeof row.fields.response === 'string' ? row.fields.response : null,
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
          // Two calendars may be involved; each is named, and work must be served by both.
          connectionId: null,
          connections: conflict.connections,
          personSet: false,
          because: conflict.pair.map((key) => `subject:${key}`),
          origin: 'external_content',
          pushBecause: 'Because two meetings on your calendar overlap.',
        });
        if (raised?.urgent) pendingUrgent.push(principalId);
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

  /**
   * Clocks that follow a meeting on this account: moved with it, or cleared
   * when it is gone. A clock being checked right now moves too; its check then
   * finds it moved and leaves it waiting at the new time.
   */
  private async followSubjects(tx: Transaction, connectionId: string) {
    const following = await tx
      .select()
      .from(clock)
      .where(
        and(
          eq(clock.connectionId, connectionId),
          inArray(clock.state, ['armed', 'checking']),
          sql`${clock.anchor} is not null`,
        ),
      )
      .for('update');
    for (const entry of following) {
      const [kept] = rows<{ fields: KeptFields; version: string }>(
        await tx.execute(sql`select fields, version from subject_state
          where subject_key = ${entry.subjectKey} and space_id = ${entry.spaceId}`),
      );
      if (!kept || kept.fields.status === 'cancelled') {
        await tx
          .update(clock)
          .set({
            state: 'cleared',
            note: 'What it followed was cancelled or is gone.',
            claimedUntil: null,
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
   * Keep a deadline for one person: at `due` less each lead, look at the
   * subject again and, if it is still at risk, raise `deadline.at_risk`. One
   * live deadline per person and subject: setting it again moves it. A
   * deadline that follows a meeting's time (`anchor`) moves when the meeting
   * moves and is cleared when it is cancelled. The account named must be in
   * the person's space and serve them, or the work that sets it.
   */
  async setDeadline(input: DeadlineInput): Promise<ClockRow> {
    const made = await this.deps.jobs.transaction((tx) => this.keepDeadline(tx, input));
    this.timeNext(made.fireAt.getTime());
    return made;
  }

  /**
   * `setDeadline` inside a transaction the caller holds, so a deadline is kept
   * with whatever it belongs to or not at all. The caller passes the clock to
   * `wake` once that transaction commits.
   */
  async keepDeadline(tx: Transaction, input: DeadlineInput): Promise<ClockRow> {
    const atRisk = watchPredicate.parse(input.atRisk);
    const problem = watchPredicateProblem(atRisk, 'clock');
    if (problem) throw new ServiceError('invalid_predicate', problem, 400);
    const leads = [input.leadSeconds, ...(input.leads ?? [])];
    if (leads.some((lead) => !Number.isSafeInteger(lead) || lead < 0))
      throw new ServiceError('invalid_deadline', 'A lead is a whole number of seconds.', 400);
    await this.checkSubject(tx, input);
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
    return this.keepClock(tx, {
      spaceId: input.spaceId,
      principalId: input.principalId,
      rule: SITUATION_KINDS.deadlineAtRisk,
      subjectKey: input.subjectKey,
      connectionId: input.connectionId ?? null,
      subjectRef: input.subjectRef ?? null,
      title: input.title,
      due,
      leads,
      anchor: input.anchor ?? null,
      check: {
        at_risk: atRisk,
        fresh: input.fresh ?? true,
        ...(input.ceiling || input.dateOnly
          ? {
              ceiling:
                input.ceiling === 'normal' ? 'normal' : input.dateOnly ? 'soon' : input.ceiling,
            }
          : {}),
        ...(input.dateOnly ? { date_only: input.dateOnly } : {}),
        ...(input.extra ?? {}),
      },
      personSet: input.personSet,
      jobId: input.jobId ?? null,
    });
  }

  /** Time the next sweep for a clock kept in a transaction that has now committed. */
  wake(made: Pick<ClockRow, 'fireAt'>): void {
    this.timeNext(made.fireAt.getTime());
  }

  /**
   * Let go of the live deadline clocks on a subject: what they guarded is no
   * longer wanted. Situations they raised are resolved.
   */
  async clearSubject(
    tx: Transaction,
    spaceId: string,
    subjectKey: string,
    note: string,
    /** Only clocks of this rule, and situations of this kind; left out, all of them. */
    rule?: string,
  ) {
    const only = (column: string) => (rule ? sql`and ${sql.raw(column)} = ${rule}` : sql``);
    await tx.execute(sql`update clock set state = 'cleared', note = ${note}, claimed_until = null,
        updated_at = ${new Date(this.now()).toISOString()}::timestamptz
      where space_id = ${spaceId} and subject_key = ${subjectKey}
        and state in ('armed', 'checking') ${only('rule')}`);
    await this.settle(
      tx,
      sql`space_id = ${spaceId} and subject_key = ${subjectKey} ${only('kind')}`,
      'resolved',
    );
  }

  /**
   * Raise a situation and hand it on, inside the caller's transaction: for
   * what other parts of Melete notice on their own clocks.
   */
  async raiseIn(tx: Transaction, input: Raise): Promise<Raised | null> {
    return this.raiseAndAttend(tx, input);
  }

  /**
   * The Drive a deadline is kept on: the one named, if it is an active Drive in
   * this space, or else the space's own Drive. Null when there is none.
   */
  async driveIn(spaceId: string, connectionId?: string): Promise<string | null> {
    const [found] = rows<{ id: string }>(
      await this.db.execute(sql`select c.id from connection c
        join space s on s.id = c.space_id and s.removed_at is null
        where c.space_id = ${spaceId} and c.provider = 'drive' and c.status = 'active'
          ${connectionId ? sql`and c.id = ${connectionId}` : sql``}
        order by c.id limit 1`),
    );
    return found?.id ?? null;
  }

  /**
   * A deadline on a Google Drive file: by `due`, the person (`me`) or
   * someone else (`others`) should have changed it since `since`, which is now
   * unless said and is never later than now. It is looked at `leadSeconds`
   * before it is due, against the file as Drive has it then; only that look
   * settles it. Still unchanged in that way, it raises `deadline.at_risk`; a
   * file removed or in the bin raises it too, saying so. The file is looked up
   * once when the deadline is set: one Drive no longer has is refused.
   */
  async setDocumentDeadline(input: {
    spaceId: string;
    principalId: string;
    connectionId: string;
    fileId: string;
    title: string;
    dueAt: Date;
    leadSeconds: number;
    since?: Date;
    by: DocumentToucher;
    personSet: boolean;
    jobId?: string | null;
  }): Promise<ClockRow> {
    const [account] = rows<{ provider: string }>(
      await this.db.execute(sql`select provider from connection where id = ${input.connectionId}`),
    );
    if (!account || !producesEvent(account.provider, DOCUMENT_CHANGED))
      throw new ServiceError(
        'invalid_deadline',
        'That account has no files to keep a deadline on.',
        400,
      );
    const since = input.since ?? new Date(this.now());
    if (since.getTime() > this.now())
      throw new ServiceError(
        'invalid_deadline',
        'A deadline counts changes from a moment that has already come, not one ahead.',
        400,
      );
    let source: Readable;
    try {
      source =
        this.deps.connectors?.get(input.connectionId) ??
        (await this.deps.load?.(input.connectionId));
    } catch {
      source = undefined;
    }
    let found: DocumentFile | 'gone' | null = null;
    try {
      found = source?.file ? await source.file(input.fileId) : null;
    } catch {
      found = null;
    }
    if (found === 'gone' || (found !== null && found.trashed))
      throw new ServiceError(
        'invalid_deadline',
        'That file is not in this Drive, or it is in the bin.',
        400,
      );
    return this.setDeadline({
      spaceId: input.spaceId,
      principalId: input.principalId,
      subjectKey: documentSubjectKey(input.connectionId, input.fileId),
      connectionId: input.connectionId,
      subjectRef: input.fileId,
      title: input.title,
      dueAt: input.dueAt,
      leadSeconds: input.leadSeconds,
      atRisk: watchPredicate.parse(documentAtRisk(since.toISOString(), input.by)),
      fresh: true,
      personSet: input.personSet,
      jobId: input.jobId ?? null,
      extra: {
        document: { since: since.toISOString(), by: input.by },
        ...(found?.drive_id ? { shared_drive: true } : {}),
      },
    });
  }

  /**
   * Refuses a deadline on an account or a subject outside the person's space,
   * or on an account that does not serve the work, or the person, it is for.
   */
  private async checkSubject(
    tx: Transaction,
    input: {
      spaceId: string;
      principalId: string;
      subjectKey: string;
      connectionId?: string | null;
      jobId?: string | null;
    },
  ) {
    const refuse = () =>
      new ServiceError(
        'invalid_deadline',
        'That is not something this person can keep a deadline on.',
        400,
      );
    const [held] = rows<{ space_id: string; connection_id: string }>(
      await tx.execute(sql`select space_id, connection_id from subject_state
        where subject_key = ${input.subjectKey}`),
    );
    if (
      held &&
      (held.space_id !== input.spaceId ||
        (input.connectionId && held.connection_id !== input.connectionId))
    )
      throw refuse();
    if (input.jobId) {
      const [work] = rows<{ space_id: string; principal_id: string | null }>(
        await tx.execute(sql`select space_id, principal_id from job where id = ${input.jobId}`),
      );
      if (
        !work ||
        work.space_id !== input.spaceId ||
        (work.principal_id ?? input.principalId) !== input.principalId
      )
        throw refuse();
    }
    if (!input.connectionId) return;
    const [account] = rows<{
      space_id: string;
      status: string;
      shared_use: string;
      owner_id: string | null;
    }>(
      await tx.execute(sql`select c.space_id, c.status, c.shared_use,
          coalesce(s.owner_principal_id, (select id from owner limit 1)) as owner_id
        from connection c join space s on s.id = c.space_id where c.id = ${input.connectionId}`),
    );
    if (!account || account.space_id !== input.spaceId || account.status !== 'active')
      throw refuse();
    if (input.jobId) {
      if (!(await jobMayUseConnection(tx, input.jobId, input.connectionId))) throw refuse();
    } else if (account.shared_use !== 'owner' || account.owner_id !== input.principalId)
      throw refuse();
  }

  /** Make or move the one live clock for a person, rule and subject. */
  private async keepClock(
    tx: Transaction,
    input: {
      spaceId: string;
      principalId: string;
      rule: string;
      subjectKey: string;
      connectionId: string | null;
      subjectRef: string | null;
      title: string;
      due: number;
      leads: number[];
      anchor: { field: string; offset_s: number } | null;
      check: Omit<ClockCheck, 'leads'>;
      personSet: boolean;
      jobId: string | null;
    },
  ): Promise<ClockRow> {
    const now = this.now();
    // The first look still ahead; a deadline set late gets its next look now.
    const ordered = [...new Set(input.leads)].sort((a, b) => b - a);
    const ahead = ordered.filter((lead) => input.due - lead * 1000 > now);
    const [lead = ordered.at(-1) ?? 0, ...later] = ahead.length ? ahead : [ordered.at(-1) ?? 0];
    const check: ClockCheck = { ...input.check, ...(later.length ? { leads: later } : {}) };
    const fireAt = await this.lookAt(
      tx,
      input.principalId,
      Math.max(now, input.due - lead * 1000),
      check,
    );
    const values = {
      spaceId: input.spaceId,
      principalId: input.principalId,
      connectionId: input.connectionId,
      subjectRef: input.subjectRef,
      title: input.title,
      dueAt: new Date(input.due),
      leadSeconds: lead,
      fireAt: new Date(fireAt),
      anchor: input.anchor,
      check: check as Record<string, unknown>,
      personSet: input.personSet,
      jobId: input.jobId,
      updatedAt: new Date(now),
    };
    const [live] = await tx
      .select()
      .from(clock)
      .where(
        and(
          eq(clock.spaceId, input.spaceId),
          eq(clock.principalId, input.principalId),
          eq(clock.rule, input.rule),
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
          // Made on the service's clock, the one a wait's mailbox reads are dated by.
          .values({
            id: newId('clk'),
            rule: input.rule,
            subjectKey: input.subjectKey,
            ...values,
            createdAt: new Date(now),
          })
          .returning();
    if (!row) throw new Error('clock write lost');
    if (input.jobId)
      await this.link(
        tx,
        input.subjectKey,
        input.jobId,
        input.rule === SITUATION_KINDS.deadlineAtRisk && input.personSet ? 'deadline' : 'handling',
      );
    return row;
  }

  /**
   * A commitment the person took up in Melete ("Handle it"). Its due date is
   * now theirs: it is looked at a day before and again fifteen minutes before,
   * and that last look can reach them at once. Taken up by an outside
   * assistant instead, it stays a commitment Melete found: shown, never urgent.
   */
  async acceptCommitment(input: {
    spaceId: string;
    principalId: string;
    itemId: string;
    byPerson: boolean;
  }): Promise<void> {
    const made = await this.deps.jobs.transaction(async (tx) => {
      const [item] = rows<CommitmentRow>(
        await tx.execute(sql`select id, space_id, principal_id, status, due_at, due_date_only, job_id
          from ledger_item where id = ${input.itemId} and space_id = ${input.spaceId}
            and principal_id = ${input.principalId}`),
      );
      if (!item?.due_at || !OPEN_LEDGER.includes(item.status)) return null;
      // Pressed again: the clock moves to the current due date. Once the
      // person took it up it stays theirs, whoever presses after.
      const [live] = rows<{ person_set: boolean }>(
        await tx.execute(sql`select person_set from clock
          where space_id = ${item.space_id} and principal_id = ${item.principal_id}
            and rule = ${SITUATION_KINDS.deadlineAtRisk} and subject_key = ${`ledger:${item.id}`}
            and state in ('armed', 'checking')`),
      );
      return this.keepCommitment(tx, item, input.byPerson || live?.person_set === true);
    });
    if (made) this.timeNext(made.fireAt.getTime());
  }

  /**
   * The clock for a commitment. With a time, it is looked at a day before and,
   * once the person took it up, fifteen minutes before. With a date alone it is
   * due at the end of that working day where the person is (17:00), is looked
   * at the day before and on the morning of the day, inside their day, and is
   * never urgent: a date is not a time.
   */
  private async keepCommitment(tx: Transaction, item: CommitmentRow, byPerson: boolean) {
    const day = await this.dayOf(tx, item.principal_id);
    const date = item.due_date_only ? new Date(item.due_at).toISOString().slice(0, 10) : null;
    const due = date
      ? localInstant(date, DATE_ONLY_DUE, day.timeZone)
      : new Date(item.due_at).getTime();
    if (due <= this.now()) return null;
    const morning = date ? localInstant(date, day.start, day.timeZone) : null;
    const leads: number[] = date
      ? [
          COMMITMENT_LEADS[0],
          ...(byPerson && morning !== null && morning < due
            ? [Math.round((due - morning) / 1000)]
            : []),
        ]
      : byPerson
        ? [...COMMITMENT_LEADS]
        : [COMMITMENT_LEADS[0]];
    const ceiling: Urgency | null = !byPerson ? 'normal' : date ? 'soon' : null;
    return this.keepClock(tx, {
      spaceId: item.space_id,
      principalId: item.principal_id,
      rule: SITUATION_KINDS.deadlineAtRisk,
      subjectKey: `ledger:${item.id}`,
      connectionId: null,
      subjectRef: null,
      title: 'A commitment is due',
      due,
      leads,
      anchor: null,
      check: {
        at_risk: watchPredicate.parse({
          all: [{ field: 'status', op: 'matches', value: `^(${OPEN_LEDGER.join('|')})$` }],
        }),
        fresh: true,
        ...(ceiling ? { ceiling } : {}),
        ...(date ? { date_only: date } : {}),
        ledger_due: `${new Date(item.due_at).toISOString()}${item.due_date_only ? '/date' : ''}`,
      },
      personSet: byPerson,
      jobId: item.job_id,
    });
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
    for (const pass of this.deps.sweeps ?? []) {
      try {
        await pass();
      } catch {
        process.stderr.write('situations: sweep_pass_failed\n');
      }
    }
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
   * one that was read for, and the account still the one that was read.
   */
  private async check(entry: ClockRow): Promise<'fired' | 'met' | 'missed' | 'deferred'> {
    const now = this.now();
    const check = entry.check as ClockCheck;
    if (now > entry.fireAt.getTime() + LATE_MS && now > entry.dueAt.getTime())
      return this.missed(entry, check, 'Melete could not look at this before it was due.');
    // Someone who has left the space hears nothing more about it.
    const [present] = rows<{ ok: boolean }>(
      await this.db.execute(
        sql`select ${belongs(sql`${entry.spaceId}`, sql`${entry.principalId}`)} as ok`,
      ),
    );
    if (!present?.ok)
      return this.settleClock(entry, 'cleared', 'The person no longer uses this space.');
    const read = await this.readSubject(entry, check);
    if (read === 'retry') {
      const tries = entry.tries + 1;
      const reply = entry.rule === SITUATION_KINDS.replyOverdue;
      // A wait backs off to an hour; a deadline tries every minute while there is time.
      const again = now + (reply ? Math.min(2 ** tries, 60) * MINUTE : RETRY_SECONDS * 1000);
      if (reply ? tries >= MAX_REPLY_TRIES : again > entry.dueAt.getTime())
        return this.missed(
          entry,
          check,
          reply
            ? 'The mailbox could not be read for a day, so whether an answer came is not known.'
            : 'What this deadline is about could not be read before it was due.',
        );
      await this.db
        .update(clock)
        .set({ state: 'armed', fireAt: new Date(again), tries, claimedUntil: null })
        .where(
          and(eq(clock.id, entry.id), eq(clock.state, 'checking'), eq(clock.fireAt, entry.fireAt)),
        );
      this.timeNext(again);
      return 'deferred';
    }
    if (read === 'gone') {
      // A file the deadline is about, removed or binned before it is due, is
      // worth telling the person about rather than letting go quietly.
      if (check.document)
        return this.fire(entry, check, {
          due: entry.dueAt.getTime(),
          generation: null,
          note: 'removed',
        });
      return this.settleClock(entry, 'cleared', 'What it was about no longer exists.');
    }
    if ('refused' in read) return this.settleClock(entry, 'cleared', read.refused);
    const atRisk = evaluateWatch(watchPredicate.parse(check.at_risk), read.fields, null, {
      now,
      seen: (kind, since) => read.seen(kind, since),
    });
    // A meeting the deadline follows may have moved since the clock was last
    // moved: the due time is what the fresh read says.
    const due = anchoredDue(read.fields, entry.anchor) ?? entry.dueAt.getTime();
    if (!atRisk) return this.settleClock(entry, 'met', 'It was done in time.');
    // A file that changed since, but not in the way asked, may be done: said so, and less loudly.
    const changed = check.document ? changedSince(read.fields, check.document.since) : false;
    return this.fire(entry, check, {
      due,
      generation: read.generation,
      ...(changed ? { note: 'changed' as const } : {}),
      ...(read.fields.unverified_reply === true ? { unverified: true } : {}),
    });
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
   * A deadline that could not be checked in time. A deadline the person set
   * or accepted tells them so, plainly, and never that it is undone; any
   * other keeps the reason on the clock.
   */
  private async missed(entry: ClockRow, check: ClockCheck, note: string): Promise<'missed'> {
    if (entry.rule !== SITUATION_KINDS.deadlineAtRisk || !entry.personSet)
      return this.settleClock(entry, 'missed', note) as Promise<'missed'>;
    await this.deps.jobs.transaction(async (tx) => {
      const [current] = await tx.select().from(clock).where(eq(clock.id, entry.id)).for('update');
      if (current?.state !== 'checking' || current.fireAt.getTime() !== entry.fireAt.getTime())
        return;
      const zone = await this.timeZoneOf(tx, current.principalId);
      const due = current.dueAt.toISOString();
      const raised = await this.raiseAndAttend(tx, {
        kind: SITUATION_KINDS.deadlineAtRisk,
        subjectKey: current.subjectKey,
        window: due,
        fingerprint: fingerprintOf(['unchecked', due]),
        urgency: 'soon',
        title: current.title,
        reason: `Melete couldn't check this before it was due ${dueWords(due, zone, check.date_only ?? null)}.`,
        evidence: { due_at: due, checked: false },
        deadlineAt: due,
        expiresAt: new Date(current.dueAt.getTime() + DAY).toISOString(),
        spaceId: current.spaceId,
        principalId: current.principalId,
        connectionId: current.connectionId,
        personSet: true,
        because: [`clock:${current.id}`],
        origin: 'person',
        pushBecause: 'Because you asked Melete to keep this deadline.',
      });
      await tx
        .update(clock)
        .set({
          state: 'missed',
          note,
          situationId: raised?.row.id ?? null,
          claimedUntil: null,
          updatedAt: new Date(this.now()),
        })
        .where(eq(clock.id, current.id));
    });
    return 'missed';
  }

  /**
   * Whether this clock may still read its account, and the account's
   * generation if so. The same rules as a brokered read: the account is
   * active and not being revoked or switched, it is in the clock's space, it
   * serves the work the deadline belongs to (or, with no work, its owner is
   * the person), and that work's compartment may use its tools.
   */
  private async authority(
    entry: ClockRow,
  ): Promise<{ generation: number; source: Readable } | { refused: string } | 'retry'> {
    const connectionId = entry.connectionId;
    if (!connectionId) return { generation: 0, source: undefined };
    const [account] = rows<{
      status: string;
      key_change: string | null;
      space_id: string;
      shared_use: string;
      generation: number;
      audience: string;
      owner_id: string | null;
    }>(
      await this.db.execute(sql`select c.status, c.key_change, c.space_id, c.shared_use,
          c.generation, s.audience,
          coalesce(s.owner_principal_id, (select id from owner limit 1)) as owner_id
        from connection c join space s on s.id = c.space_id and s.removed_at is null
        where c.id = ${connectionId}`),
    );
    if (!account || account.space_id !== entry.spaceId)
      return { refused: 'The account it was about is not in this space any more.' };
    if (account.key_change) return 'retry';
    if (account.status !== 'active')
      return { refused: 'The account it was about is not connected.' };
    let constraints: JobConstraints = jobConstraints.parse({});
    if (entry.jobId) {
      const [work] = rows<{
        space_id: string;
        state: string;
        principal_id: string | null;
        constraints: unknown;
      }>(
        await this.db.execute(sql`select space_id, state, principal_id, constraints from job
          where id = ${entry.jobId}`),
      );
      if (
        !work ||
        work.space_id !== entry.spaceId ||
        (work.principal_id ?? entry.principalId) !== entry.principalId ||
        !(await this.deps.jobs.transaction((tx) =>
          jobMayUseConnection(tx, entry.jobId as string, connectionId),
        ))
      )
        return { refused: 'The work it belongs to may not read that account.' };
      constraints = jobConstraints.parse(work.constraints ?? {});
    } else if (account.shared_use !== 'owner' || account.owner_id !== entry.principalId)
      return { refused: 'That account does not serve the person this deadline is for.' };
    let source: Readable;
    try {
      source = this.deps.connectors?.get(connectionId) ?? (await this.deps.load?.(connectionId));
    } catch {
      source = undefined;
    }
    if (
      source?.catalog &&
      !connectorAllowsAudience(source as Connector, constraints, account.audience)
    )
      return { refused: 'The work it belongs to may not use that account.' };
    return { generation: Number(account.generation), source };
  }

  /**
   * The subject's fields as they are now: read at the source when the clock
   * asks for a fresh look and may; otherwise what Melete keeps. `retry` when
   * the source could not be read this time.
   */
  private async readSubject(entry: ClockRow, check: ClockCheck): Promise<Read> {
    const none = () => false;
    if (entry.rule === SITUATION_KINDS.replyOverdue) return this.readWait(entry, check);
    if (entry.subjectKey.startsWith('intent:')) {
      // Something the person wants done: still open unless its work ended.
      const [item] = rows<{ state: string; run_state: string | null }>(
        await this.db.execute(sql`select i.state, j.state as run_state from intent i
          left join job j on j.id = i.run_id
          where i.id = ${entry.subjectKey.slice('intent:'.length)}
            and i.space_id = ${entry.spaceId} and i.principal_id = ${entry.principalId}`),
      );
      if (!item) return 'gone';
      return { fields: { state: intentStateNow(item) }, seen: none, generation: null };
    }
    if (entry.subjectKey.startsWith('ledger:')) {
      const [item] = rows<{ status: string; due_at: Date | null }>(
        await this.db.execute(sql`select status, due_at from ledger_item
          where id = ${entry.subjectKey.slice('ledger:'.length)}
            and space_id = ${entry.spaceId} and principal_id = ${entry.principalId}`),
      );
      if (!item) return 'gone';
      return {
        fields: { status: item.status, due_at: iso(item.due_at) },
        seen: none,
        generation: null,
      };
    }
    const kept = async () => {
      const [row] = rows<{ fields: Record<string, unknown> }>(
        await this.db.execute(sql`select fields from subject_state
          where subject_key = ${entry.subjectKey} and space_id = ${entry.spaceId}`),
      );
      return row?.fields ?? null;
    };
    const allowed = await this.authority(entry);
    if (allowed === 'retry' || 'refused' in allowed) return allowed;
    if (check.fresh === false || !entry.connectionId) {
      const fields = await kept();
      return fields ? { fields, seen: none, generation: allowed.generation } : 'gone';
    }
    const source = allowed.source;
    try {
      if (source?.subjects) {
        const fields = await source.subjects.read({ key: entry.subjectKey, ref: entry.subjectRef });
        return fields === 'gone'
          ? 'gone'
          : { fields: scalars(fields), seen: none, generation: allowed.generation };
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
        return {
          fields: { ...fields, ...occurrenceFields(found) },
          seen: none,
          generation: allowed.generation,
        };
      }
    } catch {
      return 'retry';
    }
    // Nothing here can read it fresh: it cannot be checked, so nothing is raised on it.
    return 'retry';
  }

  /**
   * A wait on a reply, as it is now. It counts only when the mailbox has been
   * watched since soon after the wait was found, and read since the clock was
   * set, so silence means no answer rather than nobody looking; and any
   * answer already read since the message was sent ends it. With no mailbox
   * connected, there is nothing that could see an answer, and it is let go.
   */
  private async readWait(entry: ClockRow, check: ClockCheck): Promise<Read> {
    const awaited = check.awaited;
    const awaitedId = awaited?.id ?? entry.subjectKey.slice('awaited:'.length);
    const [wait] = rows<{ status: string; created_at: Date }>(
      await this.db.execute(sql`select status, created_at from awaited_reply
        where id = ${awaitedId} and space_id = ${entry.spaceId}`),
    );
    if (!wait) return 'gone';
    const mailboxes = rows<{
      created_at: Date;
      last_ok_at: Date | null;
      id: string;
      provider: string;
    }>(
      await this.db.execute(sql`select c.id, c.provider, sc.created_at, sc.last_ok_at
        from connection c left join source_cursor sc on sc.connection_id = c.id and sc.stream = 'mail'
        where c.space_id = ${entry.spaceId} and c.status = 'active' and c.shared_use = 'owner'`),
    ).filter((row) => producesEvent(row.provider, 'mail.received'));
    if (!mailboxes.length)
      return { refused: 'No mailbox is connected here, so an answer could not be seen.' };
    const foundAt = new Date(wait.created_at).getTime();
    const watched = mailboxes.filter(
      (row) => row.created_at && new Date(row.created_at).getTime() <= foundAt + REPLY_COVER_MS,
    );
    if (!watched.length)
      return {
        refused:
          'Melete was not watching the mailbox when this wait was found, so it stays on the waiting list only.',
      };
    if (!watched.some((row) => row.last_ok_at && new Date(row.last_ok_at) >= entry.createdAt))
      return 'retry';
    // Any answer already read since the message was sent.
    const arrived = rows<{ payload: Record<string, unknown> }>(
      await this.db.execute(sql`select payload->'payload' as payload from event
        where payload->>'kind' = 'connector_event' and payload->>'event_name' = 'mail.received'
          and payload->>'connection_id' in ${sqlList(watched.map((row) => row.id))}
          and created_at >= ${awaited?.sentAt ?? entry.createdAt.toISOString()}::timestamptz
        order by seq desc limit 500`),
    );
    const verdicts =
      awaited === undefined ? [] : arrived.map((row) => replyVerdict(awaited, row.payload ?? {}));
    const answered = verdicts.includes('answers');
    return {
      fields: {
        status: wait.status,
        unverified_reply: !answered && verdicts.includes('unverified'),
      },
      seen: (kind) => kind === 'mail.received' && answered,
      generation: null,
    };
  }

  /**
   * Raise what a due clock guards, once: the clock goes on to its next look,
   * or to `fired`, in the same transaction, and only if nobody moved it
   * meanwhile and the account is still the one that was read. A due time the
   * fresh read moved is kept: later, the clock waits for it; already due, it
   * fires on it.
   */
  private async fire(
    entry: ClockRow,
    check: ClockCheck,
    read: {
      due: number;
      generation: number | null;
      note?: 'removed' | 'changed';
      /** A reply came that couldn't be verified as from the person asked. */
      unverified?: boolean;
    },
  ): Promise<'fired' | 'deferred'> {
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
      // The account changed while it was read: what it read is not used.
      if (current.connectionId && read.generation !== null) {
        const [account] = rows<{ status: string; generation: number; key_change: string | null }>(
          await tx.execute(sql`select status, generation, key_change from connection
            where id = ${current.connectionId} for share`),
        );
        if (
          account?.status !== 'active' ||
          account.key_change ||
          Number(account.generation) !== read.generation
        ) {
          await tx
            .update(clock)
            .set({ state: 'armed', claimedUntil: null })
            .where(eq(clock.id, current.id));
          return 'deferred' as const;
        }
      }
      let dueAt = current.dueAt;
      if (read.due !== current.dueAt.getTime()) {
        dueAt = new Date(read.due);
        const fireAt = new Date(read.due - current.leadSeconds * 1000);
        const later = fireAt.getTime() > this.now();
        await tx
          .update(clock)
          .set({
            dueAt,
            fireAt,
            ...(later ? { state: 'armed', claimedUntil: null } : {}),
            updatedAt: new Date(this.now()),
          })
          .where(eq(clock.id, current.id));
        if (later) {
          this.timeNext(fireAt.getTime());
          return 'deferred' as const;
        }
      }
      const zone = await this.timeZoneOf(tx, current.principalId);
      const reply = current.rule === SITUATION_KINDS.replyOverdue;
      const due = dueAt.toISOString();
      // A change of another kind than the one asked for is a question, never urgent.
      const ceiling: Urgency | undefined =
        read.note === 'changed' ? (check.ceiling === 'normal' ? 'normal' : 'soon') : check.ceiling;
      const urgency = reply
        ? ('normal' as Urgency)
        : urgencyFor({
            personSet: current.personSet,
            leadSeconds: Math.max(0, Math.round((dueAt.getTime() - this.now()) / 1000)),
            ...(ceiling ? { ceiling } : {}),
          });
      const words = dueWords(due, zone, check.date_only ?? null);
      const raised = await this.raiseAndAttend(tx, {
        kind: reply ? SITUATION_KINDS.replyOverdue : SITUATION_KINDS.deadlineAtRisk,
        subjectKey: current.subjectKey,
        window: reply ? '' : due,
        fingerprint: fingerprintOf([read.note ?? 'at_risk', due]),
        urgency,
        title: current.title,
        reason: reply
          ? read.unverified
            ? `You asked for something, and nobody has answered yet. ${UNVERIFIED_REPLY}`
            : 'You asked for something, and nobody has answered yet.'
          : read.note === 'removed'
            ? `Due ${words}, and the document was removed or moved to the bin.`
            : read.note === 'changed'
              ? `Due ${words}. The document changed since you set this, but not in the way you asked; check whether it is done.`
              : `Due ${words}, and it is not done yet.`,
        evidence: {
          due_at: due,
          checked_at: new Date(this.now()).toISOString(),
          fresh: check.fresh !== false,
          ...(read.note ? { document: read.note } : {}),
          ...(read.unverified ? { unverified_reply: true } : {}),
          ...(check.date_only ? { date_only: check.date_only } : {}),
        },
        deadlineAt: reply ? null : due,
        expiresAt: reply
          ? new Date(this.now() + REPLY_WINDOW_MS).toISOString()
          : new Date(
              Math.max(dueAt.getTime(), this.now()) + (check.date_only ? DAY : HOUR),
            ).toISOString(),
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
      // Something the person wants done that is not done near its deadline is at risk.
      if (current.subjectKey.startsWith('intent:'))
        await tx.execute(sql`update intent set state = 'at_risk',
            updated_at = ${new Date(this.now()).toISOString()}::timestamptz
          where id = ${current.subjectKey.slice('intent:'.length)}
            and space_id = ${current.spaceId} and state in ('active', 'waiting')`);
      // The next look, when one is still ahead; otherwise done.
      const [nextLead, ...rest] = check.leads ?? [];
      const nextFire =
        nextLead === undefined
          ? null
          : await this.lookAt(tx, current.principalId, dueAt.getTime() - nextLead * 1000, check);
      const again = nextLead !== undefined && nextFire !== null && nextFire > this.now();
      await tx
        .update(clock)
        .set({
          ...(again
            ? {
                state: 'armed',
                leadSeconds: nextLead,
                fireAt: new Date(nextFire),
                check: { ...check, leads: rest } as Record<string, unknown>,
              }
            : { state: 'fired', firedAt: new Date(this.now()) }),
          situationId: raised?.row.id ?? current.situationId,
          claimedUntil: null,
          updatedAt: new Date(this.now()),
        })
        .where(eq(clock.id, current.id));
      if (again && nextFire !== null) this.timeNext(nextFire);
      if (raised?.urgent) pendingUrgent.push(current.principalId);
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
   * (shown on Home; the person's own, and pushed, once they take it up in
   * Melete), and a message the person sent that is still waiting on an
   * answer. Each gets one clock; one already settled is not made again for the
   * same due time. A commitment settled or a wait answered on the person's
   * list ends its clock and its situation.
   */
  async armDetectorClocks(): Promise<void> {
    const now = this.now();
    await this.deps.jobs.transaction(async (tx) => {
      const items = rows<CommitmentRow>(
        await tx.execute(sql`select li.id, li.space_id, li.principal_id, li.status, li.due_at,
            li.due_date_only, li.job_id
          from ledger_item li join space s on s.id = li.space_id and s.removed_at is null
          where li.due_at is not null and li.status in ${sqlList(OPEN_LEDGER)}
            and ${belongs(sql`li.space_id`, sql`li.principal_id`)}
            and li.due_at > ${new Date(now - DAY).toISOString()}::timestamptz
            and li.due_at <= ${new Date(now + COMMITMENT_HORIZON_MS).toISOString()}::timestamptz
            and not exists (select 1 from clock k
              where k.rule = ${SITUATION_KINDS.deadlineAtRisk} and k.subject_key = 'ledger:' || li.id
                and k.space_id = li.space_id and k.principal_id = li.principal_id)
          limit 200`),
      );
      for (const item of items) await this.keepCommitment(tx, item, false);
      // A rescan that moved a commitment's due date moves its clock; one that
      // took the commitment off the list clears it. No clock is left on a date
      // the list no longer says.
      const followed = rows<
        CommitmentRow & { clock_id: string; person_set: boolean; kept_due: string | null }
      >(
        await tx.execute(sql`select k.id as clock_id, k.person_set, k."check"->>'ledger_due' as kept_due,
            li.id, k.space_id, k.principal_id, li.status, li.due_at, li.due_date_only, li.job_id
          from clock k left join ledger_item li
            on 'ledger:' || li.id = k.subject_key and li.space_id = k.space_id
          where k.rule = ${SITUATION_KINDS.deadlineAtRisk} and k.subject_key like 'ledger:%'
            and k.state = 'armed'
          limit 500`),
      );
      for (const entry of followed) {
        const current =
          entry.id && entry.due_at
            ? `${new Date(entry.due_at).toISOString()}${entry.due_date_only ? '/date' : ''}`
            : null;
        if (current !== null && current === entry.kept_due) continue;
        const kept =
          current !== null ? await this.keepCommitment(tx, entry, entry.person_set) : null;
        if (kept) continue;
        await tx
          .update(clock)
          .set({
            state: 'cleared',
            note: 'The commitment is no longer on the list with a date ahead.',
            updatedAt: new Date(now),
          })
          .where(and(eq(clock.id, entry.clock_id), eq(clock.state, 'armed')));
      }
      // Settled or dropped: its clock and its situation end.
      await tx.execute(sql`update clock k set state = 'met', note = 'It was settled.',
          updated_at = now()
        from ledger_item li
        where k.subject_key = 'ledger:' || li.id and k.space_id = li.space_id
          and k.state = 'armed' and li.status not in ${sqlList(OPEN_LEDGER)}`);
      await this.settle(
        tx,
        sql`subject_key like 'ledger:%' and (exists (select 1 from ledger_item li
            where 'ledger:' || li.id = situation.subject_key and li.space_id = situation.space_id
              and li.status not in ${sqlList(OPEN_LEDGER)})
          or not exists (select 1 from ledger_item li
            where 'ledger:' || li.id = situation.subject_key and li.space_id = situation.space_id))`,
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
        created_at: Date;
        job_id: string | null;
      }>(
        await tx.execute(sql`select a.id, a.space_id, a.principal_id, a.message_id, a.to_address,
            a.subject, a.sent_at, a.created_at, a.job_id
          from awaited_reply a join space s on s.id = a.space_id and s.removed_at is null
          where a.status in ${sqlList(OPEN_AWAITED)}
            and ${belongs(sql`a.space_id`, sql`a.principal_id`)}
            and a.sent_at > ${new Date(now - REPLY_WINDOW_MS).toISOString()}::timestamptz
            and not exists (select 1 from clock k
              where k.rule = ${SITUATION_KINDS.replyOverdue} and k.subject_key = 'awaited:' || a.id
                and k.principal_id = a.principal_id)
          limit 200`),
      );
      for (const wait of waits) {
        const sentAt = new Date(wait.sent_at);
        // Long enough for a read of the mailbox to have happened since it was set.
        const fireAt = Math.max(sentAt.getTime() + REPLY_AFTER_MS, now + 2 * 5 * MINUTE);
        await this.keepClock(tx, {
          spaceId: wait.space_id,
          principalId: wait.principal_id,
          rule: SITUATION_KINDS.replyOverdue,
          subjectKey: `awaited:${wait.id}`,
          connectionId: null,
          subjectRef: null,
          title: 'Still no answer',
          due: sentAt.getTime() + REPLY_WINDOW_MS,
          leads: [Math.round((sentAt.getTime() + REPLY_WINDOW_MS - fireAt) / 1000)],
          anchor: null,
          check: {
            at_risk: watchPredicate.parse({
              all: [
                { field: 'status', op: 'matches', value: `^(${OPEN_AWAITED.join('|')})$` },
                { field: 'mail.received', op: 'absent' },
              ],
            }),
            fresh: true,
            ceiling: 'normal',
            awaited: {
              id: wait.id,
              messageId: wait.message_id,
              toAddress: wait.to_address,
              subject: wait.subject,
              sentAt: sentAt.toISOString(),
              found_at: new Date(wait.created_at).toISOString(),
            },
          },
          personSet: false,
          jobId: wait.job_id,
        });
      }
      await tx.execute(sql`update clock k set state = 'met', note = 'It was answered or let go.',
          updated_at = now()
        from awaited_reply a
        where k.subject_key = 'awaited:' || a.id and k.space_id = a.space_id and k.state = 'armed'
          and a.status not in ${sqlList(OPEN_AWAITED)}`);
      await this.settle(
        tx,
        sql`subject_key like 'awaited:%' and exists (select 1 from awaited_reply a
          where 'awaited:' || a.id = situation.subject_key and a.space_id = situation.space_id
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
   * The accounts the detectors need read, beside those triggers listen to,
   * and only while a detector has someone to tell or something to keep: a
   * calendar its owner connected for themselves while they have a device to
   * reach or a deadline on it (every five minutes in their day, every thirty
   * at night, every minute with a deadline within the hour), and a mailbox
   * while a wait on a reply is watched in its space or still open on Home.
   * These reads share the poller's budget, its backoff and a provider's
   * Retry-After with every other read of the account.
   */
  async demand(): Promise<
    Array<{
      connectionId: string;
      spaceId: string;
      stream: 'mail' | 'calendar' | 'documents';
      seconds: number;
    }>
  > {
    const now = this.now();
    // A Drive is read while a deadline is kept on one of its files, or its alert
    // is still open, detectors or not.
    const drives = rows<{ id: string; space_id: string; soon: boolean }>(
      await this.db.execute(sql`select c.id, c.space_id,
          bool_or(k.state = 'armed'
            and k.fire_at <= ${new Date(now + HOUR).toISOString()}::timestamptz) as soon
        from connection c join clock k on k.connection_id = c.id
          and (k.state in ('armed', 'checking') or (k.state = 'fired' and exists (
            select 1 from situation x where x.id = k.situation_id
              and x.state in ('open', 'routed'))))
        where c.status = 'active' and c.provider = 'drive'
        group by c.id, c.space_id`),
    ).map((row) => ({
      connectionId: row.id,
      spaceId: row.space_id,
      stream: 'documents' as const,
      seconds: row.soon ? DETECTOR_NEAR_SECONDS : DETECTOR_DAY_SECONDS,
    }));
    if (!this.detectors) return drives;
    const accounts = rows<{
      id: string;
      space_id: string;
      provider: string;
      soon: boolean;
      clocked: boolean;
      device: boolean;
      waits: boolean;
      day_start: string | null;
      day_end: string | null;
      time_zone: string | null;
    }>(
      await this.db.execute(sql`select c.id, c.space_id, c.provider,
          exists (select 1 from clock k where k.connection_id = c.id and k.state = 'armed'
            and k.fire_at <= ${new Date(now + HOUR).toISOString()}::timestamptz) as soon,
          exists (select 1 from clock k where k.connection_id = c.id
            and k.state in ('armed', 'checking')) as clocked,
          exists (select 1 from push_subscription p
            where p.principal_id = coalesce(s.owner_principal_id, (select id from owner limit 1)))
            as device,
          (exists (select 1 from clock k where k.space_id = c.space_id and k.state = 'armed'
              and k.rule = ${SITUATION_KINDS.replyOverdue})
            or exists (select 1 from situation x where x.space_id = c.space_id
              and x.kind = ${SITUATION_KINDS.replyOverdue} and x.state in ('open', 'routed'))) as waits,
          pr.day_start, pr.day_end, pr.time_zone
        from connection c join space s on s.id = c.space_id and s.removed_at is null
          left join lateral (select p.day_start, p.day_end, p.time_zone from experience_profile p
            join space ps on ps.id = p.space_id
            where ps.owner_principal_id = coalesce(s.owner_principal_id, (select id from owner limit 1))
              and ps.kind = 'personal' limit 1) pr on true
        where c.status = 'active' and c.shared_use = 'owner'`),
    );
    const wanted: Array<{
      connectionId: string;
      spaceId: string;
      stream: 'mail' | 'calendar' | 'documents';
      seconds: number;
    }> = [...drives];
    for (const account of accounts) {
      if (
        (account.device || account.clocked) &&
        producesEvent(account.provider, 'calendar.event.changed')
      ) {
        const quiet = isQuiet(new Date(now), {
          start: account.day_start ?? '08:00',
          end: account.day_end ?? '22:00',
          timeZone: account.time_zone ?? 'UTC',
        });
        wanted.push({
          connectionId: account.id,
          spaceId: account.space_id,
          stream: 'calendar',
          seconds: account.soon
            ? DETECTOR_NEAR_SECONDS
            : quiet
              ? DETECTOR_QUIET_SECONDS
              : DETECTOR_DAY_SECONDS,
        });
      }
      if (account.waits && producesEvent(account.provider, 'mail.received'))
        wanted.push({
          connectionId: account.id,
          spaceId: account.space_id,
          stream: 'mail',
          seconds: DETECTOR_DAY_SECONDS,
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

type CommitmentRow = {
  id: string;
  space_id: string;
  principal_id: string;
  status: string;
  due_at: Date;
  due_date_only: boolean;
  job_id: string | null;
};

type KeptFields = Record<string, unknown> & {
  uid?: unknown;
  start?: unknown;
  end?: unknown;
  status?: unknown;
};

/**
 * Where an intent stands now: its own state, unless the work that carries it
 * out has ended, which is the answer whatever the row says yet.
 */
export function intentStateNow(item: { state: string; run_state: string | null }): string {
  if (!['active', 'waiting', 'at_risk'].includes(item.state)) return item.state;
  if (item.run_state === 'completed') return 'done';
  if (item.run_state === 'failed') return 'failed';
  if (item.run_state === 'cancelled') return 'cancelled';
  return item.state;
}

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

/** Only small typed values from a fresh read are tested; nothing of it is kept. */
function scalars(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields).slice(0, 50))
    if (value === null || typeof value === 'boolean' || typeof value === 'number') out[key] = value;
    else if (typeof value === 'string') out[key] = value.slice(0, 1000);
  return out;
}

const clip = (value: string, length: number) =>
  value.length > length ? `${value.slice(0, length - 1)}…` : value;

/**
 * Whether a person still uses a space: it is their own personal space, or
 * they hold a membership there that has neither been ended nor run out.
 */
export function belongs(spaceId: ReturnType<typeof sql>, principalId: ReturnType<typeof sql>) {
  return sql`(exists (select 1 from space bs where bs.id = ${spaceId} and bs.kind = 'personal'
      and coalesce(bs.owner_principal_id, (select id from owner limit 1)) = ${principalId})
    or exists (select 1 from space_membership bm where bm.space_id = ${spaceId}
      and bm.principal_id = ${principalId} and bm.revoked_at is null
      and (bm.expires_at is null or bm.expires_at > now())))`;
}

/** A parenthesised SQL list of values, for `in`. */
function sqlList(values: readonly string[]) {
  return sql`(${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}
