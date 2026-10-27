/**
 * The built-in `board` connection of a room: its agent's tools for the room's
 * board. `board.list` reads it; `board.add`, `board.update`, `board.ask` and
 * `board.note` change it. Every change stays inside the room and can be
 * changed back, so none of them asks anyone.
 *
 * The agent reads the board as the person whose request it is working on
 * would: an item that person may not see is not listed, and cannot be
 * changed. A routine with nobody behind it reads all of it. Only someone
 * in the room who is not a guest is ever assigned an item, and only a
 * request from such a person changes the board.
 */
import {
  type Action,
  BOARD_CHOICE_MAX,
  BOARD_CHOICES_MAX,
  BOARD_DETAIL_MAX,
  BOARD_TITLE_MAX,
  type BoardItem,
  type BoardVisibility,
  type ConnectorManifest,
  type JsonObject,
  type JsonValue,
  type Receipt,
} from '@melete/contracts';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import { schema, space } from '../db/schema.ts';
import { serviceTransaction, type Transaction } from '../db/transaction.ts';
import { addItem, pushToAssignee, readItems, touchItem } from '../rooms/board.ts';
import { roomBoardItem } from '../rooms/board-schema.ts';
import { roomPrincipalOf } from '../rooms/release.ts';
import { roomHandle } from '../rooms/transcript.ts';
import type { Connector, ConnectorContext } from './types.ts';

const when = { type: ['string', 'null'], format: 'date-time' };
const who = {
  type: 'string',
  minLength: 1,
  maxLength: 80,
  description:
    'The person: the code in angle brackets after their name in this room, or their id. Never a guest.',
};
const title = { type: 'string', minLength: 1, maxLength: BOARD_TITLE_MAX };
const detail = { type: ['string', 'null'], maxLength: BOARD_DETAIL_MAX };
const visibility = {
  type: 'string',
  enum: ['everyone', 'owners', 'assignee'],
  description:
    'Who sees it: everyone in the room, the owners, or the person assigned and the owners.',
};
const write = (name: string, description: string, input_schema: JsonObject) => ({
  name,
  description,
  input_schema,
  effect_class: 'write_reversible' as const,
  required_scopes: [name],
  verify: true,
  requires_approval: false,
});

export const boardManifest: ConnectorManifest = {
  name: 'board',
  version: '0.1.0',
  provider: 'board',
  description:
    "The room's board: dated events, tasks, questions and notes, each assigned to someone and shown only to the people it is for.",
  credentials: [],
  health: true,
  tools: [
    {
      name: 'board.list',
      description:
        "List the room's board as the person you are working for may see it, and the people who can be assigned items.",
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: { state: { type: 'string', enum: ['open', 'claimed', 'done', 'answered'] } },
      },
      effect_class: 'read',
      required_scopes: ['board.list'],
      verify: false,
      requires_approval: false,
    },
    write(
      'board.add',
      'Put an event or a task on the board. Keep the title short and free of private detail when everyone can see it.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'title'],
        properties: {
          kind: { type: 'string', enum: ['event', 'task'] },
          title,
          detail,
          starts_at: when,
          ends_at: when,
          due_at: when,
          assignee: { ...who, type: ['string', 'null'] },
          visibility,
        },
      },
    ),
    write('board.update', 'Change an item on the board, or mark it done or open again.', {
      type: 'object',
      additionalProperties: false,
      required: ['item_id'],
      properties: {
        item_id: { type: 'string', minLength: 1, maxLength: 64 },
        title,
        detail,
        starts_at: when,
        ends_at: when,
        due_at: when,
        assignee: { ...who, type: ['string', 'null'] },
        visibility,
        state: { type: 'string', enum: ['open', 'done'] },
      },
    }),
    write(
      'board.ask',
      'Ask one person in the room a question on the board. Only they see it (with the owners) unless you say otherwise; their answer comes back to this room as their own message to you.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['assignee', 'title'],
        properties: {
          assignee: who,
          title,
          detail,
          choices: {
            type: 'array',
            maxItems: BOARD_CHOICES_MAX,
            items: { type: 'string', minLength: 1, maxLength: BOARD_CHOICE_MAX },
          },
          due_at: when,
          visibility,
        },
      },
    ),
    write('board.note', 'Leave one person a note on the board. Only they and the owners see it.', {
      type: 'object',
      additionalProperties: false,
      required: ['assignee', 'title'],
      properties: { assignee: who, title, detail },
    }),
  ],
};

type JobFacts = {
  space_id: string;
  requested_by_principal_id: string | null;
  room_thread_id: string | null;
};

const toDate = (value: unknown, field: string): Date | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime()))
    throw new BrokerFault('payload_invalid', `${field} is not a date and time.`);
  return date;
};

