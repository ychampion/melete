/**
 * `bun run reset-password <email>`: prints a one-time link that sets a new
 * password for that account. For the person who runs the install, on the
 * host, when someone has forgotten their password and no mailbox can send the
 * link. The link works once, expires within the hour, and choosing a password
 * with it signs that account out everywhere.
 */
import type { Sql } from 'postgres';
import { issuePasswordReset, principalByEmail, RESET_MINUTES, resetUrl } from '../api/password.ts';

export type ResetPrint =
  | { ok: true; email: string; link: string | null; code: string; minutes: number }
  | { ok: false; message: string };

export async function operatorReset(
  sql: Sql,
  email: string,
  publicUrl: string | undefined,
): Promise<ResetPrint> {
  const account = await principalByEmail(sql, email.trim());
  if (!account) return { ok: false, message: `No account signs in as ${email.trim()}.` };
  const issued = await sql.begin((tx) => issuePasswordReset(tx, account.id, 'operator'));
  return {
    ok: true,
    email: account.email,
    link: publicUrl ? resetUrl(publicUrl, issued.token) : null,
    code: issued.token,
    minutes: RESET_MINUTES.operator,
  };
}

export function describeReset(result: ResetPrint): string {
  if (!result.ok) return `${result.message}\n`;
  const open = result.link
    ? `Open this link to choose a new password for ${result.email}:\n\n  ${result.link}\n`
    : `No public address is set (MELETE_PUBLIC_URL), so there is no link to print.\nOn the Melete sign-in page, choose “Forgot your password?” and paste this code:\n\n  ${result.code}\n`;
  return `${open}\nIt works once and expires in ${result.minutes} minutes. Choosing a new password signs ${result.email} out everywhere.\n`;
}

if (import.meta.main) {
  const email = process.argv[2];
  if (!email?.includes('@')) {
    process.stderr.write('Usage: bun run reset-password <email>\n');
    process.exit(2);
  }
  const { openDatabase } = await import('../db/client.ts');
  const { withFileSettings } = await import('../env.ts');
  // In the service's container the address is a file the database's setup step wrote.
  const url = withFileSettings(process.env).DATABASE_URL;
  if (!url) {
    process.stderr.write('Set DATABASE_URL to the database this Melete uses.\n');
    process.exit(2);
  }
  const handle = openDatabase(url, 1);
  try {
    const result = await operatorReset(
      handle.sql,
      email,
      process.env.MELETE_PUBLIC_URL?.trim() || undefined,
    );
    (result.ok ? process.stdout : process.stderr).write(describeReset(result));
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    await handle.close();
  }
}
