/**
 * A meeting transcript offered to memory through its ordinary ingestion path.
 *
 * It is a `document` written by others (`author: external`), so every source
 * it yields is `external_content`: memory may recall what was said, but a
 * value taken from it can never stand in for the person's own say-so when the
 * broker admits an effect.
 */
import type { PgBoss } from 'pg-boss';
import type { Sql } from 'postgres';
import type { MemoryScope } from '../memory/db.ts';
import { persistEvidence } from '../memory/evidence.ts';
import { MEMORY_EXTRACT_QUEUE } from '../memory/work.ts';
import type { MeetingEvidence } from './notes.ts';

export const MEETINGS_PUBLISHER = 'meetings';
/** Memory reads one source of this size in segments; a longer meeting is cut here. */
const MAX_TEXT = 500_000;

export async function rememberMeeting(
  sql: Sql,
  scopeForJob: (jobId: string) => Promise<MemoryScope>,
  boss: PgBoss | undefined,
  conversationId: string,
  evidence: MeetingEvidence,
): Promise<void> {
  const scope: MemoryScope = {
    ...(await scopeForJob(conversationId)),
    publisher: MEETINGS_PUBLISHER,
  };
  if (scope.role !== 'owner') return;
  const stored = await sql.begin((tx) =>
    persistEvidence(tx, scope, {
      stream: 'meetings',
      source_identity: evidence.identity,
      source_version: '1',
      source_type: 'document',
      author: 'external',
      event_at: evidence.event_at,
      text: evidence.text.slice(0, MAX_TEXT),
    }),
  );
  if (!boss || stored.source.state !== 'active') return;
  const work = await sql`select id from memory_work
    where source_id = ${stored.source.source_id} and status = 'pending'`;
  for (const item of work)
    await boss.send(
      MEMORY_EXTRACT_QUEUE,
      { work_id: item.id, space_id: scope.spaceId },
      { singletonKey: String(item.id), singletonSeconds: 1 },
    );
}
