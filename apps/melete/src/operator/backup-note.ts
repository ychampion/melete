/**
 * When the newest backup was taken, as the service can see it. `melete backup`
 * runs on the host and notes each backup it finishes there (packages/cli,
 * backup-age.ts); it also leaves this note in the database, which is all the
 * service can read, so the operator console can say how old the newest backup
 * is. The note holds a time and the backup's name, nothing else.
 */
import type { Sql } from 'postgres';

export const BACKUP_NOTE_KIND = 'backup_taken';

/** A newest backup older than this is stale: a day, with room for a late run. */
export const MAX_BACKUP_AGE_HOURS = 26;

/**
 * The statement the backup command runs once a backup is finished. It is one
 * line with no double quotes, so it can ride in `psql -c "..."`; the name and
 * time it carries are checked first, so nothing else can.
 */
export function backupNoteStatement(name: string, at: Date): string {
  if (!/^melete-\d{8}T\d{6}Z$/.test(name)) throw new Error(`not a backup name: ${name}`);
  const time = at.toISOString();
  return `insert into event (type, payload, dedup_key) values ('notice', jsonb_build_object('kind', '${BACKUP_NOTE_KIND}', 'at', '${time}', 'name', '${name}'), 'backup:${name}') on conflict (dedup_key) do nothing`;
}

/** When the newest noted backup was taken, or null when none was noted. */
export async function newestBackupAt(sql: Sql): Promise<Date | null> {
  const [row] = await sql<{ at: Date | string | null }[]>`
    select max((payload->>'at')::timestamptz) as at from event
    where job_id is null and type = 'notice' and payload->>'kind' = ${BACKUP_NOTE_KIND}`;
  return row?.at ? new Date(row.at) : null;
}
