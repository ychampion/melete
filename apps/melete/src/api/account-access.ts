/**
 * Everything that reaches an account without its password, and the one way to
 * end all of it: browser sessions, sign-in and reset links, connected
 * assistants' tokens and their unused codes, paired computers and their
 * pairing codes, browsers that receive notifications, and linked chat
 * accounts. A password change, a reset, "Sign out everywhere else" and an
 * operator disabling the account all end access through `endAccess`, so none
 * of them can forget a kind.
 */
import { createHash } from 'node:crypto';
import { accountAccess } from '@melete/contracts';
import type { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Sql, TransactionSql } from 'postgres';
import { ServiceError } from './errors.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * What a session is called in the person's list, and in requests to end it.
 * Derived from the stored digest, so the list never carries the digest itself.
 */
export const sessionId = (tokenHash: string) => digest(`session:${tokenHash}`).slice(0, 24);

/** A name a person recognises: the browser and the system, from the User-Agent. */
export function sessionLabel(userAgent: string | undefined | null): string {
  const agent = userAgent ?? '';
  const system = /iPhone/.test(agent)
    ? 'iPhone'
    : /iPad/.test(agent)
      ? 'iPad'
      : /Android/.test(agent)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(agent)
          ? 'Mac'
          : /Windows/.test(agent)
            ? 'Windows'
            : /CrOS/.test(agent)
              ? 'ChromeOS'
              : /Linux/.test(agent)
                ? 'Linux'
                : null;
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Firefox\//.test(agent)
      ? 'Firefox'
      : /Chrome\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : /^curl\//.test(agent)
            ? 'curl'
            : null;
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? 'A browser';
}

/**
 * Ends every way into the account except the browser session named by `keep`
 * (a session digest), inside the caller's transaction. Returns the paired
 * computers it disconnected, so the caller can also close their connections
 * once the transaction has committed.
 */
export async function endAccess(
  tx: TransactionSql,
  principalId: string,
  keep: string | null,
): Promise<string[]> {
  await tx`delete from session where coalesce(principal_id, owner_id) = ${principalId}
    and token_hash is distinct from ${keep}`;
  await tx`update magic_link set used_at = now()
    where coalesce(principal_id, owner_id) = ${principalId} and used_at is null`;
  await tx`update password_reset set used_at = now()
    where principal_id = ${principalId} and used_at is null`;
  await tx`update mcp_token set revoked_at = now()
    where principal_id = ${principalId} and revoked_at is null`;
  // A code handed out in the last few minutes would otherwise still buy new tokens.
  await tx`update mcp_authorization set used_at = now()
    where principal_id = ${principalId} and used_at is null`;
  // Chat platform accounts linked to the person stop speaking as them.
  await tx`delete from principal_identity where principal_id = ${principalId}`;
  // Browsers that receive the account's notifications, which carry chat titles.
  await tx`delete from push_subscription where principal_id = ${principalId}`;
  // Codes for pairing a computer that were never used, then the computers paired.
  await tx`update device_pairing set used_at = now()
    where principal_id = ${principalId} and used_at is null`;
  const devices = await tx<{ id: string }[]>`update paired_device set revoked_at = now()
    where paired_by = ${principalId} and revoked_at is null returning id`;
  return devices.map((row) => String(row.id));
}

/** How long ended and expired rows are kept before the sweep removes them. */
const KEEP_ENDED = '1 day';

/**
 * Removes sessions, links and codes that can no longer be used. Each is
 * already refused once it expires; this keeps the tables from growing for ever.
 */
export async function purgeExpiredAccess(sql: Sql): Promise<number> {
  let removed = 0;
  const count = (rows: { count: number }) => {
    removed += rows.count;
  };
  count(await sql`delete from session where expires_at < now()`);
  count(
    await sql`delete from magic_link
      where expires_at < now() - ${KEEP_ENDED}::interval or used_at < now() - ${KEEP_ENDED}::interval`,
  );
  count(
    await sql`delete from password_reset
      where expires_at < now() - ${KEEP_ENDED}::interval or used_at < now() - ${KEEP_ENDED}::interval`,
  );
  count(
    await sql`delete from mcp_authorization
      where expires_at < now() - ${KEEP_ENDED}::interval or used_at < now() - ${KEEP_ENDED}::interval`,
  );
  count(
    await sql`delete from device_pairing
      where device_id is null and expires_at < now() - ${KEEP_ENDED}::interval`,
  );
  // An expired setup code still says the installation wants one, so it stays
  // until the installation has its owner.
  count(
    await sql`delete from setup_code where exists (select 1 from owner)
      and (expires_at < now() or used_at is not null)`,
  );
  return removed;
}

