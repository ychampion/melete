/**
 * The start of an inbound call, and the end of every call.
 *
 * An inbound call from one of the person's own numbers reaches Melete as the
 * person; anybody else hears one polite sentence and the person gets a note.
 * At the end of a call its transcript, outcome and length are kept, the call
 * appears in the conversation it belongs to, what the person said on their own
 * call goes to memory the way anything they type does, and what the call asked
 * for is put to the person as a question: a follow-up becomes an ordinary
 * proposal only after they answer, never on the call.
 */
import type { ToolCall } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { appendEvent, lockJob, recordId } from '../broker/records.ts';
import { appendToolTrace, toolText } from '../experience/tools.ts';
import { newId } from '../ids.ts';
import type { JobService } from '../jobs/service.ts';
import type { ConversationRecord } from './elevenlabs.ts';
import { normalizeNumber } from './hours.ts';
import { type Line, lineOwner } from './line.ts';
import { phoneLine, type StoredLine } from './schema.ts';
import type { CallRow } from './turns.ts';

export type CallRecordDeps = { sql: Sql; jobs?: JobService };

/** Notes about strangers are kept to one per number in this window. */
const STRANGER_NOTE_WINDOW = '1 hour';

export function openingForPerson(name: string) {
  return `Hi ${name}, it's Melete. What can I do for you?`;
}
/** Said to a caller who is not the person. It names nobody. */
export const STRANGER_OPENING =
  'Hello. You have reached an automated assistant that only takes calls from its owner. I will let them know you called. Goodbye.';

/** The fixed opening of a call Melete places. It always says what is calling, and for whom. */
export function outboundOpening(name: string, calleeName?: string) {
  return `Hello${calleeName ? ` ${calleeName}` : ''}, this is Melete, an AI assistant calling on behalf of ${name}.`;
}

/**
 * The conversation a line's inbound calls are told in, made the first time
 * one is needed. It is an ordinary conversation, waiting for the person.
 */
async function lineConversation(deps: CallRecordDeps, line: Line): Promise<string | null> {
  const jobs = deps.jobs;
  if (!jobs) return null;
  const [known] = await deps.sql`select job_id from phone_line where connection_id = ${line.id}`;
  if (known?.job_id) return String(known.job_id);
  const created = await jobs.transaction(async (tx) => {
    // The line's row is the lock, so two calls arriving together make one conversation.
    await tx.insert(phoneLine).values({ connectionId: line.id }).onConflictDoNothing();
    const [row] = await tx
      .select({ jobId: phoneLine.jobId })
      .from(phoneLine)
      .where(eq(phoneLine.connectionId, line.id))
      .for('update');
    if (row?.jobId) return row.jobId;
    const job = await jobs.createInTransaction(
      tx,
      {
        space_id: line.spaceId,
        title: `Calls on ${line.stored.phone.number}`,
        objective: `Calls to and from the phone line ${line.label}.`,
      },
      { kind: 'chat' },
    );
    await tx.update(phoneLine).set({ jobId: job.id }).where(eq(phoneLine.connectionId, line.id));
    return job.id;
  });
  return created;
}

const minutes = (seconds: number | null) =>
  seconds === null
    ? ''
    : seconds < 60
      ? `${seconds} seconds`
      : `${Math.round(seconds / 60)} minute${Math.round(seconds / 60) === 1 ? '' : 's'}`;

async function trace(sql: Sql, jobId: string, attemptId: string | null, call: ToolCall) {
  await sql.begin(async (tx) => {
    const job = await lockJob(tx, jobId).catch(() => null);
    if (!job) return;
    await appendToolTrace(tx, jobId, attemptId, call);
  });
}

/**
 * Who is calling, decided once when the call starts. The row it writes is the
 * only place later turns learn it from.
 */
export async function startInbound(
  deps: CallRecordDeps,
  line: Line,
  input: { callerId?: string; conversationId?: string },
) {
  const caller = normalizeNumber(input.callerId);
  const person = caller !== null && line.stored.phone.allowed_callers.includes(caller);
  const conversationId = input.conversationId?.trim() || null;
  const id = newId('call');
  const [inserted] = await deps.sql<{ id: string; party: string }[]>`insert into phone_call
      (id, connection_id, space_id, direction, party, remote_number, conversation_id, status)
    values (${id}, ${line.id}, ${line.spaceId}, 'inbound', ${person ? 'person' : 'unknown'},
      ${caller ?? 'withheld'}, ${conversationId}, 'in_progress')
    on conflict (connection_id, conversation_id) where conversation_id is not null do nothing
    returning id, party`;
  // ElevenLabs may ask twice for the same call; the first answer stands.
  const [existing] = inserted
    ? [inserted]
    : await deps.sql<{ id: string; party: string }[]>`select id, party from phone_call
        where connection_id = ${line.id} and conversation_id = ${conversationId}`;
  const call = existing ?? { id, party: 'unknown' };
  if (inserted && !person) await noteStranger(deps, line, call.id, caller);
  return {
    callId: call.id,
    opening:
      call.party === 'person' ? openingForPerson(line.stored.phone.on_behalf_of) : STRANGER_OPENING,
  };
}

