/**
 * The operator's account commands, run in the service's container by
 * `bun run melete account …` (packages/cli/src/commands/account.ts):
 *
 *   list                   every account: email, kind, created, disabled, sessions
 *   create <email>         a new account with no password, and a link to choose one;
 *                          the installation's owner when it has none yet
 *   reset <email>          a one-time link that sets a new password
 *   disable <email>        stops the account signing in and ends all its access
 *   enable <email>         lets a disabled account sign in again
 *   setup-code             a new one-time code for creating the first account
 *
 * `--web-url <url>` is the address links open at when MELETE_PUBLIC_URL is not
 * set; `--json` prints one JSON object instead of sentences. Exit codes: 0
 * done, 1 refused (an unknown account, an owner that already exists), 2 usage.
 */
import type { Sql } from 'postgres';
import { endAccess } from '../api/account-access.ts';
import { issuePasswordReset, principalByEmail, RESET_MINUTES, resetUrl } from '../api/password.ts';
import { issueSetupCode, SETUP_CODE_HOURS, setupLink } from '../api/setup-code.ts';
import { newId } from '../ids.ts';
import { describeReset, operatorReset } from './reset-password.ts';

export const ACCOUNT_USAGE = `Usage: bun run melete account <command> [--json]
  list                 Every account: email, kind, created, disabled, live sessions
  create <email>       A new account and a link to choose its password (the owner, on a new installation)
  reset <email>        A one-time link that sets a new password and signs the account out everywhere
  disable <email>      Stop the account signing in, and end its sessions, devices and connected apps
  enable <email>       Let a disabled account sign in again
  setup-code           A new one-time code for creating the first account
`;

export type AccountOutcome = { ok: boolean; text: string; json: Record<string, unknown> };

