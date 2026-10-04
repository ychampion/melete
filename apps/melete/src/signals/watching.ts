/**
 * The per-account switch "Watch this account for changes".
 *
 * A mailbox or calendar a person connects in their own space is watched with
 * nothing set up; one in a room is watched only once the room's owners turn
 * it on. Turning it off stops the reads that watching made and forgets where
 * the account's feed was read to and what was kept about its calendar. Work
 * that set its own trigger on the account still hears it.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { connection } from '../db/schema.ts';
import { WATCHED_PROVIDERS } from './poller.ts';

/** Whether a connection is a mailbox or a calendar, the kinds that can be watched. */
export const watchable = (provider: string) => provider in WATCHED_PROVIDERS;

export async function setWatching(
  db: Database,
  spaceId: string,
  connectionId: string,
  on: boolean,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ provider: connection.provider })
      .from(connection)
      .where(
        and(
          eq(connection.id, connectionId),
          eq(connection.spaceId, spaceId),
          ne(connection.status, 'revoked'),
        ),
      )
      .for('update');
    if (!row) throw new ServiceError('not_found', 'Connection not found.', 404);
    if (!watchable(row.provider))
      throw new ServiceError(
        'not_watchable',
        'Only a mailbox or a calendar can be watched for changes.',
        400,
      );
    await tx.update(connection).set({ watchChanges: on }).where(eq(connection.id, connectionId));
    if (on) return;
    await tx.execute(sql`delete from source_cursor where connection_id = ${connectionId}`);
    await tx.execute(sql`delete from subject_state where connection_id = ${connectionId}`);
  });
}
