/**
 * The Composio accounts Melete's connections act for, and taking one away
 * when no connection acts for it any more. One Composio account may stand
 * behind more than one connection only while a transport switch is settling,
 * so an account is removed only once no live connection names it.
 *
 * Taking an account away goes through a small queue, `managed_account_removal`,
 * whenever it cannot happen at once: a removed space's accounts, a
 * disconnection Composio could not be reached for, and the account a sign-in
 * link made, due once that sign-in has expired unfinished. A row leaves the
 * queue only when Composio confirms the account is gone, or when a live
 * connection is found acting for it; a failure only moves its next try later.
 */
import type { Sql } from 'postgres';
import { type ComposioClient, ComposioFault } from './composio.ts';

/** Whether any live connection, other than `except`, still acts for a Composio account. */
export async function managedAccountInUse(
  sql: Sql,
  connectedAccountId: string,
  except?: string,
): Promise<boolean> {
  const [row] = await sql`select 1 as present from connection
    where status <> 'revoked' and configuration->>'via' = 'composio'
      and configuration->>'connected_account_id' = ${connectedAccountId}
      and (${except ?? null}::text is null or id <> ${except ?? null})
    limit 1`;
  return Boolean(row);
}

/**
 * Queue accounts to be removed at Composio, from `due` on. An account already
 * queued keeps the earlier of its two times.
 */
export async function queueManagedRemoval(
  sql: Sql,
  connectedAccountIds: readonly string[],
  due: Date = new Date(),
): Promise<void> {
  for (const id of new Set(connectedAccountIds))
    if (id)
      await sql`insert into managed_account_removal (connected_account_id, next_attempt_at)
        values (${id}, ${due.toISOString()}::timestamptz)
        on conflict (connected_account_id) do update
          set next_attempt_at = least(managed_account_removal.next_attempt_at, excluded.next_attempt_at)`;
}

/** An account that no longer needs removing from the queue: it was kept, or is handled now. */
export async function settleManagedRemoval(sql: Sql, connectedAccountId: string): Promise<void> {
  await sql`delete from managed_account_removal where connected_account_id = ${connectedAccountId}`;
}

/** A failure's fixed code: `composio_<kind>_<status>`, never anything Composio wrote. */
const failureCode = (error: unknown) =>
  error instanceof ComposioFault ? error.message : 'removal_failed';

/**
 * For the policy service's `beforeKeyChange`: disconnecting a connection
 * signed in through Composio revokes and removes its Composio account, unless
 * another live connection still acts for it. It never refuses the
 * disconnection: when Composio cannot be reached, the account is queued and
 * tried again until it is gone.
 */
export function managedRevocation(sql: Sql, client: ComposioClient) {
  return async (connection: { id: string }, change: 'revoke' | 'switch') => {
    if (change !== 'revoke') return;
    const [row] = await sql`select configuration from connection where id = ${connection.id}`;
    const configuration = row?.configuration as Record<string, unknown> | undefined;
    const accountId = configuration?.connected_account_id;
    if (configuration?.via !== 'composio' || typeof accountId !== 'string') return;
    if (await managedAccountInUse(sql, accountId, connection.id)) return;
    try {
      await client.removeAccount(accountId);
    } catch (error) {
      process.stderr.write(
        `connections: a Composio account was not removed yet (${failureCode(error)})\n`,
      );
      await queueManagedRemoval(sql, [accountId]);
    }
  };
}

/** How long a run holds the accounts it took before another run may try them. */
const CLAIM_MS = 5 * 60_000;
const FIRST_RETRY_MS = 30_000;
const MAX_RETRY_MS = 60 * 60_000;
const BATCH = 20;

/**
 * One pass over the queue: every account due by `at` is removed at Composio,
 * or set aside if a live connection acts for it. A failure is tried again
 * later, waiting twice as long each time up to an hour. Several runs, in one
 * process or several, each take different accounts.
 */
export async function sweepManagedRemovals(
  sql: Sql,
  client: ComposioClient,
  at: number = Date.now(),
): Promise<{ removed: string[]; kept: string[]; failed: string[] }> {
  const taken = await sql<{ connected_account_id: string; attempts: number }[]>`
    update managed_account_removal r
      set next_attempt_at = ${new Date(at + CLAIM_MS).toISOString()}::timestamptz, attempts = r.attempts + 1
      where r.connected_account_id in (
        select connected_account_id from managed_account_removal
          where next_attempt_at <= ${new Date(at).toISOString()}::timestamptz
          order by next_attempt_at limit ${BATCH}
          for update skip locked)
      returning r.connected_account_id, r.attempts`;
  const result = { removed: [] as string[], kept: [] as string[], failed: [] as string[] };
  for (const { connected_account_id: id, attempts } of taken) {
    if (await managedAccountInUse(sql, id)) {
      await settleManagedRemoval(sql, id);
      result.kept.push(id);
      continue;
    }
    try {
      await client.removeAccount(id);
      await settleManagedRemoval(sql, id);
      result.removed.push(id);
    } catch (error) {
      const wait = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(attempts - 1, 16));
      await sql`update managed_account_removal
        set next_attempt_at = ${new Date(at + wait).toISOString()}::timestamptz, last_error = ${failureCode(error)}
        where connected_account_id = ${id}`;
      result.failed.push(id);
    }
  }
  return result;
}

/** Sweeps the queue every `intervalMs` until stopped. */
export function startManagedRemovalSweep(
  sql: Sql,
  client: ComposioClient,
  intervalMs = 60_000,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void sweepManagedRemovals(sql, client)
      .then(({ failed }) => {
        if (failed.length)
          process.stderr.write(
            `connections: ${failed.length} Composio account(s) not removed yet; trying again later\n`,
          );
      })
      .catch(() => process.stderr.write('connections: the Composio removal queue was not read\n'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