export const ACCESS_SWEEP_MS = 6 * 60 * 60_000;

/** Purges now and then every few hours, on the one instance holding the lease. */
export function startAccessSweep(
  sql: Sql,
  leads: () => Promise<boolean> = async () => true,
  everyMs = ACCESS_SWEEP_MS,
) {
  const sweep = () => {
    void leads()
      .then((leading) => (leading ? purgeExpiredAccess(sql) : undefined))
      .catch((error: unknown) =>
        process.stderr.write(
          `expired sign-in sweep failed: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      );
  };
  sweep();
  const timer = setInterval(sweep, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Where the account is signed in, with a way to end each browser session or
 * all but this one. Paired computers and notification browsers are listed
 * here too; each is ended from its own route (`/devices/{id}/revoke`,
 * `/push/subscriptions/{id}`) as well as by "Sign out everywhere else".
 */
export function mountAccountAccess(
  app: Hono,
  deps: {
    sql: Sql;
    sessionCookie: string;
    /** Closes the connections of computers `endAccess` disconnected, after it committed. */
    devicesEnded?: (principalId: string, deviceIds: string[]) => Promise<void>;
  },
) {
  const { sql } = deps;
  const current = (cookie: string | undefined) => (cookie ? digest(cookie) : null);

  app.get('/account/sessions', async (c) => {
    const principalId = c.get('owner').id;
    const here = current(getCookie(c, deps.sessionCookie));
    const [sessions, computers, notifications, assistants] = await Promise.all([
      sql`select token_hash, label, created_at, expires_at from session
        where coalesce(principal_id, owner_id) = ${principalId} and expires_at > now()
        order by created_at desc limit 200`,
      sql`select id, name, paired_at from paired_device
        where paired_by = ${principalId} and revoked_at is null order by paired_at desc limit 200`,
      sql`select id, device_label, created_at from push_subscription
        where principal_id = ${principalId} order by created_at desc limit 200`,
      sql`select coalesce(c.name, t.client_id) as client, min(t.created_at) as connected_at,
          max(t.expires_at) as expires_at
        from mcp_token t left join mcp_client c on c.id = t.client_id
        where t.principal_id = ${principalId} and t.revoked_at is null and t.expires_at > now()
        group by t.family, coalesce(c.name, t.client_id) order by connected_at desc limit 200`,
    ]);
    const iso = (value: unknown) => new Date(String(value)).toISOString();
    return c.json(
      accountAccess.parse({
        sessions: sessions.map((row) => ({
          id: sessionId(String(row.token_hash)),
          label: row.label ? String(row.label) : 'A browser',
          created_at: iso(row.created_at),
          expires_at: iso(row.expires_at),
          current: row.token_hash === here,
        })),
        computers: computers.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          paired_at: iso(row.paired_at),
        })),
        notifications: notifications.map((row) => ({
          id: String(row.id),
          label: String(row.device_label) || 'A browser',
          created_at: iso(row.created_at),
        })),
        assistants: assistants.map((row) => ({
          client: String(row.client).slice(0, 200),
          connected_at: iso(row.connected_at),
          expires_at: iso(row.expires_at),
        })),
      }),
    );
  });

  app.delete('/account/sessions/:id', async (c) => {
    const principalId = c.get('owner').id;
    const rows = await sql`select token_hash from session
      where coalesce(principal_id, owner_id) = ${principalId}`;
    const match = rows.find((row) => sessionId(String(row.token_hash)) === c.req.param('id'));
    if (!match) throw new ServiceError('not_found', 'That session has already ended.', 404);
    await sql`delete from session where token_hash = ${match.token_hash}`;
    return c.json({ status: 'ok' as const });
  });

  app.post('/account/sessions/revoke-others', async (c) => {
    const principalId = c.get('owner').id;
    const keep = current(getCookie(c, deps.sessionCookie));
    const devices = await sql.begin((tx) => endAccess(tx, principalId, keep));
    await deps.devicesEnded?.(principalId, devices);
    return c.json({ status: 'ok' as const });
  });
}