async function noteStranger(
  deps: CallRecordDeps,
  line: Line,
  callId: string,
  caller: string | null,
) {
  const [recent] = await deps.sql`select count(*)::int as calls from phone_call
    where connection_id = ${line.id} and party = 'unknown' and remote_number = ${caller ?? 'withheld'}
      and id <> ${callId} and created_at > now() - ${STRANGER_NOTE_WINDOW}::interval`;
  if (Number(recent?.calls ?? 0) > 0) return;
  const jobId = await lineConversation(deps, line).catch(() => null);
  if (!jobId) return;
  const now = new Date().toISOString();
  await trace(deps.sql, jobId, null, {
    id: `phone:${callId}`,
    kind: 'connector',
    title: caller ? `Took a call from ${caller}` : 'Took a call from a withheld number',
    status: 'done',
    started_at: now,
    ended_at: now,
    input_summary: null,
    output_summary: {
      text: 'Not one of your numbers, so the caller heard a short message and the call ended.',
    },
    detail: { type: 'receipt', id: callId },
    parent: null,
  });
}

/** A transcript as ElevenLabs reports it, as the call keeps it. */
export function keptTranscript(record: ConversationRecord): StoredLine[] {
  return (record.transcript ?? [])
    .filter((entry) => typeof entry.message === 'string' && entry.message.trim())
    .map((entry) => ({
      speaker: entry.role === 'agent' ? ('melete' as const) : ('caller' as const),
      text: String(entry.message).slice(0, 10_000),
      at_seconds:
        typeof entry.time_in_call_secs === 'number' && entry.time_in_call_secs >= 0
          ? entry.time_in_call_secs
          : null,
    }))
    .slice(0, 2000);
}

/** The call a report is about: by the id the call carried, or by ElevenLabs' conversation id. */
export async function callForReport(
  sql: Sql,
  lineId: string,
  record: ConversationRecord,
  conversationId: string | null,
): Promise<CallRow | null> {
  const carried = record.conversation_initiation_client_data?.custom_llm_extra_body?.call_id;
  if (typeof carried === 'string') {
    const [row] = await sql<CallRow[]>`select * from phone_call
      where id = ${carried} and connection_id = ${lineId}`;
    if (row) return row;
  }
  if (!conversationId) return null;
  const [row] = await sql<CallRow[]>`select * from phone_call
    where connection_id = ${lineId} and conversation_id = ${conversationId}`;
  return row ?? null;
}

/**
 * Keep what the call was, once, and tell it where it belongs. A report sent
 * again finds the call already ended and changes nothing.
 */
