/**
 * The built-in `room` connection: the only ways anything crosses between a
 * room and a person's own space, each an effect the broker admits and
 * receipts like any other.
 *
 * A room's request has one tool, `room.handoff`. The room's agent cannot use
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
import { namesOf } from '../rooms/transcript.ts';
import { LocalWorkspaceFs } from '../runtime/workspace-fs.ts';
import { noLinks, segmentsFor } from './files.ts';
import type { Connector, ConnectorContext } from './types.ts';

const TEXT_LIMIT = 8000;

export const roomManifest: ConnectorManifest = {
  name: 'room',
  version: '0.1.0',
  provider: 'room',
  description:
    "Hand a room's request to one of its people, and post or add files to a room a person is in.",
  credentials: [],
  health: true,
  tools: [
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
        receipt: receiptFor(action, { room_id: roomId, name, content_hash: hash }, name),
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
    async prepare(payload, ctx, tx) {
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
          const copied = digest(await readFile(await roomFile(roomId, name, false)));
          if (copied !== payload.content_hash)
            return { decision: 'undecided', reason: 'the room has a different file by that name' };
          const detail = { room_id: roomId, name, content_hash: copied };
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
