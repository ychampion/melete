import { createHash, randomBytes } from 'node:crypto';
import { unavailable } from '@melete/contracts';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { issuePasswordReset, RESET_MINUTES, resetUrl } from '../api/password.ts';
import { EmailConnector } from '../connectors/email.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import { type AccountMailer, passwordResetMail, signInMail } from './account-mail.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * What the person signing in is told when no link can be mailed. Setup steps
 * for whoever runs the installation are in its docs, not on the sign-in page.
 */
const NO_SIGN_IN_MAIL = 'This Melete can’t email a sign-in link. Sign in with your password.';

/**
 * The page a sign-in link opens: the sign-in screen, with the token in the
 * fragment's query, where the web's router reads it. The fragment never
 * reaches a server log.
 */
export function signInUrl(publicUrl: string, token: string): string {
  const url = new URL('/', publicUrl);
  url.hash = `/welcome?${new URLSearchParams({ token })}`;
  return url.href;
}

/** An account mail may go to: one that signs in, and that the operator has not disabled. */
async function mailableAccount(sql: Sql, email: string) {
  const [row] = await sql`select id, email from principal
    where email = ${email.toLowerCase()} and kind in ('person', 'guest') and disabled_at is null`;
  return row ? { id: String(row.id), email: String(row.email) } : null;
}

/** Whether another link may go to the account now: a few an hour, and not twice a minute. */
const tooSoon = (count: { n?: unknown; latest?: unknown } | undefined, perHour: number) =>
  Number(count?.n ?? 0) >= perHour ||
  Boolean(count?.latest && Date.parse(String(count.latest)) > Date.now() - 60000);

type SessionMaker = (
  ownerId: string,
  principalId: string,
  spaceId?: string,
) => {
  token: string;
  row: { tokenHash: string; ownerId: string; expiresAt: Date; label?: string };
};

/**
 * Sign-in and password reset mail. It goes out through the installation's own
 * mail sender when the operator configured one, to any account; otherwise from
 * the owner's own connected mailbox, to the owner alone. It never enters a
 * model-visible ledger.
 */
export class ExperienceSignIn {
  constructor(
    readonly sql: Sql,
    readonly registry: ConnectorRegistry,
    readonly publicUrl?: string,
    readonly mailer?: AccountMailer,
  ) {}

  /** Whether account mail can go out at all, for the sign-in page to offer it. */
  async canSend(): Promise<boolean> {
    if (!this.publicUrl) return false;
    if (this.mailer) return true;
    return (await this.ownMailbox()).ok;
  }

  /**
   * The owner's own connected mailbox, the only one account mail leaves from
   * without an installation sender, or the plain reason there is none.
   */
  private async ownMailbox() {
    const url = this.publicUrl;
    if (!url) return { ok: false, reason: NO_SIGN_IN_MAIL } as const;
    const [owner] = await this.sql`select id, email from owner order by created_at limit 1`;
    if (!owner) return { ok: false, reason: NO_SIGN_IN_MAIL } as const;
    // The link signs the setup owner into their own personal space, never the oldest one around.
    const [space] = await this.sql`select id from space where kind = 'personal'
      and coalesce(owner_principal_id, ${owner.id}) = ${owner.id} order by created_at, id limit 1`;
    if (!space) return { ok: false, reason: NO_SIGN_IN_MAIL } as const;
    const active = await this
      .sql`select id, generation from connection where space_id = ${space.id} and status = 'active' and scopes ? 'email.send'`;
    const selected = active
      .map((row) => ({ row, connector: this.registry.get(String(row.id)) }))
      .find(
        (entry) =>
          entry.connector instanceof EmailConnector &&
          entry.connector.canSendSignIn(String(space.id), String(owner.email)),
      );
    if (!selected || !(selected.connector instanceof EmailConnector))
      return { ok: false, reason: NO_SIGN_IN_MAIL } as const;
    return {
      ok: true,
      owner,
      space,
      row: selected.row,
      connector: selected.connector,
      url,
    } as const;
  }

  /**
   * Mails a one-time password reset link. An address with no account gets the
   * same accepted answer and no mail. The link is made and mailed after the
   * answer, so how long the answer takes says nothing about whose address was
   * asked for.
   */
  async requestPasswordReset(email: string) {
    const failed = (error: unknown) => console.error('password reset mail', String(error));
    if (this.mailer && this.publicUrl) {
      const mailer = this.mailer;
      const url = this.publicUrl;
      void mailableAccount(this.sql, email)
        .then((account) => (account ? this.mailReset(account, url, mailer) : undefined))
        .catch(failed);
      return { status: 'ok' as const };
    }
    const mailbox = await this.ownMailbox();
    if (!mailbox.ok)
      return unavailable(
        'This Melete can’t email you a reset link. Ask whoever set up your account to send you one.',
      );
    if (String(mailbox.owner.email).toLowerCase() === email.toLowerCase()) {
      const { owner, space, connector } = mailbox;
      const send = (link: string) =>
        connector.sendPasswordResetLink(
          String(space.id),
          String(owner.email),
          link,
          RESET_MINUTES.email,
        );
      void this.issueReset(String(owner.id), mailbox.url, send).catch(failed);
    }
    return { status: 'ok' as const };
  }

