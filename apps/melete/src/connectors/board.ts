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
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import { schema, space } from '../db/schema.ts';
import { serviceTransaction, type Transaction } from '../db/transaction.ts';
import { localDay, localTime, zonedInstant } from '../memory/zoned.ts';
import { addItem, pushToAssignee, readItems, touchItem } from '../rooms/board.ts';
import { roomBoardItem } from '../rooms/board-schema.ts';
import { roomPrincipalOf } from '../rooms/release.ts';
import { roomHandle } from '../rooms/transcript.ts';
import { validZone } from './calendar-truth.ts';
import type { Connector, ConnectorContext } from './types.ts';

const when = {
  type: ['string', 'null'],
  description:
    "A local date and time in the room's time zone with no offset, as board.list shows them, such as 2026-11-06T09:00, or a date alone for the whole day.",
};
/** What the agent is told when an item it asked to show everyone was kept with its person. */
const KEPT_NOTE =
  ' It is kept with its person and the owners, not everyone, because this request read a shared calendar.';
/** Set by the service when it kept an item with its person; never the agent's to set. */
const keptWithPerson = { type: 'boolean', description: 'Filled in by Melete.' };
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
        "List the room's board as the person you are working for may see it, and the people who can be assigned items. Everyone in the room reads its threads, so name an item there only when it is for everyone.",
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
          kept_with_person: keptWithPerson,
        },
      },
    ),
    write(
      'board.update',
      "Change an item on the board, or mark it done or open again. When someone takes on an event with a time and the room's calendars say theirs allows adding events, offer to add it there with room.add_to_member_calendar; only they approve the exact event.",
      {
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
          kept_with_person: keptWithPerson,
        },
      },
    ),
    write(
      'board.ask',
      "Ask one person in the room a question on the board, in this turn rather than saying you will. Leave visibility out so it stays with them and the owners, and never put anyone's calendar, free time or busy time in its title or detail. Their answer comes back as their own message to you; if they take on something with a time and their calendar takes new events, offer room.add_to_member_calendar.",
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
          visibility: {
            ...visibility,
            default: 'assignee',
            description:
              'Leave this out. A question for one person is for them and the owners (assignee). Use everyone only for a question the whole room is meant to read, such as a vote, and then keep it free of anything about one person. After a shared calendar was read in this request, every question stays with its person.',
          },
          kept_with_person: keptWithPerson,
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

/**
 * The tool to call instead of a board call its schema refused, for the
 * mix-ups models make: a note or a question asked of board.add, a time on a
 * note, choices on a note, or a state board.update cannot set. One sentence,
 * from the schema's own words, never the values sent.
 */
export function boardCallInstead(kind: string, payload: JsonObject): string | null {
  const has = (field: string) => payload[field] !== undefined;
  if (kind === 'board.add' && payload.kind === 'note')
    return 'board.add takes kind event or task, so leave a note for one person with board.note and its assignee and title instead.';
  if (kind === 'board.add' && (payload.kind === 'question' || payload.kind === 'ask'))
    return 'board.add takes kind event or task, so ask one person a question with board.ask and its assignee and title instead.';
  if (kind === 'board.note' && TIMES.some(has))
    return 'A note has no time, so put anything with a date or time on the board with board.add as an event or a task instead.';
  if (kind === 'board.note' && has('choices'))
    return 'A note has no choices, so ask with choices using board.ask instead.';
  if (kind === 'board.note' && has('visibility'))
    return 'A note is always for its person and the owners, so call board.note with only assignee, title and detail.';
  if (kind === 'board.ask' && (has('starts_at') || has('ends_at')))
    return 'A question has only a due_at, so put an event with a start or end on the board with board.add instead.';
  if (kind === 'board.update' && (payload.state === 'answered' || payload.state === 'claimed'))
    return 'board.update sets state to open or done only; a question closes when its person answers it, and a person claims an item themselves.';
  if (kind === 'board.update' && has('kind'))
    return "An item's kind cannot change, so mark it done with board.update and put the new one up with board.add, board.ask or board.note.";
  return null;
}

type JobFacts = {
  space_id: string;
  requested_by_principal_id: string | null;
  room_thread_id: string | null;
};

/** The fields of an item that hold a time. */
const TIMES = ['starts_at', 'ends_at', 'due_at'] as const;
/** A date and time with no offset: a wall time, read in the room's own zone. */
const WALL = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;
/** A date alone: the whole of that day in the room's zone, from its midnight. */
const DAY = /^(\d{4}-\d{2}-\d{2})$/;
/** An instant written with its own offset, or in UTC: taken as given. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
/** The parts of any of those forms, and an offset's, to check against the calendar. */
const PARTS =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-](\d{2}):?(\d{2}))?)?$/i;

