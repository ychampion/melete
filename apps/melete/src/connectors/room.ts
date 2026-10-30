/**
 * The built-in `room` connection: the only ways anything crosses between a
 * room and a person's own space, each an effect the broker admits and
 * receipts like any other.
 *
 * A room's request can read an explicitly shared calendar as free/busy, or
 * ask its member to approve adding an event. Otherwise it cannot use
 * anyone's mailbox, files or memory; it asks a member to run a task with their
 * own setup instead. Nothing runs until that person reads the whole task and
 * accepts it, so the person's consent card is the approval: the hand-off
 * itself only puts the card in front of them.
 *
 * A person's own work has three: `room.list` (the rooms they are in),
 * `room.post` (a message to a room, posted as them through their agent) and
 * `room.add_file` (a copy of a checked file into the room's files). Posting
 * and adding a file publish to other people, so each is `write_external` and
 * waits for the person's approval of the exact room, thread, text or file.
 *
 * Every tool re-reads the person's membership when it is proposed, when it is
 * admitted and again when it runs: someone who has left a room sends nothing
 * to it, and a person's work never learns anything of a room they are not in.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Action, ConnectorManifest, JsonObject, JsonValue, Receipt } from '@melete/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import { event, job, schema, trigger } from '../db/schema.ts';
import { serviceTransaction } from '../db/transaction.ts';
import { newId } from '../ids.ts';
import { labelsIn } from '../rooms/approvals.ts';
import { resolveRoomCalendarShare } from '../rooms/calendar-shares.ts';
import {
  HANDOFF_OPEN_PER_PERSON,
  HANDOFF_PER_REQUEST,
  HANDOFF_TASK_LIMIT,
  HANDOFF_TTL_MS,
  handoffEventName,
  postToThread,
  roomMemberRole,
  sha256,
} from '../rooms/handoffs.ts';
import { roomHandoff, roomMessage, roomThread } from '../rooms/schema.ts';
import { membersNamed, namesOf } from '../rooms/transcript.ts';
import { LocalWorkspaceFs } from '../runtime/workspace-fs.ts';
import { roomInstant, roomZone, wallTime } from './board.ts';
import { calendarManifest, createPayload, freebusyDetail, freebusyPayload } from './calendar.ts';
import {
  calendarSource,
  checkCalendarAhead,
  MAX_FREEBUSY_DAYS,
  spaceTimeZone,
} from './calendar-truth.ts';
import type { ConnectionSource } from './configured.ts';
import { noLinks, segmentsFor } from './files.ts';
import type { Connector, ConnectorContext } from './types.ts';

/**
 * An instant as the room's wall time with the offset in force then, such as
 * 2026-11-01T01:30-04:00. The hour repeated when clocks go back reads as two
 * different times, so a block can be written back as the moment it is.
 */
