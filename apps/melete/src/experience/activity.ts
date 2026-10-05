/**
 * What was done in the person's name by chats and plans they deleted. The
 * deletion copies each outward effect here first (see `removal.ts`), so the
 * record of what happened outlives the conversation that did it.
 */
import { activityList } from '@melete/contracts';
import type { Sql } from 'postgres';
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
  return value.length > 32 ? `${value.slice(0, 24)}…` : value;
}

export async function listActivity(sql: Sql, spaceId: string, principalId: string) {
  const rows = await sql`select id, kind, connection_label, destination, external_ref, outcome,
      source, happened_at, reversal, undo_until, undone_at
    from activity_record
    where space_id = ${spaceId}
      and coalesce(principal_id, (select id from owner limit 1)) = ${principalId}
    order by happened_at desc, id desc
    limit 200`;
  return activityList.parse({
    activity: rows.map((row) => ({
      id: row.id,
      what: doneLabel(String(row.kind)) ?? 'Did something in a connected app',
      where: plainText(row.connection_label, 'A connection', 200),
      destination: row.destination ?? null,
      reference: plainReference(row.external_ref),
      outcome: 'succeeded',
      source: plainText(row.source, 'A deleted chat', 200),
      happened_at: new Date(row.happened_at).toISOString(),
      ...(row.reversal && !row.undone_at && row.undo_until && new Date(row.undo_until) > new Date()
        ? { undo: { valid_until: new Date(row.undo_until).toISOString() } }
        : {}),
      ...(row.undone_at ? { undone_at: new Date(row.undone_at).toISOString() } : {}),
    })),
  });
}