/**
 * Whether a time names a real day and time of day. A date's own parser rolls
 * November 31 into December and 25:00 into the next day; this refuses them.
 */
function realTime(text: string): boolean {
  const parts = PARTS.exec(text);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts
    .slice(1, 7)
    .map((part) => Number(part ?? 0));
  const at = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 0, hour, minute, second));
  return (
    year !== undefined &&
    year >= 1000 &&
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === (month ?? 0) - 1 &&
    at.getUTCDate() === day &&
    at.getUTCHours() === hour &&
    at.getUTCMinutes() === minute &&
    at.getUTCSeconds() === second &&
    Number(parts[7] ?? 0) <= 14 &&
    Number(parts[8] ?? 0) <= 59
  );
}

/**
 * Times the agent writes as wall times in the room's zone, made instants. A
 * time read on the board and given again on another day keeps its time of day
 * across a change of clocks, which an instant moved by whole days does not.
 * Only these forms are taken: anything else would be read in the server's own
 * zone, or as midnight UTC, and land on the wrong hour or day.
 */
function inRoomTime(payload: JsonObject, timeZone: string): JsonObject {
  const next: JsonObject = { ...payload };
  for (const field of TIMES) {
    const value = payload[field];
    if (value === undefined || value === null) continue;
    const text = typeof value === 'string' ? value.trim() : '';
    if (!realTime(text))
      throw new BrokerFault(
        'payload_invalid',
        `${field} must be a real date and time in the room's time zone, such as 2026-11-06T09:00, a date such as 2026-11-06, or a time with its offset.`,
      );
    const wall = WALL.exec(text);
    const day = DAY.exec(text);
    if (wall?.[1] && wall[2]) next[field] = zonedInstant(wall[1], wall[2], timeZone).toISOString();
    else if (day?.[1]) next[field] = zonedInstant(day[1], '00:00', timeZone).toISOString();
    else if (INSTANT.test(text) && !Number.isNaN(Date.parse(text))) next[field] = text;
    else
      throw new BrokerFault(
        'payload_invalid',
        `${field} must be a date and time in the room's time zone, such as 2026-11-06T09:00, a date such as 2026-11-06, or a time with its offset.`,
      );
  }
  return next;
}

/**
 * The zone the room reads time in. A room that set none takes the zone of the
 * person whose request this is, from their own space, then its maker's; UTC
 * only when nobody chose one. A profile still on its first default counts as
 * no choice.
 */
async function roomZone(tx: Query, spaceId: string, requester: string | null): Promise<string> {
  const [row] = await tx`
    with chosen as (
      select p.space_id, p.time_zone from experience_profile p
      where p.time_zone_confirmed_at is not null or p.time_zone <> 'UTC'),
    personal as (
      select coalesce(s.owner_principal_id, (select id from owner limit 1)) as principal_id,
             c.time_zone
      from space s join chosen c on c.space_id = s.id where s.kind = 'personal')
    select coalesce(
      (select time_zone from chosen where space_id = ${spaceId}),
      (select time_zone from personal where principal_id = ${requester} limit 1),
      (select p.time_zone from personal p join space r on r.id = ${spaceId}
        where p.principal_id = coalesce(r.owner_principal_id, (select id from owner limit 1))
        limit 1)) as zone`;
  return validZone(row?.zone) ? row.zone : 'UTC';
}

