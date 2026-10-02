/**
 * What was done in the person's name by chats and plans they deleted. The
 * deletion copies each outward effect here first (see `removal.ts`), so the
 * record of what happened outlives the conversation that did it.
 */
import { activityList } from '@melete/contracts';
import type { Sql } from 'postgres';
import { doneLabel, plainText } from './projectors.ts';

export async function listActivity(sql: Sql, spaceId: string, principalId: string) {
  const rows = await sql`select id, kind, connection_label, destination, external_ref, outcome,
      source, happened_at
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
      reference: row.external_ref ?? null,
      outcome: 'succeeded',
      source: plainText(row.source, 'A deleted chat', 200),
      happened_at: new Date(row.happened_at).toISOString(),
    })),
  });
}
