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
import { REVERSALS, reverseInOrder } from '../broker/reversals.ts';
import type { Database } from '../db/client.ts';
import { action, job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import { requireCurrentAttempt } from '../jobs/fence.ts';
import type { JobService } from '../jobs/service.ts';
import { OUTDATED_NOTE, withdrawPermissions } from '../jobs/withdraw.ts';
import { principalContext } from '../principals/authority.ts';
import type { RunService } from '../runs/service.ts';
import type { SituationService } from '../situations/service.ts';
import { intentStateNow } from '../situations/service.ts';
import { dueOf, GUESS, intentLeadSeconds, markOrigins, readBack } from './origins.ts';
import type { Span } from './said.ts';
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
   * step tried even after one fails, with each reason in words for the
   * person (`undoThrough` builds one on Undo). Without it, cancelling stops
   * the work and lists what it changed as kept.
   */
  reverse?: (effects: readonly IntentEffectRow[], intent: IntentRow) => Promise<ReversalStep[]>;
  now?: () => number;
};

const rows = <T>(value: unknown) => value as T[];
const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null);
const missing = () => new ServiceError('not_found', 'That was not found.', 404);

/** The stretches a message records as pasted, as far as they read as stretches at all. */
function pastedSpans(raw: unknown): Span[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((span) => {
    const start = (span as { start?: unknown } | null)?.start;
    const end = (span as { end?: unknown } | null)?.end;
    return typeof start === 'number' && typeof end === 'number' ? [{ start, end }] : [];
  });
}

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
        pasted: unknown;
      }>(
        await tx.execute(sql`select seq, created_at, payload->>'text' as text,
            payload->>'principal_id' as speaker, payload->'pasted' as pasted
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
      // Origins read the message as sent, so the composer's pasted stretches line up with it.
      const origins = markOrigins(constraints, deadline, {
        words: message.text ?? '',
        pasted: pastedSpans(message.pasted),
        eventAt: new Date(message.created_at).toISOString(),
        timeZone: zone,
      });
      const id = newId('int');
      const shown = readBack({ title: input.title, constraints, deadline, origins }, zone);
      const doneWhen = input.done_when ?? `${input.title.replace(/[.\s]+$/, '')} is done.`;
      const deadlineOrigin = deadline ? (origins.deadline_at ?? 'inferred') : null;
      const run = await this.startWork(
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
   * The run that carries an intent out. Long work in one space is capped; past
   * the cap the person is told plainly, in the words the model relays.
   */
  private async startWork(
    tx: Transaction,
    spaceId: string,
    input: Parameters<RunService['create']>[2],
    origin: Parameters<RunService['create']>[3],
  ) {
    try {
      return await this.deps.runs.create(tx, spaceId, input, origin);
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'too_many_runs')
        throw new ServiceError(
          'too_many_intents',
          'Melete is already working on as many things in the background here as it can at once. Tell the person this one is not kept yet, and that they can cancel something under What I’m on at Home, then ask again.',
          409,
        );
      throw error;
    }
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
      // A raw row's timestamp may arrive as text.
      const dueAt = item.due_at ? new Date(item.due_at) : null;
      const day = dueAt && item.due_date_only ? dueAt.toISOString().slice(0, 10) : null;
      const deadline = dueAt ? (day ?? dueAt.toISOString()) : null;
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
    // Taken up again after it was let go: it is open again, with the work it
    // has now. A deadline the person set on it stays theirs.
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
        deadline_at = case when intent.deadline_origin = 'person' then intent.deadline_at
          else excluded.deadline_at end,
        deadline_day = case when intent.deadline_origin = 'person' then intent.deadline_day
          else excluded.deadline_day end,
        origins = case when intent.deadline_origin = 'person' then intent.origins
          else excluded.origins end,
        deadline_origin = case when intent.deadline_origin = 'person' then 'person'
          else excluded.deadline_origin end,
        updated_at = excluded.updated_at`);
  }

  // ------------------------------------------------------------------------
  // what the person reads and does
  // ------------------------------------------------------------------------

  /**
   * The person's open intents, and those that ended in the last day, deadline
   * first. Reading writes nothing: where each one stands is worked out from its
   * work and its source as they are now, and the sweep catches the rows up.
   */
  async list(principalId: string): Promise<IntentView[]> {
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

  /** Where each intent stands now, from its row, its work and what it was taken up from. */
  private async standings(
    tx: Transaction | Database,
    list: IntentRow[],
  ): Promise<
    Map<string, { state: IntentRow['state']; reason: string | null; runState: string | null }>
  > {
    const runIds = list.flatMap((row) => (row.runId ? [row.runId] : []));
    const runStates = new Map(
      runIds.length
        ? rows<{ id: string; state: string }>(
            await tx.execute(sql`select id, state from job where id in ${sqlList(runIds)}`),
          ).map((entry) => [entry.id, entry.state])
        : [],
    );
    const sourceIds = (prefix: string) =>
      list.flatMap((row) =>
        row.sourceKey.startsWith(prefix) ? [row.sourceKey.slice(prefix.length)] : [],
      );
    const statuses = new Map<string, string>();
    for (const [table, prefix] of [
      ['ledger_item', 'ledger:'],
      ['awaited_reply', 'awaited:'],
    ] as const) {
      const wanted = sourceIds(prefix);
      if (!wanted.length) continue;
      for (const entry of rows<{ id: string; status: string }>(
        await tx.execute(
          sql`select id, status from ${sql.raw(table)} where id in ${sqlList(wanted)}`,
        ),
      ))
        statuses.set(`${prefix}${entry.id}`, entry.status);
    }
    const out = new Map<
      string,
      { state: IntentRow['state']; reason: string | null; runState: string | null }
    >();
    for (const row of list) {
      const runState = row.runId ? (runStates.get(row.runId) ?? null) : null;
      out.set(row.id, {
        ...standingOf(row, runState, statuses.get(row.sourceKey) ?? null),
        runState,
      });
    }
    return out;
  }

  private async views(list: IntentRow[]): Promise<IntentView[]> {
    const standing = await this.standings(this.db, list);
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
      const now = standing.get(row.id) ?? {
        state: row.state,
        reason: row.closedReason,
        runState: null,
      };
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
          state: now.state,
          next_step: isOpenIntent(now.state)
            ? nextStep(
                { ...row, state: now.state },
                run?.question ?? null,
                run?.next ?? null,
                run?.status_line ?? null,
                now.runState,
              )
            : null,
          deadline_at: iso(row.deadlineAt),
          deadline_origin: row.deadlineOrigin,
          conversation_id: row.conversationId,
          run_id: row.runId,
          version: row.version,
          closed_reason: now.reason,
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

  /** The caller's own intent, locked, with where it stands now. */
  private async own(
    tx: Transaction,
    principalId: string,
    id: string,
  ): Promise<{ row: IntentRow; state: IntentRow['state'] }> {
    const [row] = await tx
      .select()
      .from(intent)
      .where(and(eq(intent.id, id), eq(intent.principalId, principalId)))
      .for('update');
    if (!row) throw missing();
    const now = (await this.standings(tx, [row])).get(row.id);
    return { row, state: now?.state ?? row.state };
  }

  /** The jobs an intent's work runs in: its run and the run's helpers. */
  private async workOf(tx: Transaction, runId: string): Promise<string[]> {
    const steps = rows<{ job_id: string }>(
      await tx.execute(sql`select job_id from run_state where parent_run_id = ${runId}`),
    );
    return [runId, ...steps.map((step) => step.job_id)];
  }

  /**
   * The person corrects the read-back. What they type becomes theirs; what
   * they leave stays as it was, guesses included. A new version, a deadline
   * kept to the new time, approvals still waiting on the old details
   * withdrawn, and the work told what changed. A commitment's deadline is the
   * commitment's own: changing it moves the commitment's due date and its clock.
   */
  async edit(principalId: string, id: string, raw: unknown): Promise<IntentView> {
    const input = intentEdit.parse(raw);
    const made = await this.deps.jobs.transaction(async (tx) => {
      const { row, state } = await this.own(tx, principalId, id);
      if (!isOpenIntent(state))
        throw new ServiceError('intent_closed', 'This has already ended.', 409);
      if (row.version !== input.version)
        throw new ServiceError(
          'revision_mismatch',
          'This changed since you opened it. Look again and make the change.',
          409,
        );
      const movesDeadline = Object.hasOwn(input.values, 'deadline_at');
      if (movesDeadline && row.source === 'chase')
        throw new ServiceError(
          'intent_follows_source',
          'This follows the reply itself, so it has no deadline of its own to change.',
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
          state: row.state === 'at_risk' && movesDeadline ? 'active' : row.state,
          updatedAt: new Date(this.now()),
        })
        .where(eq(intent.id, row.id))
        .returning();
      if (!updated) throw new Error('intent update lost');
      let clock = null;
      let commitment: string | null = null;
      if (movesDeadline && row.source === 'commitment') {
        // The commitment's own due date moves, and its own clock with it.
        commitment = row.sourceKey.slice('ledger:'.length);
        // A day alone is kept the way commitments keep one: that date at UTC
        // midnight, read back as the day itself wherever the person is.
        const stored =
          due === null
            ? null
            : updated.deadlineDay
              ? `${updated.deadlineDay}T00:00:00.000Z`
              : new Date(due).toISOString();
        await tx.execute(sql`update ledger_item set
            due_at = ${stored}::timestamptz,
            due_date_only = ${Boolean(updated.deadlineDay)}
          where id = ${commitment} and space_id = ${row.spaceId}
            and principal_id = ${row.principalId}`);
        if (due === null)
          await this.deps.situations?.clearSubject(
            tx,
            row.spaceId,
            row.sourceKey,
            'The person took the deadline away.',
            SITUATION_KINDS.deadlineAtRisk,
          );
      } else if (movesDeadline) {
        if (updated.deadlineAt) clock = await this.keepClock(tx, updated);
        else
          await this.deps.situations?.clearSubject(
            tx,
            updated.spaceId,
            updated.subjectKey,
            'The person took the deadline away.',
            SITUATION_KINDS.deadlineAtRisk,
          );
      }
      if (updated.runId) {
        // An approval still waiting was asked about the old details: it goes,
        // and the work asks again with the new ones if it still needs to.
        await withdrawPermissions(
          tx,
          inArray(action.jobId, await this.workOf(tx, updated.runId)),
          OUTDATED_NOTE,
        );
        // The work reads what changed at its next shift.
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
      return { row: updated, clock, commitment, due };
    });
    if (made.clock) this.deps.situations?.wake(made.clock);
    // A commitment kept to its new date by the commitment's own rules: the person set it.
    if (made.commitment && made.due !== null)
      await this.deps.situations?.acceptCommitment({
        spaceId: made.row.spaceId,
        principalId: made.row.principalId,
        itemId: made.commitment,
        byPerson: true,
      });
    return this.view(made.row);
  }

  /**
   * The person cancels: the work stops, the deadline is let go, and what the
   * work changed is taken back newest first where it can be. Something taken
   * up from Companies or Waiting on is handed back there, as Stop does, and its
   * own deadline clock is let go. Cancelling again answers with how it ended,
   * and takes back anything still left from a cancel that stopped partway.
   */
  async cancel(
    principalId: string,
    id: string,
  ): Promise<{ intent: IntentView; effects: CancelledEffect[] }> {
    const closed = await this.deps.jobs.transaction(async (tx) => {
      const { row, state } = await this.own(tx, principalId, id);
      if (!isOpenIntent(state)) return { row, fresh: false };
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
      await this.deps.situations?.clearSubject(
        tx,
        row.spaceId,
        row.subjectKey,
        'Cancelled.',
        SITUATION_KINDS.deadlineAtRisk,
      );
      if (row.source === 'commitment')
        await tx.execute(sql`update ledger_item set status = 'found', job_id = null
          where id = ${row.sourceKey.slice('ledger:'.length)} and space_id = ${row.spaceId}
            and status in ('handling', 'waiting')`);
      if (row.source === 'chase')
        await tx.execute(sql`update awaited_reply set status = 'found', job_id = null
          where id = ${row.sourceKey.slice('awaited:'.length)} and space_id = ${row.spaceId}
            and status in ('handling', 'waiting')`);
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
    const effects =
      closed.fresh || closed.row.state === 'cancelled' ? await this.takeBack(closed.row) : [];
    const [now] = await this.db.select().from(intent).where(eq(intent.id, closed.row.id));
    return { intent: await this.view(now ?? closed.row), effects };
  }

  /**
   * What the work changed, taken back newest first through `reverse`, or
   * listed as kept. A step left undone by a failure on the way is tried again
   * by the next cancel or by the sweep, and the intent says so meanwhile.
   */
  async takeBack(row: IntentRow): Promise<CancelledEffect[]> {
    let steps: ReversalStep[];
    let effects: IntentEffectRow[];
    try {
      await this.recordEffects(row);
      effects = await this.db
        .select()
        .from(intentEffect)
        .where(and(eq(intentEffect.intentId, row.id), eq(intentEffect.state, 'done')))
        .orderBy(intentEffect.doneAt, intentEffect.actionId);
      if (!effects.length) return [];
      steps = this.deps.reverse
        ? await this.deps.reverse(effects, row)
        : [...effects].reverse().map((effect) => ({ effect, ok: false }));
    } catch {
      await this.db
        .update(intent)
        .set({
          closedReason: STILL_TAKING_BACK,
          updatedAt: new Date(this.now()),
        })
        .where(eq(intent.id, row.id));
      return [];
    }
    const kinds = new Map(
      rows<{ id: string; kind: string }>(
        await this.db.execute(sql`select id, kind from action
          where id in ${sqlList(effects.map((effect) => effect.actionId))}`),
      ).map((entry) => [entry.id, entry.kind]),
    );
    const out: CancelledEffect[] = [];
    for (const step of steps) {
      const kept = !this.deps.reverse;
      const state = step.ok ? 'reversed' : kept ? 'kept' : 'failed';
      const reason = state === 'failed' ? plainReason(step.reason) : null;
      await this.db
        .update(intentEffect)
        .set({ state, note: reason })
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
        reason,
      });
    }
    // What stays as it is, said where the person looks for this intent.
    const staying = out.filter((step) => step.outcome !== 'reversed');
    await this.db
      .update(intent)
      .set({
        closedReason: staying.length
          ? `You cancelled it. Still in place: ${staying.map((step) => step.title.toLowerCase()).join(', ')}.`
          : 'You cancelled it.',
        updatedAt: new Date(this.now()),
      })
      .where(eq(intent.id, row.id));
    return out;
  }

  /**
   * What the intent's work changed so far, in the order it happened: what
   * reached outside Melete, and what declares a way to take it back. Work in
   * the agent's own computer is not listed.
   */
  async recordEffects(row: Pick<IntentRow, 'id' | 'runId' | 'spaceId'>) {
    if (!row.runId) return;
    const undoable = Object.entries(REVERSALS)
      .filter(([, declared]) => declared.mode === 'reversal' || declared.mode === 'compensation')
      .map(([kind]) => kind);
    await this.db.execute(sql`insert into intent_effect (intent_id, action_id, role, state, done_at)
      select ${row.id}, a.id, 'primary', 'done', coalesce(a.resolved_at, a.dispatched_at, now())
      from action a join job j on j.id = a.job_id
      left join run_state r on r.job_id = j.id
      where (j.id = ${row.runId} or r.parent_run_id = ${row.runId})
        and j.space_id = ${row.spaceId} and a.status = 'succeeded'
        and (a.effect_class in ('write_external', 'spend') or a.kind in ${sqlList(undoable)})
      on conflict (intent_id, action_id) do nothing`);
  }

  // ------------------------------------------------------------------------
  // keeping up
  // ------------------------------------------------------------------------

  /**
   * Bring intents in line with their work and their sources: work that ended
   * ends its intent; work that was removed fails it; a commitment or a chase
   * settled or dropped ends its. Runs on the sweep, never on a read.
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
    await this.db.execute(sql`update intent set state = 'failed',
        closed_reason = ${REMOVED}, closed_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
      where source = 'chat' and run_id is null and state in ('active', 'waiting', 'at_risk')`);
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
   * Cancels that stopped partway: what is still to be taken back is tried
   * again, as the person who cancelled, for a day after they did.
   */
  async retryCancels(): Promise<number> {
    const since = new Date(this.now() - CLOSED_SHOWN_MS).toISOString();
    const left = await this.db
      .select()
      .from(intent)
      .where(
        and(
          eq(intent.state, 'cancelled'),
          sql`${intent.closedAt} > ${since}::timestamptz`,
          sql`(${intent.closedReason} = ${STILL_TAKING_BACK} or exists (select 1 from intent_effect e
            where e.intent_id = ${intent.id} and e.state = 'done'))`,
        ),
      )
      .limit(20);
    for (const row of left) await principalContext.run(row.principalId, () => this.takeBack(row));
    return left.length;
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

  /** One pass, run with the clock sweep: catch rows up, expire what is due, finish cancels. */
  async sweep(): Promise<void> {
    await this.expire();
    await this.retryCancels();
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

/** Said where a cancel stopped partway, until what it changed has been taken back. */
const STILL_TAKING_BACK = 'You cancelled it. Melete is still taking back what it changed.';
const REMOVED = 'Its work was removed, so nothing more is being done on it.';

/** Why a step could not be taken back, in the words `reverse` gave, or plainly. */
function plainReason(reason: string | undefined): string {
  return reason?.trim() ? reason.trim().slice(0, 300) : 'It could not be taken back just now.';
}

/**
 * The `reverse` an IntentService takes, built on the person's own Undo: each
 * change taken back newest first, every step tried, and a step that cannot be
 * done explained in Undo's own words. Anything that goes wrong inside says only
 * that it could not be taken back.
 */
export function undoThrough(
  undo: (
    spaceId: string,
    actionId: string,
  ) => Promise<{ status: 'not_available'; reason: string } | object>,
): NonNullable<IntentDeps['reverse']> {
  return (effects, kept) =>
    reverseInOrder(effects, async (effect) => {
      try {
        const done = await undo(kept.spaceId, effect.actionId);
        // Undo's own reasons are written for the person.
        if ('status' in done && done.status === 'not_available')
          return { ok: false, reason: done.reason };
        return { ok: true };
      } catch {
        return { ok: false, reason: 'It could not be taken back just now.' };
      }
    });
}

/**
 * Where an intent stands now: its row, unless its work ended or was removed,
 * or what it was taken up from was settled, handed back or dropped.
 */
export function standingOf(
  row: Pick<IntentRow, 'state' | 'source' | 'runId' | 'closedReason'>,
  runState: string | null,
  sourceStatus: string | null,
): { state: IntentRow['state']; reason: string | null } {
  const open = isOpenIntent(row.state);
  if (!open) return { state: row.state, reason: row.closedReason };
  if (row.source === 'chat') {
    if (!row.runId) return { state: 'failed', reason: REMOVED };
    const state = intentStateNow({ state: row.state, run_state: runState });
    if (state === row.state) return { state, reason: null };
    return {
      state: state as IntentRow['state'],
      reason:
        state === 'done'
          ? 'Done.'
          : state === 'failed'
            ? 'The work on it failed.'
            : 'Its work was stopped.',
    };
  }
  if (sourceStatus === 'settled') return { state: 'done', reason: 'Settled.' };
  if (sourceStatus === 'dropped') return { state: 'cancelled', reason: 'It was let go.' };
  if (sourceStatus === 'waiting' && row.state === 'active')
    return { state: 'waiting', reason: null };
  return { state: row.state, reason: null };
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
