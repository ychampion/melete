/**
 * What was done in the person's name by chats and plans they deleted. The
 * deletion copies each outward effect here first (see `removal.ts`), so the
 * record of what happened outlives the conversation that did it.
 */
import { activityList } from '@melete/contracts';
import type { Sql } from 'postgres';
import { SUMMARY_NOTE_WORDS, SUMMARY_NOTES, summaryNoteOf } from '../spaces/summaries.ts';
import { doneLabel, plainText } from './projectors.ts';

/**
 * The destination's own reference, when it means something to a person: a
 * message or event id they could look up there. A content hash or one of
 * Melete's own ids names nothing they can find, so it is left out; a long
 * reference is shortened.
 */
export function plainReference(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  const value = ref.trim();
  if (!value) return null;
  if (/^(?:sha256:)?[0-9a-f]{32,}$/i.test(value)) return null;
  if (/^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) return null;
  // Melete's own browser sessions and trash entries: brws_<uuid>, del_<time>_<hex>.
  if (/^[a-z]+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    return null;
  if (/^del_\d{10,}_[0-9a-f]{6,}$/.test(value)) return null;
  return value.length > 32 ? `${value.slice(0, 24)}…` : value;
}

/**
 * The person's own record, and the notes the space keeps for everyone in it:
 * which originals were opened in a summaries-only space, by whom, and when it
 * was turned on or off (see `spaces/summaries.ts`).
 */
export async function listActivity(sql: Sql, spaceId: string, principalId: string) {
  const rows = await sql`select id, kind, connection_label, destination, external_ref, outcome,
      source, happened_at, reversal, undo_until, undone_at
    from activity_record
    where space_id = ${spaceId}
      and (kind = any(${Object.values(SUMMARY_NOTES)})
        or coalesce(principal_id, (select id from owner limit 1)) = ${principalId})
    order by happened_at desc, id desc
    limit 200`;
  return activityList.parse({
    activity: rows.map((row) => {
      const note = summaryNoteOf(String(row.kind));
      if (note)
        return {
          id: row.id,
          what: SUMMARY_NOTE_WORDS[note],
          where: plainText(row.connection_label, 'This space', 200),
          destination: row.destination ? plainText(row.destination, '', 500) || null : null,
          reference: null,
          outcome: 'succeeded',
          source: plainText(row.source, 'Someone', 200),
          happened_at: new Date(row.happened_at).toISOString(),
          note,
        };
      return {
        id: row.id,
        what: doneLabel(String(row.kind)) ?? 'Did something in a connected app',
        where: plainText(row.connection_label, 'A connection', 200),
        destination: row.destination ?? null,
        reference: plainReference(row.external_ref),
        outcome: 'succeeded',
        source: plainText(row.source, 'A deleted chat', 200),
        happened_at: new Date(row.happened_at).toISOString(),
        ...(row.reversal &&
        !row.undone_at &&
        row.undo_until &&
        new Date(row.undo_until) > new Date()
          ? { undo: { valid_until: new Date(row.undo_until).toISOString() } }
          : {}),
        ...(row.undone_at ? { undone_at: new Date(row.undone_at).toISOString() } : {}),
      };
    }),
  });
}