function localWithOffset(at: string | null, zone: string): string | null {
  const wall = wallTime(at, zone);
  if (!at || !wall) return wall;
  const minute = Math.floor(Date.parse(at) / 60_000) * 60_000;
  const offset = Math.round((Date.parse(`${wall}:00Z`) - minute) / 60_000);
  const size = Math.abs(offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${wall}${offset < 0 ? '-' : '+'}${pad(Math.floor(size / 60))}:${pad(size % 60)}`;
}

const TEXT_LIMIT = 8000;
const eventSchema = calendarManifest.tools.find(
  (tool) => tool.name === 'calendar.create',
)?.input_schema;
if (!eventSchema) throw new Error('The calendar create schema is missing');

export const roomManifest: ConnectorManifest = {
  name: 'room',
  version: '0.1.0',
  provider: 'room',
  description:
    'Read explicitly shared free/busy calendars, ask their member to add an event, hand work to a person, or post and add files to a room.',
  credentials: [],
  health: true,
  tools: [
    {
      name: 'room.member_freebusy',
      description:
        "Read eligible helpers' explicitly shared free/busy. complete=true covers the requested window: empty busy means no busy blocks, not a reason to try formats. Reuse complete same-member/window results in this decision unless stale; retry incomplete/failed reads. Different candidates/windows and post-approval conflict checks need their own reads. Event titles, locations and attendees stay private.",
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['member', 'start', 'end'],
        properties: {
          member: {
            type: 'string',
            minLength: 1,
            description:
              'A current member by room handle, full room label, unique display name or principal id. Only an explicitly shared calendar may be read or changed.',
          },
          start: {
            type: 'string',
            description:
              "A local date and time in the room's time zone with no offset, such as 2026-11-06T09:00, a date alone from its midnight, or a time with its offset. Choose a window of at most 62 days.",
          },
          end: {
            type: 'string',
            description:
              "Like start; a date alone runs to the end of that day, so 2026-11-06 for both reads that whole day. Blocks give start_local and end_local in the room's time zone.",
          },
          calendar_connection_id: { type: 'string', description: 'Filled in by Melete.' },
          share_created_at: { type: 'string', description: 'Filled in by Melete.' },
          membership_generation: { type: 'integer', description: 'Filled in by Melete.' },
        },
      },
      effect_class: 'read',
      required_scopes: ['room.member_freebusy'],
      verify: false,
      requires_approval: false,
    },
    {
      name: 'room.add_to_member_calendar',
      description:
        "Propose an exact event on a member's explicitly shared calendar with additions: this produces their approval card; do not ask permission again first. Only that member approves, regardless of the room's rule. After approval use resume_action by action ID; do not resubmit the payload. Confirm success through the verified receipt. Existing calendar conflicts still stop a write.",
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['member', 'event'],
        properties: {
          member: {
            type: 'string',
            minLength: 1,
            description:
              'A current member by room handle, full room label, unique display name or principal id. Only an explicitly shared calendar may be read or changed.',
          },
          member_name: { type: 'string', description: 'Filled in by Melete.' },
          event: eventSchema,
          calendar_connection_id: { type: 'string', description: 'Filled in by Melete.' },
          share_created_at: { type: 'string', description: 'Filled in by Melete.' },
          membership_generation: { type: 'integer', description: 'Filled in by Melete.' },
        },
      },
      effect_class: 'write_external',
      required_scopes: ['room.add_to_member_calendar'],
      verify: true,
      requires_approval: true,
    },
    {
      name: 'room.handoff',
      description:
        'Ask a person in this room to run a task with their own setup (their mail, calendar, files). They see the whole task and run it or decline it; afterwards they choose whether to share the result here. By default the person who asked. The receipt names a trigger: call job.wait with it to hear the outcome.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['task'],
        properties: {
          task: { type: 'string', minLength: 1, maxLength: HANDOFF_TASK_LIMIT },
          member_id: { type: 'string', minLength: 1 },
        },
      },
      // It only puts a card in front of the person; their acceptance of the
      // exact task is what lets anything run.
      effect_class: 'write_reversible',
      required_scopes: ['room.handoff'],
      verify: true,
      requires_approval: false,
    },
    {
      name: 'room.list',
      description: 'List the rooms the person is in, by name and id.',
      input_schema: { type: 'object', additionalProperties: false, properties: {} },
      effect_class: 'read',
      required_scopes: ['room.list'],
      verify: false,
      requires_approval: false,
    },
    {
      name: 'room.post',
      description:
        'Post a message to a room the person is in, as them, in an existing thread or a new one. The person approves the exact room, thread and text first.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['room_id', 'text'],
        properties: {
          room_id: { type: 'string', minLength: 1 },
          thread_id: { type: ['string', 'null'], minLength: 1 },
          text: { type: 'string', minLength: 1, maxLength: TEXT_LIMIT },
          room_name: { type: 'string' },
          thread_title: { type: ['string', 'null'] },
        },
      },
      effect_class: 'write_external',
      required_scopes: ['room.post'],
      verify: true,
      requires_approval: true,
    },
    {
      name: 'room.add_file',
      description:
        "Copy a checked file from this work into a room's files. The person approves the exact file first; the room keeps its copy.",
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['room_id', 'path'],
        properties: {
          room_id: { type: 'string', minLength: 1 },
          path: { type: 'string', minLength: 1, maxLength: 1024 },
          area: { type: 'string', enum: ['work', 'artifacts'] },
          name: { type: 'string', minLength: 1, maxLength: 200 },
          artifact_id: { type: 'string', minLength: 1 },
          content_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          room_name: { type: 'string' },
        },
      },
      effect_class: 'write_external',
      required_scopes: ['room.add_file'],
      verify: true,
      requires_approval: true,
    },
  ],
};

export type RoomConnectorOptions = {
  sql: Sql;
  workRoot: string;
  spacesRoot: string;
  maxBytes?: number;
  /** How long a hand-off waits for its person. */
  handoffTtlMs?: number;
  /** Opens only the personal calendar row proven by the member's current share. */
  openCalendar?: (row: ConnectionSource, query: Query) => Promise<Connector | undefined>;
};

type JobFacts = {
  audience: string;
  principal_id: string | null;
  requested_by_principal_id: string | null;
  room_thread_id: string | null;
  space_id: string;
};

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const notInRoom = () =>
  new BrokerFault('scope_denied', 'The person is not in that room, or there is no such room.');

export function createRoomConnector(options: RoomConnectorOptions): Connector {
  const db = drizzle(options.sql, { schema });
  const limit = options.maxBytes ?? 8 * 1024 * 1024;
  const workspace = new LocalWorkspaceFs(options.workRoot);
  const ttl = options.handoffTtlMs ?? HANDOFF_TTL_MS;

  const facts = async (tx: Query, jobId: string): Promise<JobFacts> => {
    const [row] =
      await tx`select j.audience, j.space_id, j.requested_by_principal_id, j.room_thread_id,
        coalesce(j.principal_id, (select id from owner limit 1)) as principal_id
      from job j where j.id = ${jobId}`;
    if (!row) throw new BrokerFault('scope_denied');
    return row as unknown as JobFacts;
  };

  /** `owner` or `member` while the person is in the room now; guests and the room itself never. */
  const memberRole = async (tx: Query, roomId: string, principalId: string | null) => {
    if (!principalId) return null;
    const [row] = await tx`select m.role from space_membership m
      join space s on s.id = m.space_id join principal p on p.id = m.principal_id
      where m.space_id = ${roomId} and m.principal_id = ${principalId} and m.revoked_at is null
        and m.role in ('owner', 'member') and s.kind = 'shared' and s.removed_at is null
        and p.kind = 'person'`;
    return (row?.role as string | undefined) ?? null;
  };

  /** A person's own work, never a room's request: only that reaches a room this way. */
  const ownWork = async (tx: Query, ctx: ConnectorContext) => {
    const job = await facts(tx, ctx.job_id);
    if (job.audience !== 'principal' || job.space_id !== ctx.space_id)
      throw new BrokerFault('scope_denied', "Only a person's own work posts to a room.");
    return job;
  };

  const roomOf = async (tx: Query, roomId: unknown, principalId: string | null) => {
    if (typeof roomId !== 'string' || !(await memberRole(tx, roomId, principalId)))
      throw notInRoom();
    const [row] = await tx`select name from space where id = ${roomId}`;
    return { id: roomId, name: String(row?.name ?? '') };
  };

  const threadOf = async (tx: Query, roomId: string, threadId: unknown) => {
    if (threadId === undefined || threadId === null) return null;
    const [row] = await tx`select id, title from room_thread
      where id = ${String(threadId)} and space_id = ${roomId} and archived_at is null`;
    if (!row)
      throw new BrokerFault('payload_invalid', 'That thread is not in the room, or it is closed.');
    return { id: String(row.id), title: String(row.title) };
  };

  /** Who a hand-off goes to: the person named, or the person who asked. */
  const handoffTarget = async (tx: Query, ctx: ConnectorContext, payload: JsonObject) => {
    const job = await facts(tx, ctx.job_id);
    if (job.audience !== 'room' || job.space_id !== ctx.space_id)
      throw new BrokerFault('scope_denied', "Only a room's request hands work to a person.");
    // Only a member's request reaches into someone's own setup: a guest's never does.
    if (!(await memberRole(tx, ctx.space_id, job.requested_by_principal_id)))
      throw new BrokerFault(
        'scope_denied',
        'Only a request from a member of this room hands work to a person.',
      );
    const target =
      typeof payload.member_id === 'string' ? payload.member_id : job.requested_by_principal_id;
    if (!(await memberRole(tx, ctx.space_id, target)))
      throw new BrokerFault(
        'payload_invalid',
        'Hand work only to a person in this room who is not a guest.',
      );
    const [open] = await tx`select
        count(*) filter (where target_principal_id = ${target} and state = 'pending')::int as waiting,
        count(*) filter (where room_job_id = ${ctx.job_id})::int as asked
      from room_handoff where space_id = ${ctx.space_id}`;
    if (Number(open?.waiting ?? 0) >= HANDOFF_OPEN_PER_PERSON)
      throw new BrokerFault(
        'payload_invalid',
        'That person already has requests from this room waiting for them. Wait for them to answer.',
      );
    if (Number(open?.asked ?? 0) >= HANDOFF_PER_REQUEST)
      throw new BrokerFault('payload_invalid', 'This request has handed out as much as it may.');
    return { job, target: target as string };
  };

  const taskOf = (payload: JsonObject) => {
    const task = typeof payload.task === 'string' ? payload.task.trim() : '';
    if (!task || task.length > HANDOFF_TASK_LIMIT)
      throw new BrokerFault('payload_invalid', 'A hand-off needs the task, in full.');
    return task;
  };

  const textOf = (payload: JsonObject) => {
    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text || text.length > TEXT_LIMIT)
      throw new BrokerFault('payload_invalid', 'A post needs its text.');
    return text;
  };

  const nameOf = (payload: JsonObject) => {
    const relative = typeof payload.path === 'string' ? payload.path : '';
    const name = typeof payload.name === 'string' ? payload.name : path.posix.basename(relative);
    const segments = segmentsFor(name);
    if (segments.length !== 1)
      throw new BrokerFault('payload_invalid', 'Name the file, not a folder.');
    return name;
  };

  /** The checked file this work recorded at that path, as it is now. */
  const recorded = async (tx: Query, ctx: ConnectorContext, payload: JsonObject) => {
    const relative = typeof payload.path === 'string' ? payload.path : '';
    const area = payload.area === 'artifacts' ? 'artifacts' : 'work';
    const [row] = await tx`select id, content_hash from artifact
      where job_id = ${ctx.job_id} and space_id = ${ctx.space_id} and area = ${area}
        and path = ${relative} and expectation is not null
      order by created_at desc, id desc limit 1`;
    if (!row)
      throw new BrokerFault(
        'payload_invalid',
        `${relative} has no checked record; declare expect when writing it, then add it`,
      );
    return { id: String(row.id), hash: String(row.content_hash), area, relative };
  };

  const readFile = async (target: string) => {
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > limit)
        throw new Error('the file is not a regular file or is too large');
      return await file.readFile();
    } finally {
      await file.close();
    }
  };

  const sourceBytes = async (ctx: ConnectorContext, area: string, relative: string) => {
    if (!/^job_[A-Za-z0-9]+$/.test(ctx.job_id) || !/^sp_[A-Za-z0-9]+$/.test(ctx.space_id))
      throw new Error('invalid trusted file scope');
    if (area === 'work') return workspace.read(ctx.job_id, relative, limit);
    const base = await realpath(options.spacesRoot);
    return readFile(
      await noLinks(base, [ctx.space_id, 'artifacts', ...segmentsFor(relative)], false),
    );
  };

  const roomFile = async (roomId: string, name: string, create: boolean) => {
    if (!/^sp_[A-Za-z0-9]+$/.test(roomId)) throw new Error('invalid room');
    const base = await realpath(options.spacesRoot);
    if (create) await mkdir(path.join(base, roomId, 'artifacts'), { recursive: true });
    return noLinks(base, [roomId, 'artifacts', ...segmentsFor(name)], create);
  };

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

  const calendarKind = (kind: string) =>
    kind === 'room.member_freebusy' || kind === 'room.add_to_member_calendar';

  const calendarEvent = (payload: JsonObject): JsonObject => {
    const parsed = createPayload.safeParse(payload.event);
    if (!parsed.success)
      throw new BrokerFault(
        'payload_invalid',
        'Provide a valid calendar event with a title, start and end.',
      );
    return parsed.data as JsonObject;
  };

  /** A room can choose a member, never an arbitrary personal connection. */
  const calendarTarget = async (
    tx: Query,
    ctx: ConnectorContext,
    payload: JsonObject,
    write: boolean,
    bound = false,
  ) => {
    const job = await facts(tx, ctx.job_id);
    const [room] = await tx`select 1 from space s
      join space_membership m on m.space_id = s.id and m.role = 'agent' and m.revoked_at is null
      join principal p on p.id = m.principal_id
      where s.id = ${ctx.space_id} and s.kind = 'shared' and s.removed_at is null
        and p.kind = 'room' and p.id = ${job.principal_id ?? ''}`;
    if (!room || job.space_id !== ctx.space_id || typeof payload.member !== 'string')
      throw new BrokerFault('scope_denied', "Only this room's agent can use its shared calendars.");
    if (job.requested_by_principal_id) {
      const [requester] = await tx`select 1 from space_membership where space_id = ${ctx.space_id}
        and principal_id = ${job.requested_by_principal_id} and revoked_at is null
        and (expires_at is null or expires_at > now())`;
      if (!requester) throw notInRoom();
    }
    let memberId = payload.member;
    if (!bound) {
      // Room transcripts identify speakers by public labels and handles,
      // rather than personal account ids. Never guess between identical names.
      const members = await tx<
        { id: string; display_name: string | null }[]
      >`select p.id, p.display_name
        from space_membership m join principal p on p.id = m.principal_id
        where m.space_id = ${ctx.space_id} and m.revoked_at is null
          and m.role in ('owner', 'member') and p.kind = 'person' and p.disabled_at is null
          and (m.expires_at is null or m.expires_at > now())`;
      const matches = membersNamed(members, ctx.space_id, memberId);
      if (matches.length !== 1 || !matches[0])
        throw new BrokerFault(
          'scope_denied',
          'Name one current room member. Use their room handle if names are the same.',
        );
      memberId = matches[0].id;
    }
    const target = await resolveRoomCalendarShare(tx, ctx.space_id, memberId, write);
    if (
      bound &&
      (payload.calendar_connection_id !== target.connection.id ||
        payload.share_created_at !== target.share.createdAt.toISOString() ||
        payload.membership_generation !== target.share.membershipGeneration)
    )
      throw new BrokerFault(
        'scope_denied',
        'That calendar share changed. Ask again with its current permission.',
      );
    return target;
  };

  const openCalendar = async (
    target: Awaited<ReturnType<typeof calendarTarget>>,
    query: Query = options.sql,
  ) => {
    const connector = await options.openCalendar?.(target.connection, query);
    if (!connector || !calendarSource(connector))
      throw new BrokerFault('scope_denied', 'That shared calendar is unavailable.');
    return connector;
  };

  const personalContext = (
    ctx: ConnectorContext,
    target: Awaited<ReturnType<typeof calendarTarget>>,
  ): ConnectorContext => ({ ...ctx, space_id: target.connection.spaceId, granted: [] });

  const calendarAction = (action: Action): Action => ({
    ...action,
    kind: 'calendar.create',
    connection_id: String(action.canonical_payload.calendar_connection_id),
    canonical_payload: calendarEvent(action.canonical_payload),
  });

  async function memberCalendar(action: Action, ctx: ConnectorContext) {
    const write = action.kind === 'room.add_to_member_calendar';
    const target = await calendarTarget(options.sql, ctx, action.canonical_payload, write, true);
    const connector = await openCalendar(target);
    if (!write) {
      const window = freebusyPayload.parse({
        start: action.canonical_payload.start,
        end: action.canonical_payload.end,
        time_zone: await spaceTimeZone(options.sql, target.connection.spaceId),
      });
      const source = calendarSource(connector);
      if (!source) throw new BrokerFault('scope_denied', 'That shared calendar is unavailable.');
      let detail: JsonObject;
      try {
        detail = await freebusyDetail(source, window, ctx.signal);
      } catch {
        return {
          outcome: 'failed' as const,
          reason: 'The shared calendar could not be read just now.',
          retryable: true,
        };
      }
      // Revoke or leave while the provider was reading: discard that result.
      await calendarTarget(options.sql, ctx, action.canonical_payload, false, true);
      // Each block also reads as the board does, in the room's own zone, so a
      // UTC hour is never taken for a local one.
      const job = await facts(options.sql, ctx.job_id);
      const zone = await roomZone(options.sql, ctx.space_id, job.requested_by_principal_id);
      const blocks = (value: unknown, busy: boolean): JsonObject[] =>
        (Array.isArray(value) ? value : []).map((block) => ({
          start: block.start,
          end: block.end,
          start_local: localWithOffset(block.start, zone),
          end_local: localWithOffset(block.end, zone),
          ...(busy ? { all_day: block.all_day, status: block.status } : {}),
        }));
      return {
        outcome: 'succeeded' as const,
        receipt: receiptFor(
          action,
          {
            member: target.share.principalId,
            window: detail.window ?? null,
            time_zone: detail.time_zone ?? null,
            room_time_zone: zone,
            complete: detail.complete ?? false,
            busy: blocks(detail.busy, true),
            free: blocks(detail.free, false),
            ...(detail.note ? { note: detail.note } : {}),
          },
          null,
        ),
      };
    }
    // The provider performs its normal dispatch-time calendar check and write.
    // No read grant is delegated, so conflict refusals cannot name private events.
    await calendarTarget(options.sql, ctx, action.canonical_payload, true, true);
    const result = await connector.execute(calendarAction(action), {
      ...personalContext(ctx, target),
      beforeCalendarWrite: async () => {
        await calendarTarget(options.sql, ctx, action.canonical_payload, true, true);
      },
    });
    return result.outcome === 'succeeded'
      ? { ...result, receipt: { ...result.receipt, connection_id: action.connection_id } }
      : result;
  }

  const checkIdentity = (action: Action, ctx: ConnectorContext) => {
    if (
      action.job_id !== ctx.job_id ||
      action.id !== ctx.idempotency_key ||
      action.id !== action.idempotency_key
    )
      throw new Error('connector action identity mismatch');
  };

  const handoffReceipt = async (
    reader: Pick<typeof db, 'select'>,
    action: Action,
    row: typeof roomHandoff.$inferSelect,
  ) => {
    const names = await namesOf(reader, row.spaceId, [row.targetPrincipalId]);
    return receiptFor(
      action,
      {
        handoff_id: row.id,
        person: names.get(row.targetPrincipalId) ?? 'Someone',
        state: row.state,
        trigger_id: row.triggerId,
        event_name: handoffEventName(row.id),
        note: 'They see the whole task in their own Melete. Call job.wait with this trigger_id to hear whether they ran it and what they chose to share.',
      },
      row.id,
    );
  };

  async function handoff(action: Action, ctx: ConnectorContext) {
    const payload = action.canonical_payload;
    const task = taskOf(payload);
    return serviceTransaction(db, async (tx) => {
      const [done] = await tx.select().from(roomHandoff).where(eq(roomHandoff.actionId, action.id));
      if (done)
        return { outcome: 'succeeded' as const, receipt: await handoffReceipt(tx, action, done) };
      const [request] = await tx.select().from(job).where(eq(job.id, ctx.job_id));
      const target = typeof payload.member_id === 'string' ? payload.member_id : null;
      if (
        request?.audience !== 'room' ||
        !request.roomThreadId ||
        !request.requestedByPrincipalId ||
        !(await roomMemberRole(tx, ctx.space_id, request.requestedByPrincipalId)) ||
        !target ||
        !(await roomMemberRole(tx, ctx.space_id, target))
      )
        return {
          outcome: 'failed' as const,
          reason: 'That person is no longer in this room.',
          retryable: false,
        };
      const id = newId('rho');
      const [start] = await tx
        .select({ seq: event.seq })
        .from(event)
        .where(and(eq(event.jobId, request.id), eq(event.type, 'job_created')))
        .limit(1);
      const triggerId = newId('trg');
      await tx.insert(trigger).values({
        id: triggerId,
        jobId: request.id,
        kind: 'event',
        spec: {
          kind: 'event',
          connection_id: action.connection_id,
          event_name: handoffEventName(id),
          poll_seconds: 300,
        },
        cursor: String(start?.seq ?? 0),
      });
      const [made] = await tx
        .insert(roomHandoff)
        .values({
          id,
          spaceId: ctx.space_id,
          roomJobId: request.id,
          roomTurnId: request.currentTurnId,
          threadId: request.roomThreadId,
          actionId: action.id,
          connectionId: action.connection_id,
          triggerId,
          targetPrincipalId: target,
          taskText: task,
          taskHash: sha256(task),
          expiresAt: new Date(Date.now() + ttl),
        })
        .returning();
      if (!made) throw new Error('Handoff insert returned no row');
      return { outcome: 'succeeded' as const, receipt: await handoffReceipt(tx, action, made) };
    });
  }

  async function post(action: Action, ctx: ConnectorContext) {
    const payload = action.canonical_payload;
    const text = textOf(payload);
    const roomId = String(payload.room_id);
    const key = `action:${action.id}`;
    return serviceTransaction(db, async (tx) => {
      const [own] = await tx
        .select({ audience: job.audience, spaceId: job.spaceId })
        .from(job)
        .where(eq(job.id, ctx.job_id));
      // A job made before principals is the setup owner's.
      const owners = (await tx.execute(sql`select coalesce(j.principal_id,
          (select id from owner limit 1)) as principal_id from job j where j.id = ${ctx.job_id}`)) as unknown as {
        principal_id: string | null;
      }[];
      const facts = owners[0]?.principal_id ?? null;
      if (
        own?.audience !== 'principal' ||
        own.spaceId !== ctx.space_id ||
        !facts ||
        !(await roomMemberRole(tx, roomId, facts))
      )
        return {
          outcome: 'failed' as const,
          reason: 'The person is no longer in that room.',
          retryable: false,
        };
      let threadId = typeof payload.thread_id === 'string' ? payload.thread_id : null;
      if (threadId) {
        const [thread] = await tx
          .select({ id: roomThread.id, archivedAt: roomThread.archivedAt })
          .from(roomThread)
          .where(and(eq(roomThread.id, threadId), eq(roomThread.spaceId, roomId)));
        if (!thread || thread.archivedAt)
          return {
            outcome: 'failed' as const,
            reason: 'That thread is no longer open in the room.',
            retryable: false,
          };
      } else {
        // A new thread, made once however often this action is sent.
        const [earlier] = await tx
          .select({ threadId: roomMessage.threadId })
          .from(roomMessage)
          .where(eq(roomMessage.submissionId, sha256(`room-post:${key}`)));
        if (earlier) threadId = earlier.threadId;
        else {
          const title = text.split('\n')[0]?.trim().slice(0, 200) || 'Thread';
          const [made] = await tx
            .insert(roomThread)
            .values({ id: newId('rth'), spaceId: roomId, title, createdBy: facts })
            .returning();
          if (!made) throw new Error('Thread insert returned no row');
          threadId = made.id;
        }
      }
      const message = await postToThread(tx, {
        spaceId: roomId,
        threadId,
        author: facts,
        kind: 'person',
        viaAgent: true,
        text,
        key,
      });
      return {
        outcome: 'succeeded' as const,
        receipt: receiptFor(
          action,
          { room_id: roomId, thread_id: threadId, message_id: message.id },
          message.id,
        ),
      };
    });
  }

  async function addFile(action: Action, ctx: ConnectorContext) {
    const payload = action.canonical_payload;
    const roomId = String(payload.room_id);
    const name = nameOf(payload);
    const hash = String(payload.content_hash ?? '');
    const area = payload.area === 'artifacts' ? 'artifacts' : 'work';
    const relative = String(payload.path ?? '');
    // Membership and the record are read again just before the copy is made.
    const [principalId] = await options.sql`select coalesce(j.principal_id,
        (select id from owner limit 1)) as id, j.audience from job j where j.id = ${ctx.job_id}`;
    if (
      principalId?.audience !== 'principal' ||
      !(await memberRole(options.sql, roomId, (principalId?.id as string | undefined) ?? null))
    )
      return {
        outcome: 'failed' as const,
        reason: 'The person is no longer in that room.',
        retryable: false,
      };
    const [record] =
      await options.sql`select id from artifact where id = ${String(payload.artifact_id)}
      and content_hash = ${hash} and job_id = ${ctx.job_id} and space_id = ${ctx.space_id}
      and area = ${area} and path = ${relative} and expectation is not null`;
    if (!record)
      throw new BrokerFault('payload_invalid', 'The approved file version is unavailable');
    const bytes = await sourceBytes(ctx, area, relative).catch(() => {
      throw new BrokerFault('payload_invalid', 'The approved file is unavailable');
    });
    if (digest(bytes) !== hash)
      throw new BrokerFault(
        'payload_invalid',
        'The file differs from the approved version; write and check it again',
      );
    const target = await roomFile(roomId, name, true);
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      // The same copy already there is this action sent again; anything else is someone's file.
      const existing = digest(await readFile(target));
      if (existing !== hash)
        return {
          outcome: 'failed' as const,
          reason: `The room already has a different file called ${name}. Choose another name.`,
          retryable: false,
        };
      return {
        outcome: 'succeeded' as const,
        receipt: receiptFor(
          action,
          { room_id: roomId, name, content_hash: hash, bytes: bytes.byteLength },
          name,
        ),
      };
    }
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    return {
      outcome: 'succeeded' as const,
      receipt: receiptFor(
        action,
        { room_id: roomId, name, content_hash: hash, bytes: bytes.byteLength },
        name,
      ),
    };
  }

  return {
    manifest: roomManifest,
    async ahead(proposal, ctx, tx) {
      if (proposal.kind !== 'room.add_to_member_calendar') return null;
      const target = await calendarTarget(tx, ctx, proposal.canonical_payload, true);
      const connector = await openCalendar(target, tx);
      return (
        (await connector.ahead?.(
          { kind: 'calendar.create', canonical_payload: calendarEvent(proposal.canonical_payload) },
          personalContext(ctx, target),
          tx,
        )) ?? null
      );
    },
    checkAhead(proposal, ctx) {
      if (proposal.kind !== 'room.add_to_member_calendar') return;
      checkCalendarAhead(
        { kind: 'calendar.create', canonical_payload: calendarEvent(proposal.canonical_payload) },
        { ...ctx, granted: [] },
      );
    },
    async prepare(payload, ctx, tx, kind) {
      if (kind && calendarKind(kind)) {
        const write = kind === 'room.add_to_member_calendar';
        const target = await calendarTarget(tx, ctx, payload, write);
        const binding = {
          member: target.share.principalId,
          calendar_connection_id: target.connection.id,
          share_created_at: target.share.createdAt.toISOString(),
          membership_generation: target.share.membershipGeneration,
        };
        if (!write) {
          // The window is read the way the board reads times: wall times and
          // dates in the room's zone, so a day asked for is that day there.
          const job = await facts(tx, ctx.job_id);
          const zone = await roomZone(tx, ctx.space_id, job.requested_by_principal_id);
          const start = roomInstant('start', payload.start, zone);
          const end = roomInstant('end', payload.end, zone, true);
          if (Date.parse(end) <= Date.parse(start))
            throw new BrokerFault('payload_invalid', 'The free/busy end must be after its start.');
          const window = freebusyPayload.safeParse({ start, end });
          if (!window.success) {
            const issues = window.error.issues.map((issue) => issue.message);
            throw new BrokerFault(
              'payload_invalid',
              issues.some((issue) => issue.includes(`at most ${MAX_FREEBUSY_DAYS} days`))
                ? `Choose a free/busy window of at most ${MAX_FREEBUSY_DAYS} days.`
                : `The free/busy window cannot be read: ${issues.join('; ')}.`,
            );
          }
          return { ...binding, start: window.data.start, end: window.data.end };
        }
        const connector = await openCalendar(target, tx);
        if (!connector.prepare || !connector.ahead || !connector.checkAhead)
          throw new BrokerFault(
            'scope_denied',
            'That calendar does not support checked event additions.',
          );
        const event = await connector.prepare(
          calendarEvent(payload),
          personalContext(ctx, target),
          tx,
          'calendar.create',
        );
        const names = await labelsIn(tx, ctx.space_id, [target.share.principalId]);
        return {
          ...binding,
          member_name: names.get(target.share.principalId) ?? 'Room member',
          event,
        };
      }
      // The payload already matched its tool's schema, and each tool's
      // required field is its own: `task`, `text` or `path`, and none for a list.
      if ('task' in payload) {
        const { target } = await handoffTarget(tx, ctx, payload);
        return { task: taskOf(payload), member_id: target };
      }
      const job = await ownWork(tx, ctx);
      if (!('room_id' in payload)) return payload;
      const room = await roomOf(tx, payload.room_id, job.principal_id);
      if ('text' in payload) {
        const thread = await threadOf(tx, room.id, payload.thread_id);
        return {
          room_id: room.id,
          thread_id: thread?.id ?? null,
          text: textOf(payload),
          room_name: room.name,
          thread_title: thread?.title ?? null,
        };
      }
      if ('path' in payload) {
        const file = await recorded(tx, ctx, payload);
        if (
          (payload.artifact_id && payload.artifact_id !== file.id) ||
          (payload.content_hash && payload.content_hash !== file.hash)
        )
          throw new BrokerFault(
            'payload_invalid',
            'The requested file version is no longer current',
          );
        return {
          room_id: room.id,
          path: file.relative,
          area: file.area,
          name: nameOf(payload),
          artifact_id: file.id,
          content_hash: file.hash,
          room_name: room.name,
        };
      }
      return payload;
    },
    async validateBinding(action, ctx, tx) {
      const payload = action.canonical_payload;
      if (calendarKind(action.kind)) {
        const write = action.kind === 'room.add_to_member_calendar';
        const target = await calendarTarget(tx, ctx, payload, write, true);
        if (write) {
          const connector = await openCalendar(target, tx);
          await connector.validateBinding?.(
            calendarAction(action),
            personalContext(ctx, target),
            tx,
          );
        }
        return;
      }
      if (action.kind === 'room.handoff') {
        const { target } = await handoffTarget(tx, ctx, payload);
        if (target !== payload.member_id) throw new BrokerFault('payload_invalid');
        return;
      }
      if (action.kind === 'room.list') {
        await ownWork(tx, ctx);
        return;
      }
      const job = await ownWork(tx, ctx);
      const room = await roomOf(tx, payload.room_id, job.principal_id);
      if (action.kind === 'room.post') {
        await threadOf(tx, room.id, payload.thread_id);
        return;
      }
      const file = await recorded(tx, ctx, payload);
      if (payload.artifact_id !== file.id || payload.content_hash !== file.hash)
        throw new BrokerFault('payload_invalid', 'The approved file version is no longer current');
    },
    async execute(action, ctx) {
      checkIdentity(action, ctx);
      ctx.signal?.throwIfAborted();
      if (calendarKind(action.kind)) return memberCalendar(action, ctx);
      if (action.kind === 'room.handoff') return handoff(action, ctx);
      if (action.kind === 'room.post') return post(action, ctx);
      if (action.kind === 'room.add_file') return addFile(action, ctx);
      if (action.kind === 'room.list') {
        const job = await ownWork(options.sql, ctx);
        const rooms = await options.sql`select s.id, s.name from space_membership m
          join space s on s.id = m.space_id
          where m.principal_id = ${job.principal_id} and m.revoked_at is null
            and m.role in ('owner', 'member') and s.kind = 'shared' and s.removed_at is null
          order by s.created_at, s.id limit 200`;
        return {
          outcome: 'succeeded',
          receipt: receiptFor(
            action,
            { rooms: rooms.map((row) => ({ id: String(row.id), name: String(row.name) })) },
            null,
          ),
        };
      }
      throw new Error('unknown room tool');
    },
    async verify(action, ctx) {
      checkIdentity(action, ctx);
      if (action.kind === 'room.add_to_member_calendar') {
        const target = await calendarTarget(options.sql, ctx, action.canonical_payload, true, true);
        const connector = await openCalendar(target);
        const result = await connector.verify(calendarAction(action), personalContext(ctx, target));
        await calendarTarget(options.sql, ctx, action.canonical_payload, true, true);
        return result.decision === 'succeeded' && result.receipt
          ? { ...result, receipt: { ...result.receipt, connection_id: action.connection_id } }
          : result;
      }
      if (action.kind === 'room.handoff') {
        const [row] = await db
          .select()
          .from(roomHandoff)
          .where(eq(roomHandoff.actionId, action.id));
        return row
          ? {
              decision: 'succeeded',
              evidence: { handoff_id: row.id },
              receipt: await handoffReceipt(db, action, row),
            }
          : { decision: 'undecided', reason: 'no hand-off was recorded for this action' };
      }
      if (action.kind === 'room.post') {
        const [row] = await db
          .select()
          .from(roomMessage)
          .where(eq(roomMessage.submissionId, sha256(`room-post:action:${action.id}`)));
        if (!row) return { decision: 'undecided', reason: 'no message was posted for this action' };
        const detail = { room_id: row.spaceId, thread_id: row.threadId, message_id: row.id };
        return {
          decision: 'succeeded',
          evidence: detail,
          receipt: receiptFor(action, detail, row.id),
        };
      }
      if (action.kind === 'room.add_file') {
        try {
          const payload = action.canonical_payload;
          const name = nameOf(payload);
          const roomId = String(payload.room_id);
          const content = await readFile(await roomFile(roomId, name, false));
          const copied = digest(content);
          if (copied !== payload.content_hash)
            return { decision: 'undecided', reason: 'the room has a different file by that name' };
          const detail = {
            room_id: roomId,
            name,
            content_hash: copied,
            bytes: content.byteLength,
          };
          return {
            decision: 'succeeded',
            evidence: detail,
            receipt: receiptFor(action, detail, name),
          };
        } catch (error) {
          return { decision: 'undecided', reason: (error as Error).message };
        }
      }
      return { decision: 'unsupported', reason: 'only an effect has anything to verify' };
    },
    async health() {
      try {
        await realpath(options.spacesRoot);
        return {
          status: 'ok',
          detail: 'rooms are available',
          checked_at: new Date().toISOString(),
        };
      } catch {
        return {
          status: 'failing',
          detail: 'the spaces root is missing',
          checked_at: new Date().toISOString(),
        };
      }
    },
  };
}
