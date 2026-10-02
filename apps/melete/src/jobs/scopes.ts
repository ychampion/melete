import { and, eq, sql } from 'drizzle-orm';
import type { Query } from '../broker/records.ts';
import { connection } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';

/** What decides which connections a job may act through, read from durable rows. */
export type JobConnectionAudience = {
  /** The space's kind: every connection in a personal space serves its owner's jobs. */
  kind: string;
  /** The space's owner; a space that predates principals belongs to the setup owner. */
  spaceOwnerId: string | null;
  /** The job's principal; a job that predates principals belongs to the setup owner. */
  principalId: string | null;
};

/**
 * The rule for using a connection. In a personal space every connection serves
 * the space's jobs, as it always has. In a shared space a connection marked
 * `owner` serves only the space owner's own jobs, so a member's job acts through
 * none of the connections the owner installed there. A connection marked `room`
 * is for work the room asks for, which no job does yet, so it serves none here.
 */
export function connectionServesJob(audience: JobConnectionAudience, sharedUse: string): boolean {
  if (audience.kind !== 'shared') return true;
  return (
    sharedUse === 'owner' &&
    audience.principalId !== null &&
    audience.principalId === audience.spaceOwnerId
  );
}

const audienceQuery = (jobId: string) => sql`select s.kind,
    coalesce(s.owner_principal_id, (select id from owner limit 1)) as space_owner_id,
    coalesce(j.principal_id, (select id from owner limit 1)) as principal_id
  from job j join space s on s.id = j.space_id where j.id = ${jobId}`;

type AudienceRow = { kind: string; space_owner_id: string | null; principal_id: string | null };
const fromRow = (row: AudienceRow | undefined): JobConnectionAudience | null =>
  row ? { kind: row.kind, spaceOwnerId: row.space_owner_id, principalId: row.principal_id } : null;

/** The audience for a job, for code that holds a raw SQL connection (the broker). */
export async function jobConnectionAudience(
  query: Query,
  jobId: string,
): Promise<JobConnectionAudience | null> {
  const [row] = await query<AudienceRow[]>`select s.kind,
      coalesce(s.owner_principal_id, (select id from owner limit 1)) as space_owner_id,
      coalesce(j.principal_id, (select id from owner limit 1)) as principal_id
    from job j join space s on s.id = j.space_id where j.id = ${jobId}`;
  return fromRow(row);
}

/**
 * The scopes the active connections a job may use grant it. A job no longer
 * found is granted nothing.
 */
export async function connectionScopesForJob(
  tx: Transaction,
  row: { id: string; spaceId: string },
): Promise<string[]> {
  const [found] = (await tx.execute(audienceQuery(row.id))) as unknown as AudienceRow[];
  const audience = fromRow(found);
  if (!audience) return [];
  const granted = await tx
    .select({ scopes: connection.scopes, sharedUse: connection.sharedUse })
    .from(connection)
    .where(and(eq(connection.spaceId, row.spaceId), eq(connection.status, 'active')));
  return [
    ...new Set(
      granted
        .filter((entry) => connectionServesJob(audience, entry.sharedUse))
        .flatMap((entry) => entry.scopes),
    ),
  ];
}