export async function finishCall(
  deps: CallRecordDeps,
  line: Line,
  call: CallRow,
  record: ConversationRecord,
) {
  const transcript = keptTranscript(record);
  const duration =
    typeof record.metadata?.call_duration_secs === 'number'
      ? Math.max(0, Math.round(record.metadata.call_duration_secs))
      : null;
  const summary = record.analysis?.transcript_summary?.trim() || null;
  const [ended] = await deps.sql<CallRow[]>`update phone_call set status = 'ended',
      transcript = ${JSON.stringify(transcript)}::jsonb,
      duration_seconds = ${duration},
      outcome = coalesce(outcome, ${summary ? summary.slice(0, 2000) : null}),
      conversation_id = coalesce(conversation_id, ${record.conversation_id ?? null}),
      holding = false,
      ended_at = now()
    where id = ${call.id} and status not in ('ended', 'failed')
    returning *`;
  if (!ended) return false;
  const length = minutes(duration);
  const outcome = toolText(ended.outcome ?? '');
  if (ended.direction === 'outbound' && ended.job_id) {
    await trace(deps.sql, ended.job_id, ended.attempt_id, {
      id: `phone:${ended.id}`,
      kind: 'connector',
      title: `Called ${ended.remote_number}`,
      status: 'done',
      started_at: new Date(ended.created_at).toISOString(),
      ended_at: new Date().toISOString(),
      input_summary: null,
      output_summary: {
        text: length ? `The call ended after ${length}.` : 'The call ended.',
        ...(outcome ? { quote: { text: outcome, from: 'event' as const } } : {}),
      },
      detail: { type: 'receipt', id: ended.id },
      parent: null,
    });
    await proposeFollowUps(
      deps.sql,
      ended.job_id,
      ended.attempt_id,
      ended,
      `the call to ${ended.remote_number}`,
    );
    return true;
  }
  if (ended.party !== 'person') return true;
  const jobId = await lineConversation(deps, line).catch(() => null);
  if (!jobId) return true;
  const owner = await lineOwner(deps.sql, line.spaceId);
  const said = transcript
    .filter((entry) => entry.speaker === 'caller')
    .map((entry) => entry.text.trim())
    .join('\n');
  await deps.sql.begin(async (tx) => {
    const job = await lockJob(tx, jobId).catch(() => null);
    if (!job) return;
    // The person's own words on their own call, as a message of theirs: the
    // path everything they type takes to memory.
    if (said)
      await appendEvent(
        tx,
        jobId,
        null,
        'notice',
        { kind: 'user_message', text: said, principal_id: owner, via: 'phone', call_id: ended.id },
        `phone:${ended.id}:said`,
      );
    await appendToolTrace(tx, jobId, null, {
      id: `phone:${ended.id}`,
      kind: 'connector',
      title: 'Took your call',
      status: 'done',
      started_at: new Date(ended.created_at).toISOString(),
      ended_at: new Date().toISOString(),
      input_summary: null,
      output_summary: {
        text: length ? `You talked for ${length}.` : 'The call ended.',
        ...(outcome ? { quote: { text: outcome, from: 'event' as const } } : {}),
      },
      detail: { type: 'receipt', id: ended.id },
      parent: null,
    });
  });
  await proposeFollowUps(deps.sql, jobId, null, ended, 'your call');
  return true;
}

/**
 * What a call asked for, put to the person as the job's question. Answering it
 * is an ordinary message to the job, and whatever it leads to is proposed and
 * approved like anything else.
 */
async function proposeFollowUps(
  sql: Sql,
  jobId: string,
  attemptId: string | null,
  call: CallRow,
  which: string,
) {
  const items = (call.follow_ups ?? []).filter((item) => typeof item === 'string' && item.trim());
  if (!items.length) return;
  await sql.begin(async (tx) => {
    const job = await lockJob(tx, jobId).catch(() => null);
    if (!job || ['cancelled', 'completed', 'failed'].includes(String(job.state))) return;
    const text = `After ${which}, these need doing: ${items.map((item) => item.trim()).join('; ')}. Shall I go ahead?`;
    const [row] = await tx`insert into question
        (id, source, job_id, attempt_id, text, because, if_ignored, blocks_external_effect)
      values (${recordId('qst')}, 'job', ${jobId}, ${attemptId}, ${text.slice(0, 2000)},
        ${JSON.stringify([`They came up on ${which}. Nothing was agreed or done on the call.`])}::jsonb,
        'Nothing from the call is done until you answer.', false)
      on conflict (job_id) where state = 'open' do nothing
      returning id`;
    await appendEvent(tx, jobId, attemptId, 'notice', {
      phase: 'phone_follow_ups',
      call_id: call.id,
      question_id: (row?.id as string | undefined) ?? null,
    });
  });
}

const NOT_CONNECTED: Record<string, string> = {
  busy: 'The line was busy.',
  'no-answer': 'Nobody answered.',
};

/** A call that never connected: kept as failed, with the reason in plain words. */
export async function callNotConnected(
  deps: CallRecordDeps,
  call: CallRow,
  reason: string | undefined,
) {
  const failure = NOT_CONNECTED[reason ?? ''] ?? 'The call did not connect.';
  const [failed] = await deps.sql<CallRow[]>`update phone_call set status = 'failed',
      failure = ${failure}, ended_at = now()
    where id = ${call.id} and status not in ('ended', 'failed') returning *`;
  if (!failed?.job_id) return Boolean(failed);
  await trace(deps.sql, failed.job_id, failed.attempt_id, {
    id: `phone:${failed.id}`,
    kind: 'connector',
    title: `Called ${failed.remote_number}`,
    status: 'failed',
    started_at: new Date(failed.created_at).toISOString(),
    ended_at: new Date().toISOString(),
    input_summary: null,
    output_summary: { text: failure },
    detail: { type: 'receipt', id: failed.id },
    parent: null,
  });
  return true;
}
