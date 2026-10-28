/**
 * A room's board. Its items are read only through `readItems`, whose query
 * decides what the reader may see from their place in the room now:
 *
 * - an owner (and the room's own agent) sees every item;
 * - a member sees `everyone` items and the `assignee` items assigned to them;
 * - a guest sees `everyone` items only.
 *
 * Someone who is not in the room now sees nothing. A person who has left reads
 * as nobody: an item assigned to them shows no assignee, and a claim they made
 * reads as open again. Every change takes a sequence number from the event log,
 * in the transaction that makes it, so a board stream sends it again in commit
 * order and the commit wakes every open stream.
 */
import { randomBytes } from 'node:crypto';
import {
  BOARD_ANSWER_MAX,
  BOARD_CHOICE_MAX,
  BOARD_CHOICES_MAX,
  BOARD_DETAIL_MAX,
  BOARD_TITLE_MAX,
  type BoardItem,
  type BoardItemKind,
  type BoardItemState,
  type BoardStreamFrame,
  type BoardVisibility,
  boardItem,
} from '@melete/contracts';
import { and, asc, eq, gt, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';
import { type AnyPgColumn, alias } from 'drizzle-orm/pg-core';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { agent, principal, space, spaceMembership } from '../db/schema.ts';
import { serviceTransaction, type Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import { roomBoardItem } from './board-schema.ts';
import { roomMessage } from './schema.ts';
import type { RoomService } from './service.ts';
import { namesOf } from './transcript.ts';

type Reader = Database | Transaction;
type ItemRow = typeof roomBoardItem.$inferSelect;

/** The most items one read returns. */
export const BOARD_PAGE = 500;
/** The most frames one stream page carries. */
export const BOARD_FRAME_PAGE = 100;
/** The submission an answer is posted under, before the item's id. */
const ANSWER_SUBMISSION = 'board-answer-';
/** Added to it when the thread the question was asked in is gone. */
const ANSWER_IN_NEW_THREAD = '-thread';

const viewerPlace = alias(spaceMembership, 'board_viewer');
const assigneePlace = alias(spaceMembership, 'board_assignee');
const claimerPlace = alias(spaceMembership, 'board_claimer');

/** A membership that holds now. */
const holds = (m: { revokedAt: AnyPgColumn; expiresAt: AnyPgColumn }) =>
  and(isNull(m.revokedAt), or(isNull(m.expiresAt), gt(m.expiresAt, sql`now()`)));

/**
 * What a reader may see, given their membership row: the one rule of the board.
 * An owner, or the room's agent, sees everything; a member sees what is for
 * everyone and what is assigned to them alone; a guest, what is for everyone.
 */
function visibleTo(viewer: string): SQL {
  return or(
    inArray(viewerPlace.role, ['owner', 'agent']),
    eq(roomBoardItem.visibility, 'everyone'),
    and(
      eq(viewerPlace.role, 'member'),
      eq(roomBoardItem.visibility, 'assignee'),
      eq(roomBoardItem.assigneePrincipalId, viewer),
    ),
  ) as SQL;
}

export type ItemFilter = {
  spaceId?: string;
  ids?: string[];
  /** Changed after this sequence number, oldest first: a stream's page. */
  after?: number;
  /** Open or claimed, and assigned to the reader. */
  mine?: boolean;
  from?: Date;
  to?: Date;
  state?: BoardItemState;
  limit?: number;
};

type ReadRow = {
  item: ItemRow;
  role: string;
  roomName: string;
  assigneeHere: string | null;
  claimerHere: string | null;
};

/**
 * The items the reader may see now, with what they may do with each. The
 * visibility rule is part of the query, so nothing the reader may not see is
 * ever read into the service.
 */
export async function readItems(
  reader: Reader,
  viewer: string,
  filter: ItemFilter = {},
): Promise<BoardItem[]> {
  const when = sql`coalesce(${roomBoardItem.startsAt}, ${roomBoardItem.dueAt}, ${roomBoardItem.endsAt})`;
  const rows: ReadRow[] = await reader
    .select({
      item: roomBoardItem,
      role: viewerPlace.role,
      roomName: space.name,
      assigneeHere: assigneePlace.principalId,
      claimerHere: claimerPlace.principalId,
    })
    .from(roomBoardItem)
    .innerJoin(
      space,
      and(eq(space.id, roomBoardItem.spaceId), eq(space.kind, 'shared'), isNull(space.removedAt)),
    )
    .innerJoin(
      viewerPlace,
      and(
        eq(viewerPlace.spaceId, roomBoardItem.spaceId),
        eq(viewerPlace.principalId, viewer),
        holds(viewerPlace),
        inArray(viewerPlace.role, ['owner', 'member', 'guest', 'agent']),
      ),
    )
    .leftJoin(
      assigneePlace,
      and(
        eq(assigneePlace.spaceId, roomBoardItem.spaceId),
        eq(assigneePlace.principalId, roomBoardItem.assigneePrincipalId),
        holds(assigneePlace),
        inArray(assigneePlace.role, ['owner', 'member']),
      ),
    )
    .leftJoin(
      claimerPlace,
      and(
        eq(claimerPlace.spaceId, roomBoardItem.spaceId),
        eq(claimerPlace.principalId, roomBoardItem.claimedBy),
        holds(claimerPlace),
        inArray(claimerPlace.role, ['owner', 'member']),
      ),
    )
    .where(
      and(
        visibleTo(viewer),
        filter.spaceId ? eq(roomBoardItem.spaceId, filter.spaceId) : undefined,
        filter.ids ? inArray(roomBoardItem.id, filter.ids) : undefined,
        filter.after !== undefined ? gt(roomBoardItem.seq, filter.after) : undefined,
        filter.state ? eq(roomBoardItem.state, filter.state) : undefined,
        filter.mine
          ? and(
              eq(roomBoardItem.assigneePrincipalId, viewer),
              inArray(roomBoardItem.state, ['open', 'claimed']),
            )
          : undefined,
        filter.from
          ? sql`greatest(${roomBoardItem.startsAt}, ${roomBoardItem.endsAt}, ${roomBoardItem.dueAt}) >= ${filter.from.toISOString()}::timestamptz`
          : undefined,
        filter.to ? sql`${when} < ${filter.to.toISOString()}::timestamptz` : undefined,
        filter.from || filter.to ? sql`${when} is not null` : undefined,
      ),
    )
    .orderBy(
      ...(filter.after !== undefined
        ? [asc(roomBoardItem.seq)]
        : [sql`${when} asc nulls last`, asc(roomBoardItem.createdAt), asc(roomBoardItem.id)]),
    )
    .limit(filter.limit ?? BOARD_PAGE);
  return views(reader, viewer, rows);
}

async function views(reader: Reader, viewer: string, rows: ReadRow[]): Promise<BoardItem[]> {
  if (!rows.length) return [];
  const bySpace = new Map<string, ReadRow[]>();
  for (const row of rows)
    bySpace.set(row.item.spaceId, [...(bySpace.get(row.item.spaceId) ?? []), row]);
  const labels = new Map<string, Map<string, string>>();
  const agents = new Map<string, string>();
  for (const [spaceId, group] of bySpace) {
    labels.set(
      spaceId,
      await namesOf(
        reader,
        spaceId,
        group.flatMap((row) => [
          row.item.createdBy,
          ...(row.assigneeHere ? [row.assigneeHere] : []),
          ...(row.claimerHere ? [row.claimerHere] : []),
        ]),
      ),
    );
    const [persona] = await reader
      .select({ name: agent.name })
      .from(agent)
      .where(and(eq(agent.spaceId, spaceId), eq(agent.isDefault, true)))
      .limit(1);
    agents.set(spaceId, persona?.name ?? 'Melete');
  }
  const rooms = await reader
    .select({ id: principal.id })
    .from(principal)
    .where(
      and(
        inArray(principal.id, [...new Set(rows.map((row) => row.item.createdBy))]),
        eq(principal.kind, 'room'),
      ),
    );
  const roomPrincipals = new Set(rooms.map((row) => row.id));
  return rows.map((row) => {
    const names = labels.get(row.item.spaceId) ?? new Map<string, string>();
    const person = (id: string | null) =>
      id ? { principal_id: id, display_name: names.get(id) ?? 'Someone' } : null;
    const item = row.item;
    const assignee = row.assigneeHere;
    const claimer = item.state === 'claimed' ? row.claimerHere : null;
    // A claim by someone no longer here is no claim.
    const state = (item.state === 'claimed' && !claimer ? 'open' : item.state) as BoardItemState;
    const person_ = row.role === 'owner' || row.role === 'member';
    const actable = item.kind !== 'question';
    return boardItem.parse({
      id: item.id,
      room_id: item.spaceId,
      room_name: row.roomName,
      kind: item.kind,
      title: item.title,
      detail: item.detail,
      starts_at: item.startsAt?.toISOString() ?? null,
      ends_at: item.endsAt?.toISOString() ?? null,
      due_at: item.dueAt?.toISOString() ?? null,
      assignee: person(assignee),
      visibility: item.visibility,
      state,
      claimed_by: person(claimer),
      choices: item.choices ?? null,
      answer: item.answer,
      answered_at: item.answeredAt?.toISOString() ?? null,
      thread_id: item.sourceThreadId,
      created_by: {
        principal_id: item.createdBy,
        display_name: roomPrincipals.has(item.createdBy)
          ? (agents.get(item.spaceId) ?? 'Melete')
          : (names.get(item.createdBy) ?? 'Someone'),
      },
      created_at: item.createdAt.toISOString(),
      updated_at: item.updatedAt.toISOString(),
      seq: item.seq,
      can: {
        claim:
          person_ &&
          actable &&
          item.kind !== 'note' &&
          state === 'open' &&
          (!assignee || assignee === viewer),
        done:
          person_ &&
          actable &&
          (state === 'open' || state === 'claimed') &&
          (row.role === 'owner' ||
            assignee === viewer ||
            claimer === viewer ||
            (!assignee && !claimer && item.kind !== 'note')),
        answer: item.kind === 'question' && state === 'open' && assignee === viewer,
      },
    });
  });
}

/**
 * Record that an item changed, in event order: a board stream sends it again
 * at this sequence number, and the commit wakes every open stream.
 */
export async function touchItem(tx: Transaction, row: ItemRow): Promise<ItemRow> {
  const written = await appendEvent(tx, {
    type: 'notice',
    payload: { kind: 'room_board', space_id: row.spaceId, item_id: row.id },
    dedupKey: `room_board:${row.id}:${randomBytes(8).toString('hex')}`,
  });
  if (!written) throw new Error('Board event was not written');
  const [updated] = await tx
    .update(roomBoardItem)
    .set({ seq: written.seq, updatedAt: new Date() })
    .where(eq(roomBoardItem.id, row.id))
    .returning();
  if (!updated) throw new Error('Board item disappeared');
  return updated;
}

/** Whether someone holds a place in the room now as an owner or member: who can be assigned. */
export async function assignable(reader: Reader, spaceId: string, principalId: string) {
  const [row] = await reader
    .select({ role: spaceMembership.role })
    .from(spaceMembership)
    .innerJoin(principal, eq(principal.id, spaceMembership.principalId))
    .where(
      and(
        eq(spaceMembership.spaceId, spaceId),
        eq(spaceMembership.principalId, principalId),
        holds(spaceMembership),
        inArray(spaceMembership.role, ['owner', 'member']),
        eq(principal.kind, 'person'),
        isNull(principal.disabledAt),
      ),
    );
  return Boolean(row);
}

export type NewItem = {
  spaceId: string;
  kind: BoardItemKind;
  title: string;
  detail?: string | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  dueAt?: Date | null;
  assignee?: string | null;
  visibility: BoardVisibility;
  choices?: string[] | null;
  sourceThreadId?: string | null;
  actionId?: string | null;
  createdBy: string;
};

/** Put an item on a room's board. The caller has checked who may and who it is assigned to. */
export async function addItem(tx: Transaction, input: NewItem): Promise<ItemRow> {
  const [made] = await tx
    .insert(roomBoardItem)
    .values({
      id: newId('rbi'),
      spaceId: input.spaceId,
      kind: input.kind,
      title: input.title,
      detail: input.detail ?? null,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      dueAt: input.dueAt ?? null,
      assigneePrincipalId: input.assignee ?? null,
      visibility: input.visibility,
      choices: input.choices ?? null,
      sourceThreadId: input.sourceThreadId ?? null,
      actionId: input.actionId ?? null,
      createdBy: input.createdBy,
    })
    .returning();
  if (!made) throw new Error('Board item insert returned no row');
  return touchItem(tx, made);
}

const missingItem = () => new ServiceError('not_found', 'That item is not on this board.', 404);

/**
 * The board's routes' service: what people read, claim, complete and answer.
 * Every method checks the reader's place in the room first, through the room
 * service, and then reads only what that place lets them see.
 */
export class BoardService {
  constructor(
    private readonly deps: {
      db: Database;
      rooms: RoomService;
    },
  ) {}

  async list(spaceId: string, actor: string) {
    await this.deps.rooms.access(this.deps.db, spaceId, actor);
    return { items: await readItems(this.deps.db, actor, { spaceId }) };
  }

  /** The items from every room the reader is in now, as each room lets them see. */
  async across(actor: string, query: { mine?: boolean; from?: Date; to?: Date }) {
    return { items: await readItems(this.deps.db, actor, query) };
  }

  /** One page of the board's frames after `after`, for a stream. */
  async frames(spaceId: string, actor: string, after: number): Promise<BoardStreamFrame[]> {
    await this.deps.rooms.access(this.deps.db, spaceId, actor);
    const items = await readItems(this.deps.db, actor, {
      spaceId,
      after,
      limit: BOARD_FRAME_PAGE,
    });
    return items.map((item) => ({ seq: item.seq, kind: 'item' as const, item }));
  }

  stillIn(spaceId: string, actor: string) {
    return this.deps.rooms.stillIn(spaceId, actor);
  }

  private async person(spaceId: string, actor: string) {
    const access = await this.deps.rooms.access(this.deps.db, spaceId, actor);
    if (access.role === 'guest')
      throw new ServiceError('scope_denied', 'Guests can read the board but not change it.', 403);
    return access;
  }

  private async one(reader: Reader, spaceId: string, itemId: string, actor: string) {
    const [item] = await readItems(reader, actor, { spaceId, ids: [itemId] });
    if (!item) throw missingItem();
    return item;
  }

  /**
   * Take an item on. One person's claim stands: a second claim, at the same
   * moment or later, is refused with who holds it.
   */
  async claim(spaceId: string, itemId: string, actor: string) {
    await this.person(spaceId, actor);
    return serviceTransaction(this.deps.db, async (tx) => {
      const seen = await this.one(tx, spaceId, itemId, actor);
      if (seen.state === 'claimed' || !seen.can.claim) throw this.refusal(seen, actor);
      // The row's own lock settles a race: the second claim finds it claimed
      // by someone still in the room, and changes nothing.
      const [claimed] = await tx
        .update(roomBoardItem)
        .set({ state: 'claimed', claimedBy: actor })
        .where(
          and(
            eq(roomBoardItem.id, itemId),
            eq(roomBoardItem.spaceId, spaceId),
            or(
              eq(roomBoardItem.state, 'open'),
              and(
                eq(roomBoardItem.state, 'claimed'),
                sql`not exists (select 1 from space_membership m
                  where m.space_id = ${roomBoardItem.spaceId} and m.principal_id = ${roomBoardItem.claimedBy}
                    and m.revoked_at is null and (m.expires_at is null or m.expires_at > now())
                    and m.role in ('owner', 'member'))`,
              ),
            ),
          ),
        )
        .returning();
      if (!claimed) throw this.refusal(await this.one(tx, spaceId, itemId, actor), actor);
      await touchItem(tx, claimed);
      return { item: await this.one(tx, spaceId, itemId, actor) };
    });
  }

  private refusal(item: BoardItem, actor: string) {
    if (item.state === 'claimed')
      return new ServiceError(
        'already_claimed',
        item.claimed_by?.principal_id === actor
          ? 'You already claimed this.'
          : `${item.claimed_by?.display_name ?? 'Someone'} already claimed this.`,
        409,
      );
    if (item.state === 'done' || item.state === 'answered')
      return new ServiceError('board_item_closed', 'This item is already done.', 409);
    return new ServiceError(
      'scope_denied',
      item.kind === 'question' || item.kind === 'note'
        ? 'Only a task or an event can be claimed.'
        : 'This is assigned to someone else.',
      403,
    );
  }

  /** Mark an item done: the person on it, an owner, or anyone for an unassigned task. */
  async done(spaceId: string, itemId: string, actor: string) {
    await this.person(spaceId, actor);
    return serviceTransaction(this.deps.db, async (tx) => {
      const seen = await this.one(tx, spaceId, itemId, actor);
      if (seen.state === 'done') return { item: seen };
      if (!seen.can.done) throw this.refusal(seen, actor);
      const [closed] = await tx
        .update(roomBoardItem)
        .set({ state: 'done' })
        .where(
          and(
            eq(roomBoardItem.id, itemId),
            eq(roomBoardItem.spaceId, spaceId),
            inArray(roomBoardItem.state, ['open', 'claimed']),
          ),
        )
        .returning();
      if (closed) await touchItem(tx, closed);
      return { item: await this.one(tx, spaceId, itemId, actor) };
    });
  }

  /**
   * Answer a question put to the reader. The answer is posted in the room as
   * their own message, in the thread it was asked in, naming the agent: the
   * agent goes on as a new request of theirs, through the room's own message
   * path. Only the person it asks answers it.
   */
  async answer(spaceId: string, itemId: string, actor: string, text: string) {
    await this.person(spaceId, actor);
    const answer = text.trim().slice(0, BOARD_ANSWER_MAX);
    const seen = await this.one(this.deps.db, spaceId, itemId, actor);
    if (seen.kind !== 'question')
      throw new ServiceError('not_a_question', 'Only a question takes an answer.', 409);
    if (seen.assignee?.principal_id !== actor)
      throw new ServiceError('scope_denied', 'Only the person it asks can answer it.', 403);
    if (seen.state === 'answered' && seen.answer !== answer)
      throw new ServiceError('already_answered', 'You already answered this.', 409);
    // A question is always put to one person, so its words stay off the
    // room's thread whoever else may read it on the board. The agent reads
    // the question itself with the answer (`boardAnswersFor`).
    const message = `@Melete ${answer}\n\n(My answer to your question on the board.)`;
    const submission = `${ANSWER_SUBMISSION}${seen.id}`;
    const rooms = this.deps.rooms;
    const posted = await (seen.thread_id
      ? rooms
          .post(
            spaceId,
            actor,
            { text: message, submission_id: submission },
            { threadId: seen.thread_id },
          )
          .catch((error: unknown) => {
            // The thread it was asked in is closed or gone: the answer starts a thread of its own.
            if (
              error instanceof ServiceError &&
              (error.code === 'thread_archived' || error.code === 'not_found')
            )
              return null;
            throw error;
          })
      : Promise.resolve(null)
    ).then(
      (first) =>
        first ??
        rooms.post(
          spaceId,
          actor,
          { text: message, submission_id: `${submission}${ANSWER_IN_NEW_THREAD}` },
          { title: 'An answer from the board', askAgent: true },
        ),
    );
    const item = await serviceTransaction(this.deps.db, async (tx) => {
      const [answered] = await tx
        .update(roomBoardItem)
        .set({
          state: 'answered',
          answer,
          answeredAt: new Date(),
          answerMessageId: posted.message.id,
        })
        .where(
          and(
            eq(roomBoardItem.id, itemId),
            eq(roomBoardItem.spaceId, spaceId),
            eq(roomBoardItem.state, 'open'),
            eq(roomBoardItem.assigneePrincipalId, actor),
          ),
        )
        .returning();
      if (answered) await touchItem(tx, answered);
      return this.one(tx, spaceId, itemId, actor);
    });
    return {
      item,
      thread_id: posted.thread.id,
      message_id: posted.message.id,
      request_job_id: posted.request_job_id ?? null,
    };
  }
}

/**
 * A question a room request's agent asked with ask_person. A room has no
 * question card, so it goes on the board for the person whose request it is:
 * only they and the owners read it, it is on their "Waiting on you", and their
 * answer reaches the request as their own message in its thread. Nothing is
 * added for someone who cannot be assigned, or twice for the same question.
 */
export async function askOnBoard(
  tx: Transaction,
  job: {
    spaceId: string;
    principalId: string | null;
    requestedByPrincipalId: string | null;
    roomThreadId: string | null;
  },
  question: { text: string; options?: { label: string }[] | undefined },
): Promise<ItemRow | null> {
  const asker = job.requestedByPrincipalId;
  if (!asker || !job.principalId || !(await assignable(tx, job.spaceId, asker))) return null;
  const text = question.text.trim();
  const title = text.length > BOARD_TITLE_MAX ? `${text.slice(0, BOARD_TITLE_MAX - 3)}...` : text;
  const [open] = await tx
    .select({ id: roomBoardItem.id })
    .from(roomBoardItem)
    .where(
      and(
        eq(roomBoardItem.spaceId, job.spaceId),
        eq(roomBoardItem.kind, 'question'),
        eq(roomBoardItem.state, 'open'),
        eq(roomBoardItem.assigneePrincipalId, asker),
        eq(roomBoardItem.title, title),
      ),
    )
    .limit(1);
  if (open) return null;
  const choices = [
    ...new Set((question.options ?? []).map((option) => option.label.slice(0, BOARD_CHOICE_MAX))),
  ].slice(0, BOARD_CHOICES_MAX);
  const made = await addItem(tx, {
    spaceId: job.spaceId,
    kind: 'question',
    title,
    detail: title === text ? null : text.slice(0, BOARD_DETAIL_MAX),
    assignee: asker,
    visibility: 'assignee',
    choices: choices.length ? choices : null,
    sourceThreadId: job.roomThreadId,
    createdBy: job.principalId,
  });
  const [named] = await tx
    .select({ name: space.name })
    .from(space)
    .where(eq(space.id, job.spaceId));
  await pushToAssignee(tx, made, named?.name ?? 'a room');
  return made;
}

/** Items assigned to someone, unanswered, whose push goes to them alone. */
export async function pushToAssignee(
  tx: Transaction,
  row: ItemRow,
  roomName: string,
): Promise<void> {
  if (!row.assigneePrincipalId || (row.kind !== 'question' && row.kind !== 'note')) return;
  const title =
    row.kind === 'question' ? `A question for you in ${roomName}` : `A note for you in ${roomName}`;
  await tx.execute(sql`
    insert into push_intent (id, principal_id, kind, title, body, because, url, dedup_key)
    select ${newId('pint')}, ${row.assigneePrincipalId}, 'decision', ${title.slice(0, 120)},
           ${row.title}, ${'Because it was put on the board for you.'},
           ${`/#/rooms/${row.spaceId}/board`}, ${`board:${row.id}:${row.assigneePrincipalId}`}
    where exists (select 1 from push_subscription s where s.principal_id = ${row.assigneePrincipalId})
      -- An item for the owners alone is never pushed to someone who is not one.
      and (${row.visibility} <> 'owners' or exists (select 1 from space_membership m
        where m.space_id = ${row.spaceId} and m.principal_id = ${row.assigneePrincipalId}
          and m.role = 'owner' and m.revoked_at is null
          and (m.expires_at is null or m.expires_at > now())))
      and coalesce((select p.decisions from push_setting p where p.principal_id = ${row.assigneePrincipalId}), true)
    on conflict (dedup_key) do nothing`);
}

/**
 * The board's questions whose answers reached one of the room's requests: the
 * question, who answered it, and the answer. An answer posted to the thread
 * does not repeat its question, so the request's agent reads it here. Each is
 * found by the message it was posted as: the key `RoomService.post` keeps for
 * the answer's own submission, made from the room, its author and the item,
 * so it is there as soon as that message is.
 */
export async function boardAnswersFor(
  reader: Pick<Transaction, 'select'>,
  spaceId: string,
  jobId: string,
): Promise<{ title: string; answeredBy: string; answer: string | null }[]> {
  const key = (suffix: string) =>
    sql`encode(sha256(convert_to(${roomMessage.spaceId} || ':' || ${roomMessage.authorPrincipalId}
      || ':' || ${ANSWER_SUBMISSION} || ${roomBoardItem.id} || ${suffix}, 'UTF8')), 'hex')`;
  const rows = await reader
    .select({
      title: roomBoardItem.title,
      answer: roomBoardItem.answer,
      answeredBy: roomMessage.authorPrincipalId,
    })
    .from(roomMessage)
    .innerJoin(
      roomBoardItem,
      and(
        eq(roomBoardItem.spaceId, roomMessage.spaceId),
        eq(roomBoardItem.kind, 'question'),
        or(
          eq(roomMessage.submissionId, key('')),
          eq(roomMessage.submissionId, key(ANSWER_IN_NEW_THREAD)),
        ),
      ),
    )
    .where(
      and(
        eq(roomMessage.spaceId, spaceId),
        eq(roomMessage.requestJobId, jobId),
        isNull(roomMessage.redactedAt),
      ),
    )
    .orderBy(asc(roomMessage.createdAt), asc(roomMessage.id));
  return rows;
}
