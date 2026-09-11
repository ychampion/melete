import { createHash, randomBytes } from 'node:crypto';
import { unavailable } from '@melete/contracts';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
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
  async request(email: string) {
    if (!this.publicUrl) return unavailable('Set your public address before using email sign-in.');
    const [owner] = await this.sql`select id, email from owner order by created_at limit 1`;
    if (!owner) return unavailable('Set up your personal account before using email sign-in.');
    const [space] = await this
      .sql`select id from space where kind = 'personal' order by created_at, id limit 1`;
    if (!space) return unavailable('Your personal space is not ready yet.');
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
      return unavailable('Connect your own mailbox to use email sign-in.');
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
      const url = new URL('/signin', this.publicUrl);
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
