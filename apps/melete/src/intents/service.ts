/**
 * Intents: holding on to what the person wants done until it is done.
 *
 * - **Capture.** A conversation calls `intent.capture`. The person's words are
 *   read by the service from their own message in that conversation, never
 *   taken from the model, and each detail is marked `person` only when those
 *   words say it (`origins.ts`). The intent, its standing run and its deadline
 *   clock are made in one transaction. The same message read the same way
 *   twice keeps one intent.
 * - **Follow-through.** The run does the work. A deadline gets a clock
 *   (`SituationService.keepDeadline`): at T − lead an unfinished intent raises
 *   one `deadline.at_risk` situation, which also reaches its run. Only a
 *   deadline the person said is kept as theirs, so only that one may reach
 *   them at any hour. At T an intent still open expires, its run stops, and
 *   the person is told.
 * - **Adoption.** A commitment or a chase the person takes up becomes an
 *   intent once: its work and its clock are the ones it already has.
 * - **Cancel.** Stops the run, lets go of the clock, and takes back what the
 *   work changed, newest first, through `reverse` when it is wired; what
 *   cannot be taken back is listed.
 *
 * Details change only from the person: an edit through the API, whose values
 * become theirs. The model never writes origins, authority or state.
 */
import { createHash } from 'node:crypto';
import {
  type CapabilityClaims,
  type IntentKind,
  type IntentView,
  intentCaptureInput,
  intentConstraints,
  intentEdit,
  intentView,
  isOpenIntent,
  SITUATION_KINDS,
  type ValueOrigin,
  watchPredicate,
} from '@melete/contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import { requireCurrentAttempt } from '../jobs/fence.ts';
import type { JobService } from '../jobs/service.ts';
import type { RunService } from '../runs/service.ts';
import type { SituationService } from '../situations/service.ts';
import { dueOf, GUESS, intentLeadSeconds, markOrigins, readBack } from './origins.ts';
import { intent, intentEffect } from './schema.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Closed intents stay on Home this long, so the person sees how they ended. */
export const CLOSED_SHOWN_MS = DAY;
const OPEN = ['active', 'waiting', 'at_risk'] as const;

export type IntentRow = typeof intent.$inferSelect;
export type IntentEffectRow = typeof intentEffect.$inferSelect;

/** One step of taking back what an intent's work changed. */
export type ReversalStep = { effect: IntentEffectRow; ok: boolean; reason?: string };

export type IntentDeps = {
  jobs: JobService;
  runs: RunService;
  /** Deadline clocks and situations. Without it, intents keep no clocks. */
  situations?: SituationService;
  /**
   * Takes back an intent's changes, given oldest first, newest first, each
   * step tried even after one fails. Without it, cancelling stops the work
   * and lists what it changed as kept.
   */
  reverse?: (effects: readonly IntentEffectRow[], intent: IntentRow) => Promise<ReversalStep[]>;
  now?: () => number;
};

const rows = <T>(value: unknown) => value as T[];
const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null);
const missing = () => new ServiceError('not_found', 'That was not found.', 404);

/** What the run is asked to do, from the intent: the person's words, and every guess marked. */
function goalOf(row: {
  id: string;
  words: string;
  title: string;
  kind: string;
  line: string;
  doneWhen: string;
  deadline: string | null;
  deadlineOrigin: ValueOrigin | null;
}): string {
  return [
    row.words ? `What the person asked for, in their words: "${row.words}"` : null,
    `What it means: ${row.title} (${row.kind}).`,
    `Read back to them: ${row.line}`,
    `Details marked ${GUESS} are your reading, not theirs: check them with the person before anything goes outside Melete on them.`,
    row.deadline
      ? `It has to be done by ${row.deadline}${row.deadlineOrigin === 'inferred' ? ` ${GUESS}` : ''}.`
      : null,
    `It is done when: ${row.doneWhen}`,
    'Keep at it until it is done. Ask the person when you need them, and finish when it is done.',
  ]
    .filter(Boolean)
    .join('\n');
}

export class IntentService {
  constructor(readonly deps: IntentDeps) {}