  private mailReset(account: { id: string; email: string }, url: string, mailer: AccountMailer) {
    return this.issueReset(account.id, url, (link) =>
      mailer.send(passwordResetMail(account.email, link, RESET_MINUTES.email)),
    );
  }

  private async issueReset(
    principalId: string,
    url: string,
    send: (link: string) => Promise<void>,
  ) {
    const issued = await this.sql.begin(async (tx) => {
      await tx`select id from principal where id = ${principalId} for update`;
      const [count] = await tx`select count(*)::int as n, max(created_at) as latest
        from password_reset where principal_id = ${principalId} and via = 'email'
        and created_at > now() - interval '1 hour'`;
      if (tooSoon(count, 3)) return null;
      return issuePasswordReset(tx, principalId, 'email');
    });
    if (!issued) return;
    try {
      await send(resetUrl(url, issued.token));
    } catch (error) {
      // Only the link that did not go out stops working.
      await this.sql`update password_reset set used_at = now()
        where token_hash = ${hash(issued.token)} and used_at is null`;
      throw error;
    }
  }

  /**
   * Mails a one-time sign-in link. Availability is global: an address with no
   * account gets the same accepted answer, and no mail.
   */
  async request(email: string) {
    if (this.mailer && this.publicUrl) {
      const mailer = this.mailer;
      const url = this.publicUrl;
      void mailableAccount(this.sql, email)
        .then((account) =>
          account
            ? this.issueLink(account.id, null, url, (link) =>
                mailer.send(signInMail(account.email, link)),
              )
            : undefined,
        )
        .catch((error) => console.error('sign-in mail', String(error)));
      return { status: 'ok' as const };
    }
    const mailbox = await this.ownMailbox();
    if (!mailbox.ok) return unavailable(mailbox.reason);
    const { owner, space, connector, row } = mailbox;
    if (String(owner.email).toLowerCase() !== email.toLowerCase()) return { status: 'ok' as const };
    await this.issueLink(
      String(owner.id),
      {
        spaceId: String(space.id),
        connectionId: String(row.id),
        generation: Number(row.generation),
      },
      mailbox.url,
      (link) => connector.sendSignInLink(String(space.id), String(owner.email), link),
    ).catch((error) => console.error('sign-in mail', String(error)));
    // The same answer whether or not the mail went: the sign-in page says to check the inbox.
    return { status: 'ok' as const };
  }

  /**
   * Saves a link for the account and sends it. A link from the owner's mailbox
   * is bound to that connection; one from the installation's sender names the
   * account instead.
   */
  private async issueLink(
    principalId: string,
    mailbox: { spaceId: string; connectionId: string; generation: number } | null,
    url: string,
    send: (link: string) => Promise<void>,
  ) {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hash(token);
    const saved = await this.sql.begin(async (tx) => {
      const [installation] = await tx`select id from owner limit 1`;
      if (!installation) return false;
      await tx`select id from principal where id = ${principalId} for update`;
      const [count] = await tx`select count(*)::int as n, max(created_at) as latest
        from magic_link where coalesce(principal_id, owner_id) = ${principalId}
        and created_at > now() - interval '1 hour'`;
      if (tooSoon(count, 5)) return false;
      await tx`insert into magic_link (token_hash, owner_id, principal_id, space_id,
          connection_id, connection_generation, expires_at)
        values (${tokenHash}, ${installation.id},
          ${principalId === installation.id ? null : principalId}, ${mailbox?.spaceId ?? null},
          ${mailbox?.connectionId ?? null}, ${mailbox?.generation ?? null},
          now() + interval '10 minutes')`;
      return true;
    });
    if (!saved) return;
    try {
      await send(signInUrl(url, token));
    } catch (error) {
      await this.sql`update magic_link set used_at = now() where token_hash = ${tokenHash}`;
      throw error;
    }
  }

  async consume(token: string, createSession: SessionMaker) {
    return this.sql.begin(async (tx) => {
      // A mailbox link still needs the mailbox that sent it, at the generation
      // it had; a link from the installation's sender needs only its account.
      const [link] = await tx`select m.* from magic_link m
        left join connection c on c.id = m.connection_id
        join principal p on p.id = coalesce(m.principal_id, m.owner_id)
        where m.token_hash = ${hash(token)} and m.used_at is null and m.expires_at > now()
        and p.disabled_at is null
        and (m.connection_id is null or (c.status = 'active' and c.space_id = m.space_id
          and c.generation = m.connection_generation))
        for update of m`;
      if (!link)
        throw new ServiceError(
          'invalid_signin_link',
          'This sign-in link has expired or was already used.',
          400,
        );
      const principalId = String(link.principal_id ?? link.owner_id);
      const spaceId = link.space_id === null ? undefined : String(link.space_id);
      const authenticated = createSession(String(link.owner_id), principalId, spaceId);
      await tx`update magic_link set used_at = now() where token_hash = ${hash(token)}`;
      await tx`insert into session (token_hash, owner_id, principal_id, space_id, expires_at, label)
        values (${authenticated.row.tokenHash}, ${authenticated.row.ownerId}, ${principalId},
          ${spaceId ?? null}, ${authenticated.row.expiresAt.toISOString()},
          ${authenticated.row.label ?? null})`;
      return authenticated.token;
    });
  }
}
