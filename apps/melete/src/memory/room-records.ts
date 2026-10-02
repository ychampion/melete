/**
 * A room's own removals, as the restriction journal keeps them: a message its
 * author deleted, and a person's detail they stopped sharing into the room.
 * Each is applied once when it is made and again by every replay of the
 * journal, so a database restored from before it still loses what it removed.
 * Applying one twice changes nothing the first did not.
 */
import { randomBytes } from 'node:crypto';
import { enqueue, type MemoryTx } from './db.ts';
import { invalidateDependencies } from './invalidate.ts';
import type { RestrictionRecord } from './restore.ts';

/** What the text of a request reads once the message that asked it is deleted. */
export const DELETED_REQUEST =
  'The message that asked this was deleted by the person who wrote it.';

export const isRoomRecord = (record: Pick<RestrictionRecord, 'operation'>) =>
  record.operation === 'redact_room_message' || record.operation === 'withdraw_room_share';

export async function applyRoomRecord(tx: MemoryTx, record: RestrictionRecord) {
  if (record.operation === 'redact_room_message' && record.room_message_id)
    await redactRoomMessage(tx, record.space_id, record.room_message_id, record.recorded_at);
  if (record.operation === 'withdraw_room_share' && record.grant_id)
    await withdrawRoomShare(tx, record.space_id, record.grant_id, record.recorded_at);
}

/**
 * Remove a room message's words from everywhere the service copied them: the
 * message itself, the messages and turn of the request it reached, and the
 * request's own text when it asked for it. Work in the thread that read it is
 * started again without it. The caller holds the event order lock.
 */
export async function redactRoomMessage(
  tx: MemoryTx,
  spaceId: string,
  messageId: string,
  at: string,
) {
  const [message] =
    await tx`select id, thread_id, author_principal_id, text, redacted_at, created_at
    from room_message where id = ${messageId} and space_id = ${spaceId} for update`;
  if (!message) return;
  const text = String(message.text ?? '');
  const author = String(message.author_principal_id);
  const requests = await tx`select id, objective from job
    where room_thread_id = ${message.thread_id} and space_id = ${spaceId} and audience = 'room'
    order by id for update`;
  const ids = requests.map((row) => String(row.id));
  if (text) {
    // The request read the message as its own input; that copy goes, and the
    // turn that showed it keeps its place with no words.
    await tx`update event set payload = (payload - 'text') || '{"redacted": true}'::jsonb
      where job_id = any(${ids}) and type = 'notice' and payload->>'kind' = 'user_message'
        and payload->>'principal_id' = ${author} and payload->>'text' = ${text}`;
    await tx`update experience_turn set text = ''
      where job_id = any(${ids}) and author_principal_id = ${author} and text = ${text}`;
    // A thread started by the message is named by its first line; that goes too.
    const firstLine = text.split(/\r?\n/)[0]?.trim().slice(0, 200) ?? '';
    await tx`update room_thread set title = 'Thread'
      where id = ${message.thread_id} and space_id = ${spaceId} and title = ${firstLine}
        and not exists (select 1 from room_message earlier where earlier.thread_id = room_thread.id
          and (earlier.created_at, earlier.id) < (${message.created_at}, ${messageId}))`;
    for (const request of requests) {
      if (request.objective !== text) continue;
      await tx`update job set objective = ${DELETED_REQUEST}, title = 'Request', updated_at = clock_timestamp()
        where id = ${request.id}`;
      await tx`update event set payload = jsonb_set(payload, '{title}', '"Request"')
        where job_id = ${request.id} and type = 'job_created'`;
    }
  }
  // A replay that finds the message already scrubbed changes nothing, and
  // fences nothing.
  if (message.redacted_at && !text) return;
  // An ask still waiting its turn stops asking: there is nothing left to ask.
  await tx`update room_message set text = '', mentions = '[]'::jsonb,
      redacted_at = coalesce(redacted_at, ${at}::timestamptz),
      request_state = case when request_state = 'pending' then 'none' else request_state end
    where id = ${messageId}`;
  // A live thread sends the message again, now with no words.
  const payload = {
    kind: 'room_message',
    space_id: spaceId,
    thread_id: message.thread_id,
    message_id: messageId,
  };
  const [written] = await tx`insert into event (type, payload, dedup_key)
    values ('notice', ${JSON.stringify(payload)}::text::jsonb,
      ${`room_message:${messageId}:${randomBytes(8).toString('hex')}`}) returning seq`;
  if (written) {
    await tx`select pg_notify('melete_events', ${String(written.seq)})`;
    await tx`update room_message set stream_seq = ${written.seq} where id = ${messageId}`;
  }
  // Capture that has not reached it yet never will.
  await tx`insert into memory_room_capture (message_id, space_id, outcome)
    values (${messageId}, ${spaceId}, 'skipped:deleted') on conflict (message_id) do nothing`;
  await fenceThread(tx, spaceId, ids);
}