  get db(): Database {
    return this.deps.jobs.db;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async timeZone(tx: Transaction | Database, spaceId: string): Promise<string> {
    const [row] = rows<{ time_zone: string }>(
      await tx.execute(sql`select time_zone from experience_profile where space_id = ${spaceId}`),
    );
    return row?.time_zone ?? 'UTC';
  }

  // ------------------------------------------------------------------------
  // capture
  // ------------------------------------------------------------------------

  /** `intent.capture`, from a conversation's attempt. */
  async capture(claims: CapabilityClaims, raw: unknown): Promise<unknown> {
    if (!claims.scopes.includes('intent.capture'))
      throw new ServiceError('scope_denied', 'intent.capture is not available here.', 403);
    const input = intentCaptureInput.parse(raw);
    const made = await this.deps.jobs.transaction(async (tx) => {
      const { job: chat } = await requireCurrentAttempt(tx, claims);
      if (chat.kind !== 'chat')
        throw new ServiceError(
          'scope_denied',
          'Keep hold of what the person wants from the conversation they said it in.',
          403,
        );
      if (chat.audience === 'room')
        throw new ServiceError(
          'scope_denied',
          'In a room, what someone wants is theirs to ask for in their own chat.',
          403,
        );
      const [person] = rows<{ id: string }>(
        await tx.execute(
          sql`select coalesce(${chat.principalId}, (select id from owner limit 1)) as id`,
        ),
      );
      const principalId = person?.id;
      if (!principalId) throw missing();
      // The person's own words, read here: the latest message they typed in
      // this conversation, or the one named. An option they picked from ones
      // offered is a choice, not their words.
      const [message] = rows<{
        seq: number;
        created_at: Date;
        text: string | null;
        speaker: string | null;
      }>(
        await tx.execute(sql`select seq, created_at, payload->>'text' as text,
            payload->>'principal_id' as speaker
          from event where job_id = ${chat.id} and type = 'notice'
            and payload->>'kind' = 'user_message' and payload->'chosen' is null
            ${input.message_id ? sql`and seq = ${Number(input.message_id)}` : sql``}
          order by seq desc limit 1`),
      );
      const words = (message?.text ?? '').trim();
      if (!message || !words || (message.speaker ?? principalId) !== principalId)
        throw new ServiceError(
          'invalid_request',
          'There is no message from the person here to keep: capture what they asked for in their own words.',
          400,
        );
      const constraints = intentConstraints.parse(input.constraints ?? {});
      const sourceKey = `message:${message.seq}:${createHash('sha256')
        .update(`${input.kind}\n${input.title.trim().toLowerCase()}`)
        .digest('hex')
        .slice(0, 16)}`;
      const [kept] = await tx
        .select()
        .from(intent)
        .where(
          and(
            eq(intent.spaceId, chat.spaceId),
            eq(intent.principalId, principalId),
            eq(intent.sourceKey, sourceKey),
          ),
        );
      if (kept) return { row: kept, clock: null, again: true };
      const zone = await this.timeZone(tx, chat.spaceId);
      const deadline = input.deadline_at ?? null;
      const due = deadline ? dueOf(deadline, zone) : null;
      if (due !== null && due <= this.now())
        throw new ServiceError(
          'invalid_deadline',
          'That deadline has already passed. Ask the person when it has to be done by.',
          400,
        );
      const origins = markOrigins(constraints, deadline, {
        words,
        eventAt: new Date(message.created_at).toISOString(),
        timeZone: zone,
      });
      const id = newId('int');
      const shown = readBack({ title: input.title, constraints, deadline, origins }, zone);
      const doneWhen = input.done_when ?? `${input.title.replace(/[.\s]+$/, '')} is done.`;
      const deadlineOrigin = deadline ? (origins.deadline_at ?? 'inferred') : null;
      const run = await this.deps.runs.create(
        tx,
        chat.spaceId,
        {
          title: input.title,
          goal: goalOf({
            id,
            words,
            title: input.title,
            kind: input.kind,
            line: shown.line,
            doneWhen,
            deadline: deadline
              ? (shown.parts
                  .find((part) => part.path === 'deadline_at')
                  ?.text.replace(/^by /, '') ?? deadline)
              : null,
            deadlineOrigin,
          }),
          done_when: doneWhen,
        },
        { conversation: chat, agentId: chat.agentId, principalId: chat.principalId },
      );
      const [row] = await tx
        .insert(intent)
        .values({
          id,
          spaceId: chat.spaceId,
          principalId,
          source: 'chat',
          sourceKey,
          conversationId: chat.id,
          runId: run.id,
          words,
          title: input.title,
          kind: input.kind,
          constraints,
          origins,
          success: { done_when: doneWhen },
          state: 'active',
          deadlineAt: due === null ? null : new Date(due),
          deadlineDay: deadline && /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : null,
          deadlineOrigin,
          subjectKey: `intent:${id}`,
        })
        .returning();
      if (!row) throw new Error('intent insert lost');
      const clock = await this.keepClock(tx, row);
      return { row, clock, again: false };
    });
    if (made.clock) this.deps.situations?.wake(made.clock);
    const view = await this.view(made.row);
    return {
      status: made.again ? 'already_kept' : 'kept',
      intent_id: view.id,
      read_back: view.read_back.line,
      guesses: view.read_back.parts
        .filter((part) => part.origin === 'inferred')
        .map((part) => part.text),
      instruction: made.again
        ? 'This was already kept. Tell the person the read-back line in one sentence, and end this reply.'
        : `Tell the person the read-back line in one short sentence, keeping every "${GUESS}" mark, so they can correct it. It is being worked on in the background now and shows on their Home: do not do the work here, and do not wait or check on it.`,
    };
  }

  /**
   * The clock for an intent's deadline: looked at T − lead, raising one
   * situation if it is still open then. A deadline is the person's only when
   * they said it; a day alone is never urgent.
   */
  private async keepClock(tx: Transaction, row: IntentRow) {
    const situations = this.deps.situations;
    if (!situations || !row.deadlineAt || !isOpenIntent(row.state)) return null;
    const due = row.deadlineAt.getTime();
    return situations.keepDeadline(tx, {
      spaceId: row.spaceId,
      principalId: row.principalId,
      subjectKey: row.subjectKey,
      title: row.title,
      dueAt: row.deadlineAt,
      leadSeconds: intentLeadSeconds(row.kind as IntentKind, due, this.now()),
      atRisk: watchPredicate.parse({
        all: [{ field: 'state', op: 'matches', value: `^(${OPEN.join('|')})$` }],
      }),
      fresh: true,
      personSet: row.deadlineOrigin === 'person',
      jobId: row.runId,
      ...(row.deadlineDay ? { dateOnly: row.deadlineDay } : {}),
    });
  }

  // ------------------------------------------------------------------------
  // adoption
  // ------------------------------------------------------------------------

  /**
   * A commitment the person took up ("Handle it") becomes an intent once. Its
   * work and its deadline clock are the ones it already has; nothing is made
   * twice. Its due date came from a message, so it is never the person's.
   */
  async adoptCommitment(input: { spaceId: string; principalId: string; itemId: string }) {
    await this.deps.jobs.transaction(async (tx) => {
      const [item] = rows<{
        id: string;
        summary: string;
        due_at: Date | null;
        due_date_only: boolean;
        job_id: string | null;
        status: string;
      }>(
        await tx.execute(sql`select id, summary, due_at, due_date_only, job_id, status
          from ledger_item where id = ${input.itemId} and space_id = ${input.spaceId}
            and principal_id = ${input.principalId}`),
      );
      if (!item || !['found', 'handling', 'waiting'].includes(item.status)) return;
      const zone = await this.timeZone(tx, input.spaceId);
      const day = item.due_at && item.due_date_only ? item.due_at.toISOString().slice(0, 10) : null;
      const deadline = item.due_at ? (day ?? item.due_at.toISOString()) : null;
      await this.adopt(tx, {
        ...input,
        source: 'commitment',
        sourceKey: `ledger:${item.id}`,
        title: item.summary,
        kind: 'other',
        runId: item.job_id,
        deadlineAt: deadline ? new Date(dueOf(deadline, zone)) : null,
        deadlineDay: day,
        state: item.status === 'waiting' ? 'waiting' : 'active',
      });
    });
  }

  /** A reply the person asked Melete to chase becomes an intent once, worked by its chase. */
  async adoptChase(input: { spaceId: string; principalId: string; awaitedId: string }) {
    await this.deps.jobs.transaction(async (tx) => {
      const [wait] = rows<{
        id: string;
        to_name: string | null;
        to_address: string;
        job_id: string | null;
        status: string;
      }>(
        await tx.execute(sql`select id, to_name, to_address, job_id, status from awaited_reply
          where id = ${input.awaitedId} and space_id = ${input.spaceId}
            and principal_id = ${input.principalId}`),
      );
      if (!wait || !['found', 'handling', 'waiting'].includes(wait.status)) return;
      await this.adopt(tx, {
        ...input,
        source: 'chase',
        sourceKey: `awaited:${wait.id}`,
        title: `Get an answer from ${wait.to_name?.trim() || wait.to_address}`,
        kind: 'reply',
        runId: wait.job_id,
        deadlineAt: null,
        deadlineDay: null,
        state: wait.status === 'waiting' ? 'waiting' : 'active',
      });
    });
  }

  private async adopt(
    tx: Transaction,
    input: {
      spaceId: string;
      principalId: string;
      source: 'commitment' | 'chase';
      sourceKey: string;
      title: string;
      kind: IntentKind;
      runId: string | null;
      deadlineAt: Date | null;
      deadlineDay: string | null;
      state: 'active' | 'waiting';
    },
  ) {
    const at = new Date(this.now());
    const origins: Record<string, ValueOrigin> = input.deadlineAt
      ? { deadline_at: 'inferred' }
      : {};
    // Taken up again after it was let go: it is open again, with the work it has now.
    await tx.execute(sql`insert into intent (id, space_id, principal_id, source, source_key,
        run_id, words, title, kind, constraints, origins, success, state, deadline_at,
        deadline_day, deadline_origin, subject_key, created_at, updated_at)
      values (${newId('int')}, ${input.spaceId}, ${input.principalId}, ${input.source},
        ${input.sourceKey}, ${input.runId}, '', ${input.title.slice(0, 300) || 'Something to follow up'},
        ${input.kind}, '{}'::jsonb, ${JSON.stringify(origins)}::jsonb,
        ${JSON.stringify({ done_when: 'It is settled.' })}::jsonb, ${input.state},
        ${iso(input.deadlineAt)}::timestamptz, ${input.deadlineDay},
        ${input.deadlineAt ? 'inferred' : null}, ${input.sourceKey},
        ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz)
      on conflict (space_id, principal_id, source_key) do update set
        run_id = coalesce(excluded.run_id, intent.run_id),
        state = case when intent.state in ('active', 'waiting', 'at_risk') then intent.state
          else excluded.state end,
        closed_reason = case when intent.state in ('active', 'waiting', 'at_risk')
          then intent.closed_reason else null end,
        closed_at = case when intent.state in ('active', 'waiting', 'at_risk')
          then intent.closed_at else null end,
        deadline_at = excluded.deadline_at, deadline_day = excluded.deadline_day,
        updated_at = excluded.updated_at`);
  }

  // ------------------------------------------------------------------------
  // what the person reads and does
  // ------------------------------------------------------------------------

  /** The person's open intents, and those that ended in the last day, deadline first. */
  async list(principalId: string): Promise<IntentView[]> {
    await this.settle();
    const since = new Date(this.now() - CLOSED_SHOWN_MS);
    const found = rows<{ id: string }>(
      await this.db.execute(sql`select i.id from intent i
        join space s on s.id = i.space_id and s.removed_at is null
        where i.principal_id = ${principalId}
          and (i.state in ('active', 'waiting', 'at_risk')
            or coalesce(i.closed_at, i.updated_at) > ${since.toISOString()}::timestamptz)
        order by (i.state in ('active', 'waiting', 'at_risk')) desc,
          i.deadline_at asc nulls last, i.created_at desc
        limit 50`),
    );
    if (!found.length) return [];
    const ids = found.map((row) => row.id);
    const all = await this.db.select().from(intent).where(inArray(intent.id, ids));
    const byId = new Map(all.map((row) => [row.id, row]));
    return this.views(ids.flatMap((id) => byId.get(id) ?? []));
  }

  private async views(list: IntentRow[]): Promise<IntentView[]> {
    const runIds = list.flatMap((row) => (row.runId ? [row.runId] : []));
    const runRows = runIds.length
      ? await this.db.select().from(job).where(inArray(job.id, runIds))
      : [];
    const runViews = new Map(
      (await this.deps.runs.views(runRows.filter((row) => row.kind === 'run'))).map((view) => [
        view.id,
        view,
      ]),
    );
    const runStates = new Map(runRows.map((row) => [row.id, row.state]));
    const zones = new Map<string, string>();
    const out: IntentView[] = [];
    for (const row of list) {
      let zone = zones.get(row.spaceId);
      if (!zone) {
        zone = await this.timeZone(this.db, row.spaceId);
        zones.set(row.spaceId, zone);
      }
      const constraints = intentConstraints.parse(row.constraints ?? {});
      const origins = row.origins as Record<string, ValueOrigin>;
      const deadline = row.deadlineDay ?? iso(row.deadlineAt);
      const shown = readBack({ title: row.title, constraints, deadline, origins }, zone);
      const run = row.runId ? runViews.get(row.runId) : undefined;
      const runState = row.runId ? (runStates.get(row.runId) ?? null) : null;
      out.push(
        intentView.parse({
          id: row.id,
          kind: row.kind,
          source: row.source,
          words: row.words,
          title: row.title,
          read_back: shown,
          constraints,
          origins,
          state: row.state,
          next_step: isOpenIntent(row.state)
            ? nextStep(
                row,
                run?.question ?? null,
                run?.next ?? null,
                run?.status_line ?? null,
                runState,
              )
            : null,
          deadline_at: iso(row.deadlineAt),
          deadline_origin: row.deadlineOrigin,
          conversation_id: row.conversationId,
          run_id: row.runId,
          version: row.version,
          closed_reason: row.closedReason,
          created_at: row.createdAt.toISOString(),
          updated_at: row.updatedAt.toISOString(),
        }),
      );
    }
    return out;
  }

  async view(row: IntentRow): Promise<IntentView> {
    const [view] = await this.views([row]);
    if (!view) throw missing();
    return view;
  }

  private async own(tx: Transaction, principalId: string, id: string): Promise<IntentRow> {
    const [row] = await tx
      .select()
      .from(intent)
      .where(and(eq(intent.id, id), eq(intent.principalId, principalId)))
      .for('update');
    if (!row) throw missing();
    return row;
  }

  /**
   * The person corrects the read-back. What they type becomes theirs; what
   * they leave stays as it was, guesses included. A new version, a deadline
   * clock kept to the new time, and the work told what changed.
   */
  async edit(principalId: string, id: string, raw: unknown): Promise<IntentView> {
    await this.settle();
    const input = intentEdit.parse(raw);
    const made = await this.deps.jobs.transaction(async (tx) => {
      const row = await this.own(tx, principalId, id);
      if (!isOpenIntent(row.state))
        throw new ServiceError('intent_closed', 'This has already ended.', 409);
      if (row.version !== input.version)
        throw new ServiceError(
          'revision_mismatch',
          'This changed since you opened it. Look again and make the change.',
          409,
        );
      const zone = await this.timeZone(tx, row.spaceId);
      const constraints = structuredClone(intentConstraints.parse(row.constraints ?? {})) as Record<
        string,
        Record<string, unknown> | unknown
      >;
      const origins = { ...(row.origins as Record<string, ValueOrigin>) };
      let title = row.title;
      let deadline: string | null = row.deadlineDay ?? iso(row.deadlineAt);
      const changed: string[] = [];
      for (const [path, value] of Object.entries(input.values)) {
        if (path === 'title') {
          if (typeof value !== 'string' || !value.trim())
            throw new ServiceError('invalid_request', 'Say what it is in a few words.', 400);
          title = value.trim().slice(0, 120);
        } else if (path === 'deadline_at') {
          deadline = value === null ? null : String(value);
          if (deadline !== null && dueOf(deadline, zone) <= this.now())
            throw new ServiceError('invalid_deadline', 'That time has already passed.', 400);
        } else {
          const [group, key] = path.split('.') as [string, string | undefined];
          if (key) {
            const current = (constraints[group] as Record<string, unknown> | undefined) ?? {};
            if (value === null) delete current[key];
            else
              current[key] = path === 'party.size' || path === 'budget.max' ? Number(value) : value;
            if (Object.keys(current).length) constraints[group] = current;
            else delete constraints[group];
          } else if (value === null) delete constraints[group];
          else constraints[group] = value;
        }
        if (value === null) delete origins[path];
        else origins[path] = 'person';
        changed.push(path);
      }
      const parsed = intentConstraints.safeParse(constraints);
      if (!parsed.success)
        throw new ServiceError(
          'invalid_request',
          'One of those details is not one Melete can keep.',
          400,
        );
      const due = deadline ? dueOf(deadline, zone) : null;
      if (due !== null && Number.isNaN(due))
        throw new ServiceError('invalid_deadline', 'That is not a time Melete can read.', 400);
      const [updated] = await tx
        .update(intent)
        .set({
          title,
          constraints: parsed.data,
          origins,
          deadlineAt: due === null ? null : new Date(due),
          deadlineDay: deadline && /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : null,
          deadlineOrigin: deadline ? (origins.deadline_at ?? 'inferred') : null,
          version: row.version + 1,
          state: row.state === 'at_risk' && changed.includes('deadline_at') ? 'active' : row.state,
          updatedAt: new Date(this.now()),
        })
        .where(eq(intent.id, row.id))
        .returning();
      if (!updated) throw new Error('intent update lost');
      let clock = null;
      if (changed.includes('deadline_at')) {
        if (updated.deadlineAt) clock = await this.keepClock(tx, updated);
        else
          await this.deps.situations?.clearSubject(
            tx,
            updated.spaceId,
            updated.subjectKey,
            'The person took the deadline away.',
          );
      }
      // The work reads what changed at its next shift.
      if (updated.runId) {
        const shown = readBack(
          { title: updated.title, constraints: parsed.data, deadline, origins },
          zone,
        );
        await appendEvent(tx, {
          jobId: updated.runId,
          type: 'notice',
          payload: {
            kind: 'trigger_event',
            trigger_id: null,
            event: {
              kind: 'operation_event',
              event_name: 'intent.changed',
              payload: { intent_id: updated.id, version: updated.version, read_back: shown.line },
            },
            because: [`intent:${updated.id}:v${updated.version}`],
          },
          dedupKey: `intent:${updated.id}:v${updated.version}`,
        });
      }
      return { row: updated, clock };
    });
    if (made.clock) this.deps.situations?.wake(made.clock);
    return this.view(made.row);
  }

  /**
   * The person cancels: the work stops, the deadline is let go, and what the
   * work changed is taken back newest first where it can be. Cancelling again
   * answers with how it ended.
   */
  async cancel(
    principalId: string,
    id: string,
  ): Promise<{ intent: IntentView; effects: CancelledEffect[] }> {
    await this.settle();
    const closed = await this.deps.jobs.transaction(async (tx) => {
      const row = await this.own(tx, principalId, id);
      if (!isOpenIntent(row.state)) return { row, fresh: false };
      const at = new Date(this.now());
      const [updated] = await tx
        .update(intent)
        .set({
          state: 'cancelled',
          closedReason: 'You cancelled it.',
          closedAt: at,
          updatedAt: at,
        })
        .where(eq(intent.id, row.id))
        .returning();
      // Its own clock goes with it; one it shares with what it was taken up from stays.
      if (row.subjectKey === `intent:${row.id}`)
        await this.deps.situations?.clearSubject(tx, row.spaceId, row.subjectKey, 'Cancelled.');
      return { row: updated ?? row, fresh: true };
    });
    if (closed.fresh && closed.row.runId) {
      const [work] = await this.db.select().from(job).where(eq(job.id, closed.row.runId));
      if (work && work.kind === 'run') await this.deps.runs.stop(work);
      else if (work && !['completed', 'failed', 'cancelled'].includes(work.state))
        await this.deps.jobs
          .cancel(work.id, 'The person cancelled what this was for.')
          .catch(() => undefined);
    }
    const effects = closed.fresh ? await this.takeBack(closed.row) : [];
    return { intent: await this.view(closed.row), effects };
  }

  /** What the work changed, taken back newest first through `reverse`, or listed as kept. */
  private async takeBack(row: IntentRow): Promise<CancelledEffect[]> {
    await this.recordEffects(row);
    const effects = await this.db
      .select()
      .from(intentEffect)
      .where(and(eq(intentEffect.intentId, row.id), eq(intentEffect.state, 'done')))
      .orderBy(intentEffect.doneAt, intentEffect.actionId);
    if (!effects.length) return [];
    const kinds = new Map(
      rows<{ id: string; kind: string }>(
        await this.db.execute(sql`select id, kind from action
          where id in ${sqlList(effects.map((effect) => effect.actionId))}`),
      ).map((entry) => [entry.id, entry.kind]),
    );
    const steps: ReversalStep[] = this.deps.reverse
      ? await this.deps.reverse(effects, row)
      : [...effects].reverse().map((effect) => ({ effect, ok: false, reason: 'kept' }));
    const out: CancelledEffect[] = [];
    for (const step of steps) {
      const kept = !this.deps.reverse;
      const state = step.ok ? 'reversed' : kept ? 'kept' : 'failed';
      await this.db
        .update(intentEffect)
        .set({ state, note: step.ok ? null : kept ? null : (step.reason ?? null) })
        .where(
          and(
            eq(intentEffect.intentId, step.effect.intentId),
            eq(intentEffect.actionId, step.effect.actionId),
          ),
        );
      out.push({
        action_id: step.effect.actionId,
        title: effectTitle(kinds.get(step.effect.actionId) ?? 'change'),
        outcome: state,
        reason: state === 'failed' ? (step.reason ?? 'It could not be taken back.') : null,
      });
    }
    return out;
  }

  /** What the intent's work changed outside Melete so far, in the order it happened. */
  async recordEffects(row: Pick<IntentRow, 'id' | 'runId' | 'spaceId'>) {
    if (!row.runId) return;
    await this.db.execute(sql`insert into intent_effect (intent_id, action_id, role, state, done_at)
      select ${row.id}, a.id, 'primary', 'done', coalesce(a.resolved_at, a.dispatched_at, now())
      from action a join job j on j.id = a.job_id
      left join run_state r on r.job_id = j.id
      where (j.id = ${row.runId} or r.parent_run_id = ${row.runId})
        and j.space_id = ${row.spaceId}
        and a.status = 'succeeded' and a.effect_class <> 'read'
      on conflict (intent_id, action_id) do nothing`);
  }

  // ------------------------------------------------------------------------
  // keeping up
  // ------------------------------------------------------------------------

  /**
   * Bring intents in line with their work and their sources: work that ended
   * ends its intent; a commitment or a chase settled or dropped ends its.
   */
  async settle(): Promise<void> {
    const at = new Date(this.now()).toISOString();
    await this.db.execute(sql`update intent i set
        state = case j.state when 'completed' then 'done' when 'failed' then 'failed'
          else 'cancelled' end,
        closed_reason = case j.state when 'completed' then 'Done.'
          when 'failed' then 'The work on it failed.' else 'Its work was stopped.' end,
        closed_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
      from job j
      where j.id = i.run_id and i.source = 'chat'
        and i.state in ('active', 'waiting', 'at_risk')
        and j.state in ('completed', 'failed', 'cancelled')`);
    for (const [table, prefix] of [
      ['ledger_item', 'ledger:'],
      ['awaited_reply', 'awaited:'],
    ] as const)
      await this.db.execute(sql`update intent i set
          state = case s.status when 'settled' then 'done' when 'dropped' then 'cancelled'
            when 'waiting' then (case when i.state = 'at_risk' then 'at_risk' else 'waiting' end)
            else (case when i.state = 'at_risk' then 'at_risk' else 'active' end) end,
          closed_reason = case s.status when 'settled' then 'Settled.'
            when 'dropped' then 'It was let go.' else null end,
          closed_at = case when s.status in ('settled', 'dropped') then ${at}::timestamptz else null end,
          run_id = coalesce(s.job_id, i.run_id),
          updated_at = ${at}::timestamptz
        from ${sql.raw(table)} s
        where i.source_key = ${prefix} || s.id and i.space_id = s.space_id
          and i.state in ('active', 'waiting', 'at_risk')
          and (s.status in ('settled', 'dropped')
            or (s.status = 'waiting') <> (i.state = 'waiting')
            or s.job_id is distinct from i.run_id)`);
  }

  /**
   * At its deadline an intent still open expires: the work stops, and the
   * person is told plainly, while a next step may still exist.
   */
  async expire(): Promise<number> {
    await this.settle();
    const at = new Date(this.now());
    const ended = await this.deps.jobs.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(intent)
        .where(
          and(
            inArray(intent.state, [...OPEN]),
            sql`${intent.deadlineAt} <= ${at.toISOString()}::timestamptz`,
            eq(intent.source, 'chat'),
          ),
        )
        .for('update', { skipLocked: true })
        .limit(50);
      for (const row of due) {
        await tx
          .update(intent)
          .set({
            state: 'expired',
            closedReason: 'Its deadline passed before it was done.',
            closedAt: at,
            updatedAt: at,
          })
          .where(eq(intent.id, row.id));
        await this.deps.situations?.raiseIn(tx, {
          kind: SITUATION_KINDS.intentExpired,
          subjectKey: row.subjectKey,
          window: row.deadlineAt?.toISOString() ?? '',
          fingerprint: `expired:${row.deadlineAt?.toISOString() ?? ''}`,
          urgency: row.deadlineOrigin === 'person' ? 'soon' : 'normal',
          title: row.title,
          reason: 'Its deadline passed before it was done. Melete stopped working on it.',
          evidence: { due_at: row.deadlineAt?.toISOString() ?? null },
          deadlineAt: row.deadlineAt?.toISOString() ?? null,
          expiresAt: new Date(at.getTime() + DAY).toISOString(),
          spaceId: row.spaceId,
          principalId: row.principalId,
          connectionId: null,
          personSet: row.deadlineOrigin === 'person',
          because: [`intent:${row.id}`],
          origin: row.deadlineOrigin === 'person' ? 'person' : 'service',
          pushBecause:
            row.deadlineOrigin === 'person'
              ? 'Because you asked Melete to have this done by then.'
              : 'Because it had a deadline.',
        });
      }
      return due;
    });
    for (const row of ended) {
      if (!row.runId) continue;
      const [work] = await this.db.select().from(job).where(eq(job.id, row.runId));
      if (work?.kind === 'run') await this.deps.runs.stop(work).catch(() => undefined);
    }
    return ended.length;
  }

  /** One pass, run with the clock sweep. */
  async sweep(): Promise<void> {
    await this.expire();
  }
}

export type CancelledEffect = {
  action_id: string;
  title: string;
  outcome: 'reversed' | 'kept' | 'failed';
  reason: string | null;
};

/** What happens next, in plain words. */
function nextStep(
  row: IntentRow,
  question: string | null,
  next: string | null,
  statusLine: string | null,
  runState: string | null,
): string {
  if (row.source !== 'chat') {
    if (!row.runId) return 'Waiting for you to start it';
    return row.state === 'waiting' ? 'Waiting on them' : 'Handling it';
  }
  if (question) return 'Needs your answer';
  if (row.state === 'at_risk') return 'Running out of time';
  if (!runState) return 'Getting started';
  return next ?? statusLine ?? 'Working on it';
}

function effectTitle(kind: string): string {
  const words = kind.replace(/[._-]+/g, ' ').trim();
  return words ? `${words[0]?.toUpperCase()}${words.slice(1)}` : 'A change';
}

function sqlList(values: readonly string[]) {
  return sql`(${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;
}