export function createBoardConnector(options: { sql: Sql }): Connector {
  const db = drizzle(options.sql, { schema });

  const facts = async (tx: Query, ctx: ConnectorContext): Promise<JobFacts> => {
    const [row] = await tx`select j.space_id, j.requested_by_principal_id, j.room_thread_id
      from job j join space s on s.id = j.space_id and s.kind = 'shared' and s.removed_at is null
      where j.id = ${ctx.job_id}`;
    if (!row || row.space_id !== ctx.space_id)
      throw new BrokerFault('scope_denied', "Only a room's own work uses its board.");
    return row as unknown as JobFacts;
  };

  /** The role of the person a request works for, while they are in the room now. */
  const roleOf = async (tx: Query, spaceId: string, principalId: string) => {
    const [row] = await tx`select m.role from space_membership m
      where m.space_id = ${spaceId} and m.principal_id = ${principalId} and m.revoked_at is null
        and (m.expires_at is null or m.expires_at > now())`;
    return (row?.role as string | undefined) ?? null;
  };

  /** Changes come only from a request of someone in the room who is not a guest, or from no one's. */
  const mayChange = async (tx: Query, ctx: ConnectorContext) => {
    const job = await facts(tx, ctx);
    if (job.requested_by_principal_id) {
      const role = await roleOf(tx, ctx.space_id, job.requested_by_principal_id);
      if (role !== 'owner' && role !== 'member')
        throw new BrokerFault(
          'scope_denied',
          'Only a request from someone in this room who is not a guest changes the board.',
        );
    }
    return job;
  };

  /** Who an item may be assigned to: an owner or member of the room now, named by id or code. */
  const resolveAssignee = async (tx: Query, spaceId: string, named: unknown) => {
    if (named === undefined || named === null) return named as null | undefined;
    const text = String(named).trim();
    const people = await tx`select m.principal_id from space_membership m
      join principal p on p.id = m.principal_id
      where m.space_id = ${spaceId} and m.revoked_at is null
        and (m.expires_at is null or m.expires_at > now())
        and m.role in ('owner', 'member') and p.kind = 'person' and p.disabled_at is null`;
    const code = text.replace(/^<|>$/g, '');
    for (const person of people) {
      const id = String(person.principal_id);
      if (id === text || roomHandle(spaceId, id) === code) return id;
    }
    throw new BrokerFault(
      'payload_invalid',
      'Assign only someone who is in this room now and is not a guest.',
    );
  };

  const titleOf = (value: unknown) => {
    const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
    if (!text || text.length > BOARD_TITLE_MAX)
      throw new BrokerFault('payload_invalid', `A title is 1 to ${BOARD_TITLE_MAX} characters.`);
    return text;
  };

  const checkDates = (payload: JsonObject) => {
    const starts = toDate(payload.starts_at, 'starts_at');
    const ends = toDate(payload.ends_at, 'ends_at');
    toDate(payload.due_at, 'due_at');
    if (starts && ends && ends < starts)
      throw new BrokerFault('payload_invalid', 'An item cannot end before it starts.');
  };

  /** The payload with its people resolved, as the approval and the action carry it. */
  async function prepare(payload: JsonObject, ctx: ConnectorContext, tx: Query, kind?: string) {
    if (kind === 'board.list') {
      await facts(tx, ctx);
      return payload;
    }
    await mayChange(tx, ctx);
    checkDates(payload);
    const next: JsonObject = { ...payload };
    if ('title' in payload) next.title = titleOf(payload.title);
    if ('assignee' in payload) {
      const id = await resolveAssignee(tx, ctx.space_id, payload.assignee);
      next.assignee = id ?? null;
    }
    if (kind === 'board.ask' || kind === 'board.note') {
      if (!next.assignee) throw new BrokerFault('payload_invalid', 'Name the person this is for.');
      // A note is always for its person alone; it carries no visibility of its own.
      if (kind === 'board.ask')
        next.visibility = (payload.visibility as BoardVisibility | undefined) ?? 'assignee';
      if (Array.isArray(payload.choices))
        next.choices = [...new Set(payload.choices.map((choice) => String(choice).trim()))].filter(
          Boolean,
        );
    }
    if (kind === 'board.add') {
      next.visibility = (payload.visibility as BoardVisibility | undefined) ?? 'everyone';
      if (next.visibility === 'assignee' && !next.assignee)
        throw new BrokerFault(
          'payload_invalid',
          'An item only its assignee sees needs an assignee.',
        );
    }
    if (kind === 'board.update') {
      const [row] = await tx`select id from room_board_item
        where id = ${String(payload.item_id)} and space_id = ${ctx.space_id}`;
      if (!row) throw new BrokerFault('payload_invalid', 'That item is not on this board.');
    }
    return next;
  }

  const receiptFor = (
    action: Action,
    detail: Record<string, JsonValue>,
    externalRef: string | null,
  ): Receipt => ({
    action_id: action.id,
    connection_id: action.connection_id,
    external_ref: externalRef,
    detail,
    received_at: new Date().toISOString(),
    late: false,
  });

  const checkIdentity = (action: Action, ctx: ConnectorContext) => {
    if (
      action.job_id !== ctx.job_id ||
      action.id !== ctx.idempotency_key ||
      action.id !== action.idempotency_key
    )
      throw new Error('connector action identity mismatch');
  };

  /** Who the board is read as: the person the request works for, or the room itself. */
  const readerOf = async (tx: Pick<Transaction, 'select'>, job: JobFacts) =>
    job.requested_by_principal_id ?? (await roomPrincipalOf(tx, job.space_id)).id;

  const compact = (item: BoardItem): JsonValue => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    detail: item.detail,
    starts_at: item.starts_at,
    ends_at: item.ends_at,
    due_at: item.due_at,
    assignee: item.assignee?.display_name ?? null,
    visibility: item.visibility,
    state: item.state,
    claimed_by: item.claimed_by?.display_name ?? null,
    choices: item.choices,
    answer: item.answer,
  });

  const failed = (reason: string) => ({ outcome: 'failed' as const, reason, retryable: false });

  async function list(action: Action, ctx: ConnectorContext) {
    // A read takes no part in the event order, so it holds none of its lock.
    return db.transaction(async (tx) => {
      const job = await facts(options.sql, ctx);
      const reader = await readerOf(tx, job);
      const state = action.canonical_payload.state as BoardItem['state'] | undefined;
      const items = await readItems(tx, reader, {
        spaceId: ctx.space_id,
        ...(state ? { state } : {}),
        limit: 100,
      });
      const people = await options.sql`select m.principal_id, m.role, p.display_name
        from space_membership m join principal p on p.id = m.principal_id
        where m.space_id = ${ctx.space_id} and m.revoked_at is null
          and (m.expires_at is null or m.expires_at > now())
          and m.role in ('owner', 'member') and p.kind = 'person'
        order by m.created_at, m.principal_id`;
      return {
        outcome: 'succeeded' as const,
        receipt: receiptFor(
          action,
          {
            items: items.map(compact),
            people: people.map((row) => ({
              code: roomHandle(ctx.space_id, String(row.principal_id)),
              name: row.display_name ? String(row.display_name) : null,
              role: String(row.role),
            })),
          },
          null,
        ),
      };
    });
  }

  async function add(action: Action, ctx: ConnectorContext) {
    const payload = action.canonical_payload;
    return serviceTransaction(db, async (tx) => {
      const [done] = await tx
        .select()
        .from(roomBoardItem)
        .where(eq(roomBoardItem.actionId, action.id));
      if (done)
        return {
          outcome: 'succeeded' as const,
          receipt: receiptFor(action, { item_id: done.id }, done.id),
        };
      const job = await facts(options.sql, ctx);
      const assignee = typeof payload.assignee === 'string' ? payload.assignee : null;
      // Who may be assigned is read again now: someone may have left since.
      if (assignee) {
        const [still] = await options.sql`select 1 from space_membership m
          join principal p on p.id = m.principal_id
          where m.space_id = ${ctx.space_id} and m.principal_id = ${assignee}
            and m.revoked_at is null and (m.expires_at is null or m.expires_at > now())
            and m.role in ('owner', 'member') and p.kind = 'person'`;
        if (!still) return failed('That person is no longer in this room.');
      }
      const kind =
        action.kind === 'board.ask'
          ? 'question'
          : action.kind === 'board.note'
            ? 'note'
            : (payload.kind as 'event' | 'task');
      const room = await roomPrincipalOf(tx, ctx.space_id);
      const made = await addItem(tx, {
        spaceId: ctx.space_id,
        kind,
        title: String(payload.title),
        detail: typeof payload.detail === 'string' ? payload.detail : null,
        startsAt: toDate(payload.starts_at, 'starts_at') ?? null,
        endsAt: toDate(payload.ends_at, 'ends_at') ?? null,
        dueAt: toDate(payload.due_at, 'due_at') ?? null,
        assignee,
        visibility:
          action.kind === 'board.note' ? 'assignee' : (payload.visibility as BoardVisibility),
        choices: Array.isArray(payload.choices) ? payload.choices.map(String) : null,
        sourceThreadId: kind === 'question' ? job.room_thread_id : null,
        actionId: action.id,
        createdBy: room.id,
      });
      const [named] = await tx
        .select({ name: space.name })
        .from(space)
        .where(eq(space.id, ctx.space_id));
      await pushToAssignee(tx, made, named?.name ?? 'a room');
      return {
        outcome: 'succeeded' as const,
        receipt: receiptFor(
          action,
          {
            item_id: made.id,
            note:
              kind === 'question'
                ? 'They see it on the board. Their answer comes to this room as their own message to you.'
                : 'It is on the board.',
          },
          made.id,
        ),
      };
    });
  }

  async function update(action: Action, ctx: ConnectorContext) {
    const payload = action.canonical_payload;
    return serviceTransaction(db, async (tx) => {
      const job = await facts(options.sql, ctx);
      const reader = await readerOf(tx, job);
      const itemId = String(payload.item_id);
      // The person the request works for must be able to see what it changes.
      const [seen] = await readItems(tx, reader, { spaceId: ctx.space_id, ids: [itemId] });
      if (!seen) return failed('That item is not on this board.');
      const [row] = await tx
        .select()
        .from(roomBoardItem)
        .where(and(eq(roomBoardItem.id, itemId), eq(roomBoardItem.spaceId, ctx.space_id)))
        .for('update');
      if (!row) return failed('That item is not on this board.');
      const patch: Partial<typeof roomBoardItem.$inferInsert> = {};
      if (typeof payload.title === 'string') patch.title = payload.title;
      if ('detail' in payload)
        patch.detail = typeof payload.detail === 'string' ? payload.detail : null;
      for (const [field, key] of [
        ['starts_at', 'startsAt'],
        ['ends_at', 'endsAt'],
        ['due_at', 'dueAt'],
      ] as const)
        if (field in payload) patch[key] = toDate(payload[field], field) ?? null;
      if ('assignee' in payload) {
        const assignee = typeof payload.assignee === 'string' ? payload.assignee : null;
        patch.assigneePrincipalId = assignee;
        if (assignee !== row.assigneePrincipalId) patch.claimedBy = null;
      }
      if (typeof payload.visibility === 'string')
        patch.visibility = payload.visibility as BoardVisibility;
      if (payload.state === 'done') patch.state = row.kind === 'question' ? 'answered' : 'done';
      if (payload.state === 'open') {
        patch.state = 'open';
        patch.claimedBy = null;
      }
      const visibilityNow = patch.visibility ?? row.visibility;
      const assigneeNow =
        'assigneePrincipalId' in patch ? patch.assigneePrincipalId : row.assigneePrincipalId;
      if (visibilityNow === 'assignee' && !assigneeNow)
        return failed('An item only its assignee sees needs an assignee.');
      const [changed] = await tx
        .update(roomBoardItem)
        .set(patch)
        .where(eq(roomBoardItem.id, itemId))
        .returning();
      if (!changed) return failed('That item is not on this board.');
      await touchItem(tx, changed);
      return {
        outcome: 'succeeded' as const,
        receipt: receiptFor(action, { item_id: itemId, state: changed.state }, itemId),
      };
    });
  }

  return {
    manifest: boardManifest,
    async prepare(payload, ctx, tx, kind) {
      return prepare(payload, ctx, tx, kind);
    },
    async validateBinding(action, ctx, tx) {
      if (action.kind === 'board.list') {
        await facts(tx, ctx);
        return;
      }
      await mayChange(tx, ctx);
      const payload = action.canonical_payload;
      if (typeof payload.assignee === 'string')
        await resolveAssignee(tx, ctx.space_id, payload.assignee);
    },
    async execute(action, ctx) {
      checkIdentity(action, ctx);
      ctx.signal?.throwIfAborted();
      if (action.kind === 'board.list') return list(action, ctx);
      if (action.kind === 'board.update') return update(action, ctx);
      if (['board.add', 'board.ask', 'board.note'].includes(action.kind)) return add(action, ctx);
      throw new Error('unknown board tool');
    },
    async verify(action, ctx) {
      checkIdentity(action, ctx);
      if (action.kind === 'board.update') {
        const [row] = await db
          .select()
          .from(roomBoardItem)
          .where(eq(roomBoardItem.id, String(action.canonical_payload.item_id)));
        return row
          ? {
              decision: 'succeeded',
              evidence: { item_id: row.id },
              receipt: receiptFor(action, { item_id: row.id, state: row.state }, row.id),
            }
          : { decision: 'undecided', reason: 'the item is not on the board' };
      }
      if (action.kind === 'board.list')
        return { decision: 'unsupported', reason: 'only an effect has anything to verify' };
      const [row] = await db
        .select()
        .from(roomBoardItem)
        .where(eq(roomBoardItem.actionId, action.id));
      return row
        ? {
            decision: 'succeeded',
            evidence: { item_id: row.id },
            receipt: receiptFor(action, { item_id: row.id }, row.id),
          }
        : { decision: 'undecided', reason: 'no item was made for this action' };
    },
    async health() {
      return {
        status: 'ok',
        detail: 'the board is available',
        checked_at: new Date().toISOString(),
      };
    },
  };
}
