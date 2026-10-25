/**
 * A chat is unread while something the person timed came due in it and they
 * have not opened the chat since: a reminder, or the chat's own schedule.
 *
 * What came due is the chat's current turn, one the chat opened by itself
 * (a `wake:` turn, see `jobs/wake-turn.ts`), finished with words. It stays
 * unread until the person opens the chat (`markSeen`); a message they send
 * there makes a new current turn, which ends it too.
 *
 * The rule is written twice, once for a row in hand (`cameDueUnseen`) and once
 * in SQL (`unseenReminders`), and the two are tested on the same rows.
 */
import type { NeedsYouItem } from '@melete/contracts';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Sql } from 'postgres';
import type { Database } from '../db/client.ts';
import { experienceTurn } from '../db/schema.ts';
import type { JobRow } from '../jobs/service.ts';
import { answerPreview } from '../push/service.ts';

/** How a turn a chat opened by itself is named; see `openWakeTurn`. */
export const WAKE_PREFIX = 'wake:';

type Turn = Pick<
  typeof experienceTurn.$inferSelect,
  'submissionId' | 'status' | 'answer' | 'seenAt'
>;

/** Whether `turn`, the chat's current turn, came due and has not been seen. */
export function cameDueUnseen(
  row: Pick<JobRow, 'kind' | 'audience' | 'experienceParentId'>,
  turn: Turn | null | undefined,
): boolean {
  return (
    row.kind === 'chat' &&
    row.audience === 'principal' &&
    row.experienceParentId === null &&
    turn?.submissionId.startsWith(WAKE_PREFIX) === true &&
    turn.status === 'done' &&
    turn.answer.trim().length > 0 &&
    turn.seenAt === null
  );
}

/** The person opened the chat: everything that came due in it so far is seen. */
export async function markSeen(db: Database, jobId: string): Promise<void> {
  await db
    .update(experienceTurn)
    .set({ seenAt: sql`now()` })
    .where(
      and(
        eq(experienceTurn.jobId, jobId),
        isNull(experienceTurn.seenAt),
        isNotNull(experienceTurn.finishedAt),
        sql`starts_with(${experienceTurn.submissionId}, ${WAKE_PREFIX})`,
      ),
    );
}

/** The longest a reminder's words run on Home before they are cut. */
const SENTENCE_LENGTH = 200;

/**
 * Reminders that came due in this person's chats and are not seen yet, for
 * Home's "Needs you", newest first. Each is the chat's current turn, so a chat
 * is listed once.
 */
export async function unseenReminders(query: Sql, principalId: string): Promise<NeedsYouItem[]> {
  const rows = (await query`
    select t.id as turn_id, j.id as job_id, j.title, t.answer, t.finished_at
    from job j
    join experience_turn t on t.id = j.current_turn_id and t.job_id = j.id
    where coalesce(j.principal_id, (select id from owner limit 1)) = ${principalId}
      and j.kind = 'chat'
      and j.audience = 'principal'
      and j.experience_parent_id is null
      and starts_with(t.submission_id, ${WAKE_PREFIX})
      and t.status = 'done'
      and length(trim(t.answer)) > 0
      and t.seen_at is null
    order by t.finished_at desc nulls last
    limit 20`) as unknown as Array<{
    turn_id: string;
    job_id: string;
    title: string;
    answer: string;
    finished_at: Date | string | null;
  }>;
  return rows.map((row) => {
    const at = row.finished_at ? new Date(row.finished_at).toISOString() : null;
    const title = row.title.trim() || 'A chat';
    return {
      id: row.turn_id,
      source: 'reminder',
      sentence: answerPreview(row.answer).slice(0, SENTENCE_LENGTH) || title,
      reason: 'It came due at the time you set.',
      because: {
        kind: 'reminder',
        label: 'You asked for a reminder',
        handle: `turn:${row.turn_id}`,
        // The chat it came due in, by name.
        subject: title.slice(0, 300),
        at,
      },
      // The person chose this time; it is due now, which ranks it on its own (see TriageService.needsYou).
      urgency: 'normal',
      seen: false,
      created_at: at ?? new Date().toISOString(),
      chat_prompt: null,
      conversation_id: row.job_id,
    };
  });
}
