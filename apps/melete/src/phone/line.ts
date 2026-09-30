/**
 * A phone line as its connection row holds it.
 *
 * The row keeps what is safe to read back from a dump of the configuration
 * column: the line's settings, the ids ElevenLabs gave its parts, the digest
 * of the line key, and a pointer to the sealed record. The sealed record holds
 * the ElevenLabs API key, the telephony credentials and the webhook secret.
 */
import { phoneConnectionConfig } from '@melete/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { SecretAccess } from '../connectors/secrets.ts';

export const storedPhoneConnection = z.object({
  kind: z.literal('phone'),
  phone: phoneConnectionConfig,
  elevenlabs: z.object({
    agent_id: z.string().min(1),
    phone_number_id: z.string().min(1),
    secret_id: z.string().min(1),
    webhook_id: z.string().min(1),
  }),
  line_key_digest: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * The sealed record, kept here as well as in `secret_ref` because revoking a
   * connection clears that column, and taking the line down still needs the key.
   */
  key_ref: z.string().min(1),
});
export type StoredPhoneConnection = z.infer<typeof storedPhoneConnection>;

export const sealedPhoneCredentials = z.object({
  api_key: z.string().min(1),
  webhook_secret: z.string().min(1),
  twilio_account_sid: z.string().optional(),
  twilio_auth_token: z.string().optional(),
  sip_username: z.string().optional(),
  sip_password: z.string().optional(),
});
export type SealedPhoneCredentials = z.infer<typeof sealedPhoneCredentials>;

export type Line = {
  id: string;
  spaceId: string;
  label: string;
  status: string;
  secretRef: string | null;
  stored: StoredPhoneConnection;
};

/** A phone connection by id, whatever its status, or null when it is not one. */
export async function readLine(sql: Sql, connectionId: string): Promise<Line | null> {
  const [row] = await sql`select id, space_id, label, status, secret_ref, provider, configuration
    from connection where id = ${connectionId}`;
  if (row?.provider !== 'phone') return null;
  const stored = storedPhoneConnection.safeParse(row.configuration);
  if (!stored.success) return null;
  return {
    id: String(row.id),
    spaceId: String(row.space_id),
    label: String(row.label),
    status: String(row.status),
    secretRef: row.secret_ref ? String(row.secret_ref) : null,
    stored: stored.data,
  };
}

/** Borrow the line's sealed credentials for one piece of work. */
export function withLineSecret<T>(
  secrets: SecretAccess,
  line: Pick<Line, 'spaceId' | 'secretRef' | 'stored'>,
  use: (credentials: SealedPhoneCredentials) => Promise<T>,
): Promise<T> {
  return secrets.withSecret(line.secretRef ?? line.stored.key_ref, line.spaceId, (value) =>
    use(sealedPhoneCredentials.parse(JSON.parse(value))),
  );
}

/** The owner of the line's space: the person a call from an allowed number speaks as. */
export async function lineOwner(sql: Sql, spaceId: string): Promise<string | null> {
  const [row] = await sql`select owner_principal_id from space where id = ${spaceId}`;
  return row?.owner_principal_id ? String(row.owner_principal_id) : null;
}