const refused = (message: string): AccountOutcome => ({
  ok: false,
  text: `${message}\n`,
  json: { ok: false, message },
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function listAccounts(sql: Sql): Promise<AccountOutcome> {
  const rows = await sql`select p.id, p.email, p.kind, p.created_at, p.disabled_at,
      p.password_hash is not null as has_password,
      exists (select 1 from owner o where o.id = p.id) as is_owner,
      (select count(*)::int from session s where coalesce(s.principal_id, s.owner_id) = p.id
        and s.expires_at > now()) as sessions,
      (select max(s.created_at) from session s where coalesce(s.principal_id, s.owner_id) = p.id)
        as last_sign_in
    from principal p where p.kind in ('person', 'guest') order by p.created_at, p.id`;
  const accounts = rows.map((row) => ({
    email: String(row.email),
    kind: row.is_owner ? 'owner' : String(row.kind),
    created_at: new Date(String(row.created_at)).toISOString(),
    disabled: row.disabled_at !== null,
    has_password: Boolean(row.has_password),
    sessions: Number(row.sessions),
    last_sign_in: row.last_sign_in ? new Date(String(row.last_sign_in)).toISOString() : null,
  }));
  const text = accounts.length
    ? `${accounts
        .map(
          (a) =>
            `${a.email}  ${a.kind}${a.disabled ? ' (disabled)' : ''}${a.has_password ? '' : ' (no password yet)'}  created ${a.created_at.slice(0, 10)}  ${a.sessions} signed in${a.last_sign_in ? `, last ${a.last_sign_in.slice(0, 16).replace('T', ' ')}` : ''}`,
        )
        .join('\n')}\n`
    : 'There are no accounts yet. Create the first with: bun run melete account create <email>\n';
  return { ok: true, text, json: { ok: true, accounts } };
}

/** How long the link a new account gets lasts: long enough to reach the person. */
export const INVITE_MINUTES = RESET_MINUTES.invite;

export async function createAccount(
  sql: Sql,
  email: string,
  webUrl: string | undefined,
): Promise<AccountOutcome> {
  const address = email.trim().toLowerCase();
  if (!EMAIL.test(address)) return refused(`${email} is not an email address.`);
  const made = await sql.begin(async (tx) => {
    const [taken] = await tx`select 1 from principal where email = ${address}`;
    if (taken) return null;
    const [installed] = await tx`select id from owner limit 1 for update`;
    const id = newId('own');
    // The first account is the installation's owner; its personal space is
    // made, and furnished, when it first signs in.
    if (!installed) await tx`insert into owner (id, email) values (${id}, ${address})`;
    await tx`insert into principal (id, email) values (${id}, ${address})`;
    // Setup is done once the owner exists: codes issued for it are spent.
    if (!installed) await tx`update setup_code set used_at = now() where used_at is null`;
    const issued = await issuePasswordReset(tx, id, 'invite');
    return { owner: !installed, token: issued.token };
  });
  if (!made) return refused(`An account already signs in as ${address}.`);
  const link = webUrl ? resetUrl(webUrl, made.token) : null;
  const days = INVITE_MINUTES / 1440;
  const role = made.owner ? 'the owner of this installation' : 'a new account';
  const open = link
    ? `Send ${address} this link to choose a password:\n\n  ${link}\n`
    : `No web address is known, so there is no link. On the sign-in page, choose “Forgot your password?” and enter this code:\n\n  ${made.token}\n`;
  return {
    ok: true,
    text: `Created ${address} as ${role}.\n${open}\nIt works once and expires in ${days} days.\n`,
    json: { ok: true, email: address, owner: made.owner, link, code: made.token, days },
  };
}

export async function resetAccount(
  sql: Sql,
  email: string,
  webUrl: string | undefined,
): Promise<AccountOutcome> {
  const result = await operatorReset(sql, email, webUrl);
  return {
    ok: result.ok,
    text: describeReset(result),
    json: result.ok
      ? {
          ok: true,
          email: result.email,
          link: result.link,
          code: result.code,
          minutes: result.minutes,
        }
      : { ok: false, message: result.message },
  };
}

export async function setDisabled(
  sql: Sql,
  email: string,
  disabled: boolean,
): Promise<AccountOutcome> {
  const account = await principalByEmail(sql, email.trim());
  if (!account) return refused(`No account signs in as ${email.trim()}.`);
  if (!disabled) {
    await sql`update principal set disabled_at = null where id = ${account.id}`;
    return {
      ok: true,
      text: `${account.email} can sign in again.\n`,
      json: { ok: true, email: account.email, disabled: false },
    };
  }
  const devices = await sql.begin(async (tx) => {
    await tx`update principal set disabled_at = coalesce(disabled_at, now()) where id = ${account.id}`;
    const ended = await endAccess(tx, account.id, null);
    // The computers' connections close as a revoke from Settings closes them
    // when no policy service is at hand: the generation moves on, so nothing
    // still holding the old one acts.
    if (ended.length)
      await tx`update connection set status = 'revoked', generation = generation + 1
        where id in (select connection_id from paired_device where id = any(${ended}))
        and status <> 'revoked'`;
    return ended;
  });
  const [owner] = await sql`select 1 from owner where id = ${account.id}`;
  const note = owner
    ? ' It is the installation’s owner, so nobody can change its settings until it is enabled again.'
    : '';
  return {
    ok: true,
    text: `${account.email} is disabled: it cannot sign in, and its sessions, ${devices.length} paired computer(s), connected apps and notifications have ended. Its routines and data are kept.${note}\nUndo with: bun run melete account enable ${account.email}\n`,
    json: { ok: true, email: account.email, disabled: true, computers: devices.length },
  };
}

export async function newSetupCodeFor(
  sql: Sql,
  webUrl: string | undefined,
): Promise<AccountOutcome> {
  const issued = await issueSetupCode(sql);
  if (!issued)
    return refused(
      'This installation already has its owner, so it needs no setup code. To let someone in, use: bun run melete account create <email>',
    );
  const link = webUrl ? setupLink(webUrl, issued.code) : null;
  return {
    ok: true,
    text: `${link ? `Open this link to create the first account:\n\n  ${link}\n\nOr enter the code` : 'On the web page, enter the setup code'}:\n\n  ${issued.code}\n\nIt works once and expires in ${SETUP_CODE_HOURS} hours. Earlier setup codes no longer work.\n`,
    json: { ok: true, code: issued.code, link, expires_at: issued.expiresAt.toISOString() },
  };
}

export function parseAccountArgs(argv: readonly string[]) {
  const args: string[] = [];
  let json = false;
  let webUrl: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--json') json = true;
    else if (arg === '--web-url') {
      webUrl = argv[index + 1] || undefined;
      index += 1;
    } else args.push(arg);
  }
  return { command: args[0] ?? '', target: args[1], extra: args.slice(2), json, webUrl };
}

export async function runAccount(
  sql: Sql,
  argv: readonly string[],
  publicUrl: string | undefined,
): Promise<{ code: number; out: string }> {
  const parsed = parseAccountArgs(argv);
  const webUrl = publicUrl ?? parsed.webUrl;
  const needsEmail = ['create', 'reset', 'disable', 'enable'].includes(parsed.command);
  const usage = { code: 2, out: ACCOUNT_USAGE };
  if (parsed.extra.length) return usage;
  if (needsEmail && !parsed.target?.includes('@')) return usage;
  if (!needsEmail && parsed.target !== undefined) return usage;
  let outcome: AccountOutcome;
  switch (parsed.command) {
    case 'list':
      outcome = await listAccounts(sql);
      break;
    case 'create':
      outcome = await createAccount(sql, parsed.target ?? '', webUrl);
      break;
    case 'reset':
      outcome = await resetAccount(sql, parsed.target ?? '', webUrl);
      break;
    case 'disable':
    case 'enable':
      outcome = await setDisabled(sql, parsed.target ?? '', parsed.command === 'disable');
      break;
    case 'setup-code':
      outcome = await newSetupCodeFor(sql, webUrl);
      break;
    default:
      return usage;
  }
  return {
    code: outcome.ok ? 0 : 1,
    out: parsed.json ? `${JSON.stringify(outcome.json)}\n` : outcome.text,
  };
}

if (import.meta.main) {
  const { openDatabase } = await import('../db/client.ts');
  const { withFileSettings } = await import('../env.ts');
  const settings = withFileSettings(process.env);
  const url = settings.DATABASE_URL;
  if (!url) {
    process.stderr.write('Set DATABASE_URL to the database this Melete uses.\n');
    process.exit(2);
  }
  const handle = openDatabase(url, 1);
  try {
    const result = await runAccount(
      handle.sql,
      process.argv.slice(2),
      process.env.MELETE_PUBLIC_URL?.trim() || undefined,
    );
    (result.code === 0 ? process.stdout : process.stderr).write(result.out);
    process.exitCode = result.code;
  } finally {
    await handle.close();
  }
}
