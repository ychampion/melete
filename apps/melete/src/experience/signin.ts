import { createHash, randomBytes } from 'node:crypto';
import { unavailable } from '@melete/contracts';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { issuePasswordReset, RESET_MINUTES, resetUrl } from '../api/password.ts';
import { EmailConnector } from '../connectors/email.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Sign-in mail has a dedicated connector entry point and never enters a model-visible ledger. */
export class ExperienceSignIn {
  constructor(
    readonly sql: Sql,
    readonly registry: ConnectorRegistry,
    readonly publicUrl?: string,
  ) {}
  /**
   * The owner's own connected mailbox, the only one account mail leaves from,
   * or the plain reason there is none.
   */
  private async ownMailbox() {
    const url = this.publicUrl;
    if (!url)
      return { ok: false, reason: 'Set your public address before using email sign-in.' } as const;
    const [owner] = await this.sql`select id, email from owner order by created_at limit 1`;
    if (!owner)
      return {
        ok: false,
        reason: 'Set up your personal account before using email sign-in.',
      } as const;
    // The link signs the setup owner into their own personal space, never the oldest one around.
    const [space] = await this.sql`select id from space where kind = 'personal'
      and coalesce(owner_principal_id, ${owner.id}) = ${owner.id} order by created_at, id limit 1`;
    if (!space) return { ok: false, reason: 'Your personal space is not ready yet.' } as const;
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
      return { ok: false, reason: 'Connect your own mailbox to use email sign-in.' } as const;
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
   * Mails a one-time password reset link to the owner from their own mailbox.
   * Without one, the answer says so; an unrelated address gets the same
   * accepted answer as the owner's, and no mail.
   */
  async requestPasswordReset(email: string) {
    const mailbox = await this.ownMailbox();
    if (!mailbox.ok)
      return unavailable(
        'This Melete cannot send you email yet. Ask the person who runs it to print you a reset link.',
      );
    const { owner, space, connector } = mailbox;
    if (String(owner.email).toLowerCase() !== email.toLowerCase()) return { status: 'ok' as const };
    const issued = await this.sql.begin(async (tx) => {
      await tx`select id from owner where id = ${owner.id} for update`;
      const [count] = await tx`select count(*)::int as n, max(created_at) as latest
        from password_reset where principal_id = ${owner.id} and via = 'email'
        and created_at > now() - interval '1 hour'`;
      if (
        Number(count?.n ?? 0) >= 3 ||
        (count?.latest && Date.parse(String(count.latest)) > Date.now() - 60000)
      )
        return null;
      return issuePasswordReset(tx, String(owner.id), 'email');
    });
    if (issued) {
      try {
        await connector.sendPasswordResetLink(
          String(space.id),
          String(owner.email),
          resetUrl(mailbox.url, issued.token),
          RESET_MINUTES.email,
        );
      } catch {
        await this.sql`update password_reset set used_at = now()
          where principal_id = ${owner.id} and used_at is null`;
      }
    }
    return { status: 'ok' as const };
  }

  async request(email: string) {
    const mailbox = await this.ownMailbox();
    if (!mailbox.ok) return unavailable(mailbox.reason);
    const { owner, space } = mailbox;
    const selected = { row: mailbox.row, connector: mailbox.connector };
    // Availability is global; an unrelated address receives the same accepted response without mail.
    if (String(owner.email).toLowerCase() !== email.toLowerCase()) return { status: 'ok' as const };
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hash(token);
    const saved = await this.sql.begin(async (tx) => {
      await tx`select id from owner where id = ${owner.id} for update`;
      const [count] =
        await tx`select count(*)::int as n, max(created_at) as latest from magic_link where owner_id = ${owner.id} and created_at > now() - interval '1 hour'`;
      if (
        Number(count?.n ?? 0) >= 5 ||
        (count?.latest && Date.parse(String(count.latest)) > Date.now() - 60000)
      )
        return false;
      await tx`insert into magic_link (token_hash, owner_id, space_id, connection_id, connection_generation, expires_at)
        values (${tokenHash}, ${owner.id}, ${space.id}, ${selected.row.id}, ${selected.row.generation}, now() + interval '10 minutes')`;
      return true;
    });
    if (saved) {
      const url = new URL('/signin', mailbox.url);
      url.hash = new URLSearchParams({ token }).toString();
      try {
        await selected.connector.sendSignInLink(String(space.id), String(owner.email), url.href);
      } catch {
        await this.sql`update magic_link set used_at = now() where token_hash = ${tokenHash}`;
        return { status: 'ok' as const };
      }
    }
    return { status: 'ok' as const };
  }

  async consume(
    token: string,
    createSession: (
      ownerId: string,
      spaceId: string,
    ) => {
      token: string;
      row: { tokenHash: string; ownerId: string; expiresAt: Date; spaceId?: string };
    },
  ) {
    return this.sql.begin(async (tx) => {
      const [link] =
        await tx`select m.* from magic_link m join connection c on c.id = m.connection_id
        where token_hash = ${hash(token)} and used_at is null and expires_at > now()
        and c.status = 'active' and c.space_id = m.space_id and c.generation = m.connection_generation for update of m`;
      if (!link)
        throw new ServiceError(
          'invalid_signin_link',
          'This sign-in link has expired or was already used.',
          400,
        );
      const authenticated = createSession(String(link.owner_id), String(link.space_id));
      await tx`update magic_link set used_at = now() where token_hash = ${hash(token)}`;
      await tx`insert into session (token_hash, owner_id, space_id, expires_at) values
        (${authenticated.row.tokenHash}, ${authenticated.row.ownerId}, ${link.space_id}, ${authenticated.row.expiresAt.toISOString()})`;
      return authenticated.token;
    });
  }
}
