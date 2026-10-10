import { createHash, randomBytes } from 'node:crypto';
import {
  passwordChange,
  passwordResetCheck,
  passwordResetConsume,
  passwordResetRequest,
  unavailable,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Sql, TransactionSql } from 'postgres';
import type { z } from 'zod';
import type { ExperienceSignIn } from '../experience/signin.ts';
import type { LimitStore } from '../ops/limiter.ts';
import { endAccess } from './account-access.ts';
import { ServiceError } from './errors.ts';
import type { RequestSource } from './listener.ts';
import { LoginThrottle } from './login-throttle.ts';
import { requireStrongPassword } from './password-policy.ts';

/**
 * How long a reset link lasts: longer for the operator's command, which someone
 * may carry over, and a week for the link a new account is created with.
 */
export const RESET_MINUTES = { operator: 60, email: 30, invite: 7 * 24 * 60 } as const;
export type ResetVia = keyof typeof RESET_MINUTES;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const hashPassword = (password: string) => Bun.password.hash(password, { algorithm: 'argon2id' });

/**
 * Makes a one-time reset token for an account. An earlier unused token of the
 * same kind stops working, so only the newest link of each kind can set a
 * password. The kinds stay apart so that anyone asking for an email link cannot
 * end a link the operator printed on the host.
 */
export async function issuePasswordReset(
  tx: Sql | TransactionSql,
  principalId: string,
  via: ResetVia,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_MINUTES[via] * 60_000);
  await tx`update password_reset set used_at = now()
    where principal_id = ${principalId} and via = ${via} and used_at is null`;
  await tx`insert into password_reset (token_hash, principal_id, via, expires_at)
    values (${digest(token)}, ${principalId}, ${via}, ${expiresAt.toISOString()})`;
  return { token, expiresAt };
}

/** The page a reset link opens. The token rides in the fragment, which no server log sees. */
export function resetUrl(publicUrl: string, token: string): string {
  const url = new URL('/', publicUrl);
  url.hash = `/reset?${new URLSearchParams({ token })}`;
  return url.href;
}

/**
 * Sets an account's password and ends everything else that reaches it, apart
 * from the browser session named in `keep`: other sessions, sign-in links,
 * connected assistants and their unused codes, paired computers, browsers that
 * receive its notifications, and linked chat accounts. A new password is how
 * someone shuts out whoever else had the account. Returns the computers it
 * disconnected.
 */
async function setPassword(
  tx: TransactionSql,
  principalId: string,
  password: string,
  keep: string | null,
): Promise<string[]> {
  const hash = await hashPassword(password);
  await tx`update principal set password_hash = ${hash} where id = ${principalId}`;
  // The installation's owner row carries the same account; the two never disagree.
  await tx`update owner set password_hash = ${hash} where id = ${principalId}`;
  return endAccess(tx, principalId, keep);
}

/** Operator command and routes share this: an account by its sign-in address. */
export async function principalByEmail(sql: Sql | TransactionSql, email: string) {
  const [row] = await sql`select id, email from principal
    where email = ${email.toLowerCase()} and kind in ('person', 'guest')`;
  return row ? { id: String(row.id), email: String(row.email) } : null;
}

function clientAddress(c: Context): string {
  const source = c.env as RequestSource | undefined;
  return source?.clientAddress ?? source?.remoteAddress ?? 'unknown';
}

function limited(c: Context, retryAfter: number) {
  c.header('Retry-After', String(retryAfter));
  return c.json(
    {
      error: {
        code: 'password_rate_limited',
        message: 'Too many attempts. Try again in a minute.',
      },
    },
    429,
  );
}

/**
 * Change password for a signed-in person, and the way back in for someone who
 * forgot theirs: a one-time link, printed on the host by the operator's
 * command, or mailed by the installation's mail sender or from the owner's own
 * connected mailbox.
 */
