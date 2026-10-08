/**
 * The Composio accounts Melete's connections act for, and taking one away
 * when the last connection that acts for it is disconnected. One Composio
 * account may stand behind more than one connection only while a transport
 * switch is settling, so an account is removed only once no live connection
 * names it.
 */
import type { Sql } from 'postgres';
import type { ComposioClient } from './composio.ts';

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
 * For the policy service's `beforeKeyChange`: disconnecting a connection
 * signed in through Composio revokes and removes its Composio account, unless
 * another live connection still acts for it. It never refuses the
 * disconnection: a failure is noted by its code alone, and the connection is
 * revoked here all the same.
 */
export function managedRevocation(sql: Sql, client: ComposioClient) {
  return async (connection: { id: string }, change: 'revoke' | 'switch') => {
    if (change !== 'revoke') return;
    const [row] = await sql`select configuration from connection where id = ${connection.id}`;
    const configuration = row?.configuration as Record<string, unknown> | undefined;
    const accountId = configuration?.connected_account_id;
    if (configuration?.via !== 'composio' || typeof accountId !== 'string') return;
    if (await managedAccountInUse(sql, accountId, connection.id)) return;
    await client.removeAccount(accountId).catch((error: unknown) => {
      process.stderr.write(
        `connections: a Composio account was not removed (${error instanceof Error ? error.message : 'error'})\n`,
      );
    });
  };
}
