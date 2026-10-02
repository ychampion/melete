import { and, eq, sql } from 'drizzle-orm';
import type { Query } from '../broker/records.ts';
import { connection, job } from '../db/schema.ts';
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

/** One reading of the rule's inputs, shared by the typed and the raw SQL callers. */
const AUDIENCE_SELECT = `select s.kind,
    coalesce(s.owner_principal_id, (select id from owner limit 1)) as space_owner_id,
    coalesce(j.principal_id, (select id from owner limit 1)) as principal_id
  from job j join space s on s.id = j.space_id`;

type AudienceRow = { kind: string; space_owner_id: string | null; principal_id: string | null };
const fromRow = (row: AudienceRow | undefined): JobConnectionAudience | null =>
  row ? { kind: row.kind, spaceOwnerId: row.space_owner_id, principalId: row.principal_id } : null;

/** The audience for a job, for code that holds a raw SQL connection (the broker). */
export async function jobConnectionAudience(
  query: Query,
  jobId: string,
): Promise<JobConnectionAudience | null> {
  const [row] = (await query.unsafe(`${AUDIENCE_SELECT} where j.id = $1`, [
    jobId,
  ])) as unknown as AudienceRow[];
  return fromRow(row);
}

async function typedAudience(tx: Transaction, jobId: string) {
  const [row] = (await tx.execute(
    sql`${sql.raw(AUDIENCE_SELECT)} where j.id = ${jobId}`,
  )) as unknown as AudienceRow[];
  return fromRow(row);
}

/**
 * Whether a job may use one connection: it is active, in the job's space, and
 * serves the job under the rule above. Events a connection reports reach only
 * the jobs it serves, so a member's job cannot watch what the owner's mailbox
 * receives.
 */
export async function jobMayUseConnection(
  tx: Transaction,
  jobId: string,
  connectionId: string,
): Promise<boolean> {
  const audience = await typedAudience(tx, jobId);
  const [source] = await tx
    .select({
      spaceId: connection.spaceId,
      status: connection.status,
      sharedUse: connection.sharedUse,
    })
    .from(connection)
    .where(eq(connection.id, connectionId));
  const [owner] = await tx.select({ spaceId: job.spaceId }).from(job).where(eq(job.id, jobId));
  return Boolean(
    audience &&
      source &&
      owner &&
      source.spaceId === owner.spaceId &&
      source.status === 'active' &&
      connectionServesJob(audience, source.sharedUse),
  );
}

/**
 * The scopes the active connections a job may use grant it. A job no longer
 * found is granted nothing.
 */
export async function connectionScopesForJob(
  tx: Transaction,
  row: { id: string; spaceId: string },
): Promise<string[]> {
  const audience = await typedAudience(tx, row.id);
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