export function mountPassword(
  app: Hono,
  deps: {
    sql: Sql;
    sessionCookie: string;
    signIn?: ExperienceSignIn;
    publicUrl?: string;
    clock?: () => number;
    /** Where the limits are counted; left out, in this process. */
    limits?: LimitStore;
    /** Closes the connections of the computers a new password disconnected. */
    devicesEnded?: (principalId: string, deviceIds: string[]) => Promise<void>;
  },
) {
  const { sql } = deps;
  const changes = new LoginThrottle(deps.clock, undefined, deps.limits, 'password.change');
  const requests = new LoginThrottle(deps.clock, undefined, deps.limits, 'password.request');
  const consumes = new LoginThrottle(deps.clock, undefined, deps.limits, 'password.consume');

  app.post('/account/password', async (c) => {
    const principalId = c.get('owner').id;
    const retryAfter = await changes.admit(principalId);
    if (retryAfter > 0) return limited(c, retryAfter);
    const input = passwordChange.parse(await c.req.json());
    requireStrongPassword(input.new_password, c.get('owner').email);
    const [row] = await sql`select password_hash from principal where id = ${principalId}`;
    const hash = row?.password_hash ? String(row.password_hash) : null;
    if (!hash || !(await Bun.password.verify(input.current_password, hash)))
      // Not 401: the session is fine, and a 401 would sign the person out.
      throw new ServiceError('wrong_password', 'Your current password is not right.', 400);
    const token = getCookie(c, deps.sessionCookie);
    const devices = await sql.begin((tx) =>
      setPassword(tx, principalId, input.new_password, token ? digest(token) : null),
    );
    await changes.succeeded(principalId);
    await deps.devicesEnded?.(principalId, devices);
    return c.json({ status: 'ok' as const });
  });

  app.post('/password-reset', async (c) => {
    const retryAfter = await requests.admit(clientAddress(c));
    if (retryAfter > 0) return limited(c, retryAfter);
    const input = passwordResetRequest.parse(await c.req.json());
    if (!deps.signIn || !deps.publicUrl)
      return c.json(
        unavailable(
          'This Melete can’t email you a reset link. Ask whoever set up your account to send you one.',
        ),
      );
    return c.json(await deps.signIn.requestPasswordReset(input.email));
  });

  // Counted with the attempts to use a code, so checking is no faster a way to guess one.
  app.post('/password-reset/check', async (c) => {
    const source = clientAddress(c);
    const retryAfter = await consumes.admit(source);
    if (retryAfter > 0) return limited(c, retryAfter);
    const shaped = passwordResetCheck.safeParse(await c.req.json().catch(() => null));
    const [open] = shaped.success
      ? await sql`select 1 from password_reset r join principal p on p.id = r.principal_id
          where r.token_hash = ${digest(shaped.data.token)} and r.used_at is null
          and r.expires_at > now() and p.disabled_at is null`
      : [];
    if (!open)
      throw new ServiceError(
        'invalid_reset_link',
        'That code isn’t right, or it has expired or been used. Ask for a new one.',
        400,
      );
    return c.json({ status: 'ok' as const });
  });

  app.post('/password-reset/consume', async (c) => {
    const source = clientAddress(c);
    const retryAfter = await consumes.admit(source);
    if (retryAfter > 0) return limited(c, retryAfter);
    const body = await c.req.json();
    const shaped = passwordResetConsume.safeParse(body);
    // A code typed wrong is the same news as one that expired, not a form error.
    const done =
      !shaped.success && shaped.error.issues.some((issue) => issue.path[0] === 'token')
        ? false
        : await consume(passwordResetConsume.parse(body));
    if (done) await deps.devicesEnded?.(done.principalId, done.devices);
    if (!done)
      throw new ServiceError(
        'invalid_reset_link',
        'This reset link has expired or was already used. Ask for a new one.',
        400,
      );
    await consumes.succeeded(source);
    return c.json({ status: 'ok' as const });
  });

  const consume = (input: z.infer<typeof passwordResetConsume>) =>
    sql.begin(async (tx) => {
      const [reset] = await tx`select r.principal_id, p.email from password_reset r
        join principal p on p.id = r.principal_id
        where r.token_hash = ${digest(input.token)} and r.used_at is null and r.expires_at > now()
        for update of r`;
      if (!reset) return null;
      // Checked once the link is known good, so a weak choice does not spend it.
      requireStrongPassword(input.new_password, String(reset.email));
      await tx`update password_reset set used_at = now() where token_hash = ${digest(input.token)}`;
      const principalId = String(reset.principal_id);
      // Once a password is set, no other reset link for the account is left open:
      // ending its access marks every unused one used.
      const devices = await setPassword(tx, principalId, input.new_password, null);
      return { principalId, devices };
    });
}