/** An instant as the wall time it is in the room's zone, as the agent reads the board. */
const wallTime = (at: string | null, timeZone: string) =>
  at ? `${localDay(new Date(at), timeZone)}T${localTime(new Date(at), timeZone)}` : null;

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
  async function prepare(given: JsonObject, ctx: ConnectorContext, tx: Query, kind?: string) {
    if (kind === 'board.list') {
      await facts(tx, ctx);
      return given;
    }
    const job = await mayChange(tx, ctx);
    const payload = inRoomTime(
      given,
      await roomZone(tx, ctx.space_id, job.requested_by_principal_id),
    );
    checkDates(payload);
    // Work with nobody behind it is the room's own, and goes as an owner's would.
    const owner =
      !job.requested_by_principal_id ||
      (await roleOf(tx, ctx.space_id, job.requested_by_principal_id)) === 'owner';
    if (payload.visibility === 'owners' && !owner)
      throw new BrokerFault('scope_denied', 'Only an owner keeps an item for the owners.');
    const next: JsonObject = { ...payload };
    delete next.kept_with_person;
    /**
     * A request that read someone's shared calendar keeps what it puts up for
     * one person with them and the owners: what it says may rest on what that
     * calendar shows. The receipt tells the agent it did.
     */
    const keepWithPerson = async () => {
      const [read] = await tx`select 1 from action
        where job_id = ${ctx.job_id} and kind = 'room.member_freebusy'
          and status = 'succeeded' limit 1`;
      if (!read) return;
      next.visibility = 'assignee';
      next.kept_with_person = true;
    };
    if ('title' in payload) next.title = titleOf(payload.title);
    if ('assignee' in payload) {
      const id = await resolveAssignee(tx, ctx.space_id, payload.assignee);
      next.assignee = id ?? null;
    }
    if (kind === 'board.ask' || kind === 'board.note') {
      if (!next.assignee) throw new BrokerFault('payload_invalid', 'Name the person this is for.');
      // A note is always for its person alone; it carries no visibility of its own.
      if (kind === 'board.ask') {
        next.visibility = (payload.visibility as BoardVisibility | undefined) ?? 'assignee';
        if (next.visibility === 'everyone') await keepWithPerson();
        // The person asked must be able to see the question to answer it.
        if (
          next.visibility === 'owners' &&
          (await roleOf(tx, ctx.space_id, String(next.assignee))) !== 'owner'
        )
          throw new BrokerFault(
            'payload_invalid',
            'Only the owners see a question for the owners, so ask an owner or let the person see it.',
          );
      }
      if (Array.isArray(payload.choices))
        next.choices = [...new Set(payload.choices.map((choice) => String(choice).trim()))].filter(
          Boolean,
        );
    }
    if (kind === 'board.add') {
      next.visibility = (payload.visibility as BoardVisibility | undefined) ?? 'everyone';
      if (next.visibility === 'everyone' && next.assignee) await keepWithPerson();
      if (next.visibility === 'assignee' && !next.assignee)
        throw new BrokerFault(
          'payload_invalid',
          'An item only its assignee sees needs an assignee.',
        );
    }
    if (kind === 'board.update') {
      const [row] = await tx`select id, kind, visibility, assignee_principal_id
        from room_board_item
        where id = ${String(payload.item_id)} and space_id = ${ctx.space_id}`;
      if (!row) throw new BrokerFault('payload_invalid', 'That item is not on this board.');
      if (row.kind === 'question' && payload.state === 'done')
        throw new BrokerFault('payload_invalid', 'Only an answer closes a question.');
      const assigneeNow = 'assignee' in next ? next.assignee : row.assignee_principal_id;
      // What the item will show once changed: a retitle or a new assignee
      // leaves an item for everyone, so it is kept with its person too.
      const visibleTo = 'visibility' in next ? next.visibility : row.visibility;
      if (visibleTo === 'everyone' && assigneeNow) await keepWithPerson();
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

  const compact = (item: BoardItem, timeZone: string): JsonValue => ({
    id: item.id,
    kind: item.kind,
    title: item.title,
    detail: item.detail,
    starts_at: wallTime(item.starts_at, timeZone),
    ends_at: wallTime(item.ends_at, timeZone),
    due_at: wallTime(item.due_at, timeZone),
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
      const timeZone = await roomZone(options.sql, ctx.space_id, job.requested_by_principal_id);
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
            time_zone: timeZone,
            items: items.map((item) => compact(item, timeZone)),
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
    // Read before the transaction: inside it, the event order lock is held,
    // and nothing there may wait on another connection.
    const job = await facts(options.sql, ctx);
    const assignee = typeof payload.assignee === 'string' ? payload.assignee : null;
    // Who may be assigned is read again now: someone may have left since.
    if (assignee) {
      const [still] = await options.sql`select 1 from space_membership m
        join principal p on p.id = m.principal_id
        where m.space_id = ${ctx.space_id} and m.principal_id = ${assignee}
          and m.revoked_at is null and (m.expires_at is null or m.expires_at > now())
          and m.role in ('owner', 'member') and p.kind = 'person'`;
      if (!still) {
        const [made] =
          await options.sql`select id from room_board_item where action_id = ${action.id}`;
        if (!made) return failed('That person is no longer in this room.');
      }
    }
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
            note: `${
              kind === 'question'
                ? 'They see it on the board. Their answer comes to this room as their own message to you.'
                : 'It is on the board.'
            }${payload.kept_with_person ? KEPT_NOTE : ''}`,
          },
          made.id,
        ),
      };
    });
  }

  async function update(action: Action, ctx: ConnectorContext) {
    const payload = action.canonical_payload;
    // Read before the transaction, which holds the event order lock.
    const job = await facts(options.sql, ctx);
    const requester = job.requested_by_principal_id;
    const owner = !requester || (await roleOf(options.sql, ctx.space_id, requester)) === 'owner';
    const newAssignee = typeof payload.assignee === 'string' ? payload.assignee : null;
    return serviceTransaction(db, async (tx) => {
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
      if (row.kind === 'question' && payload.state === 'done')
        return failed('Only an answer closes a question.');
      if (!owner) {
        // As on the board itself: someone who is not an owner changes only
        // what they are on, or what nobody is on, and keeps nothing for the
        // owners. They take an item on themselves; only an owner gives it to
        // someone else.
        const holder =
          seen.state === 'claimed'
            ? (seen.claimed_by?.principal_id ?? null)
            : row.state === 'done'
              ? row.claimedBy
              : null;
        const onIt =
          seen.assignee?.principal_id === reader ||
          holder === reader ||
          (!seen.assignee && !holder && seen.kind !== 'note' && seen.kind !== 'question');
        if (!onIt) return failed('Only the person on it or an owner changes this item.');
        if (payload.visibility === 'owners')
          return failed('Only an owner keeps an item for the owners.');
        if ('assignee' in payload && newAssignee !== null && newAssignee !== reader)
          return failed('Only an owner gives an item to someone else.');
      }
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
      if (payload.state === 'done') patch.state = 'done';
      if (payload.state === 'open') {
        patch.state = 'open';
        patch.claimedBy = null;
      }
      const visibilityNow = patch.visibility ?? row.visibility;
      const assigneeNow =
        'assigneePrincipalId' in patch ? patch.assigneePrincipalId : row.assigneePrincipalId;
      if (visibilityNow === 'assignee' && !assigneeNow)
        return failed('An item only its assignee sees needs an assignee.');
      // The person a question asks must be able to see it, as with board.ask.
      const assigneeIsOwner = assigneeNow
        ? (
            (await tx.execute(sql`select 1 from space_membership m
            where m.space_id = ${ctx.space_id} and m.principal_id = ${assigneeNow}
              and m.role = 'owner' and m.revoked_at is null
              and (m.expires_at is null or m.expires_at > now())`)) as unknown as unknown[]
          ).length > 0
        : false;
      if (row.kind === 'question' && visibilityNow === 'owners' && assigneeNow && !assigneeIsOwner)
        return failed(
          'Only the owners see a question for the owners, so ask an owner or let the person see it.',
        );
      const [changed] = await tx
        .update(roomBoardItem)
        .set(patch)
        .where(eq(roomBoardItem.id, itemId))
        .returning();
      if (!changed) return failed('That item is not on this board.');
      await touchItem(tx, changed);
      // Someone newly given a question or a note is told, as when it was made.
      if (changed.assigneePrincipalId && changed.assigneePrincipalId !== row.assigneePrincipalId) {
        const [named] = await tx
          .select({ name: space.name })
          .from(space)
          .where(eq(space.id, ctx.space_id));
        await pushToAssignee(tx, changed, named?.name ?? 'a room');
      }
      return {
        outcome: 'succeeded' as const,
        receipt: receiptFor(
          action,
          {
            item_id: itemId,
            state: changed.state,
            ...(payload.kept_with_person ? { note: KEPT_NOTE.trim() } : {}),
          },
          itemId,
        ),
      };
    });
  }

  return {
    manifest: boardManifest,
    explainInvalid: boardCallInstead,
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
