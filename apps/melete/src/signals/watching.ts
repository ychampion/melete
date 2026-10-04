/**
 * The per-account switch "Watch this account for changes".
 *
 * A mailbox or calendar a person connects in their own space is watched with
 * nothing set up; one in a room is watched only once the room's owners turn
 * it on. Turning it off stops the reads that watching made and removes, in the
 * same step, what they left: where the account's feed was read to, what was
 * kept about its calendar, and the observations nothing has used. What a job
 * or a situation already took in stays with it, and work that set its own
 * trigger on the account still hears it.
 */
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { WATCHED_PROVIDERS } from './poller.ts';
import { pruneObservations } from './retention.ts';

/** Whether a connection is a mailbox or a calendar, the kinds that can be watched. */
export const watchable = (provider: string) => provider in WATCHED_PROVIDERS;

export async function setWatching(
  sql: Sql,
  spaceId: string,
  connectionId: string,
  on: boolean,
): Promise<void> {
  await sql.begin(async (tx) => {
    // Exclusive of a read writing what it found: one in flight when this
    // commits checks the switch before it keeps anything.
    const [row] = await tx`select provider from connection
      where id = ${connectionId} and space_id = ${spaceId} and status <> 'revoked'
      for update`;
    if (!row) throw new ServiceError('not_found', 'Connection not found.', 404);
    if (!watchable(String(row.provider)))
      throw new ServiceError(
        'not_watchable',
        'Only a mailbox or a calendar can be watched for changes.',
        400,
      );
    await tx`update connection set watch_changes = ${on} where id = ${connectionId}`;
    if (on) return;
    await tx`delete from source_cursor where connection_id = ${connectionId}`;
    await tx`delete from subject_state where connection_id = ${connectionId}`;
    // Every unheld observation, however many: batches until none is left.
    while ((await pruneObservations(tx, { connectionId })) > 0);
  });
}