/**
 * Work under way in the thread was handed the thread as it was, deleted
 * words included. It starts again, as a correction to its memory would make
 * it: a new revision, the attempt fenced, and the job queued to wake.
 */
async function fenceThread(tx: MemoryTx, spaceId: string, jobIds: string[]) {
  if (!jobIds.length) return;
  const fenced = await tx`update job set revision = revision + 1, lease_epoch = lease_epoch + 1,
      state_version = state_version + 1, updated_at = clock_timestamp(),
      state = case when exists (select 1 from action where action.job_id = job.id
          and action.status in ('admitted','dispatched','unknown','unresolved'))
        then 'needs_reconciliation' else 'queued' end,
      next_wake_at = clock_timestamp()
    where id = any(${jobIds}) and state in ('running', 'queued')
      and exists (select 1 from attempt a where a.job_id = job.id and a.ended_at is null)
    returning id`;
  const ids = fenced.map((row) => String(row.id));
  if (!ids.length) return;
  await tx`update attempt set outcome = 'fenced', ended_at = clock_timestamp()
    where job_id = any(${ids}) and ended_at is null`;
  await tx`update memory_contexts set invalidated_at = clock_timestamp(), items = '[]'::jsonb
    where job_id = any(${ids}) and invalidated_at is null`;
  const [memory] = await tx`select space_id from memory_spaces where space_id = ${spaceId}`;
  if (memory) for (const id of ids) await enqueue(tx, spaceId, 'job_recompute', id);
}

/** Stop sharing a person's detail into a room; work that was handed it starts again without it. */
export async function withdrawRoomShare(
  tx: MemoryTx,
  roomSpaceId: string,
  grantId: string,
  at: string,
) {
  const [grant] = await tx`update memory_room_grant set revoked_at = ${at}::timestamptz
    where id = ${grantId} and room_space_id = ${roomSpaceId} and revoked_at is null
    returning claim_id`;
  if (grant) await invalidateRoomContexts(tx, roomSpaceId, [String(grant.claim_id)]);
}

/** Invalidate what a room's work was handed of these shared details. The caller holds the event order lock. */
export async function invalidateRoomContexts(
  tx: MemoryTx,
  roomSpaceId: string,
  claimIds: string[],
) {
  if (!claimIds.length) return;
  const [memory] =
    await tx`select owner_id, data_revision from memory_spaces where space_id = ${roomSpaceId}`;
  if (!memory) return;
  await invalidateDependencies(
    tx,
    {
      ownerId: String(memory.owner_id),
      spaceId: roomSpaceId,
      publisher: 'room',
      role: 'owner',
      audience: 'space',
    },
    claimIds,
    Number(memory.data_revision),
  );
}

/**
 * A person forgot details in their own space. Every room they were shared
 * into loses them at once: what the room's work was handed of them is
 * invalidated in the same transaction.
 */
export async function invalidateSharedInRooms(
  tx: MemoryTx,
  sourceSpaceId: string,
  claimIds: string[],
  all: boolean,
) {
  const rooms = await tx`select room_space_id, array_agg(distinct claim_id) as claims
    from memory_room_grant where source_space_id = ${sourceSpaceId}
      and (${all} or claim_id = any(${claimIds}))
    group by room_space_id order by room_space_id`;
  for (const room of rooms)
    await invalidateRoomContexts(tx, String(room.room_space_id), room.claims as string[]);
}
