/**
 * Whether a job's declared artifacts hold.
 *
 * Only the newest row per (area, path) is asked. An earlier version of a file
 * that failed its totals check is history, not an open failure: the fix is a
 * new write, the new write is a new artifact row with its own results, and the
 * job completes on the strength of the file that exists now.
 *
 * Advisory results never count. A critique that says the prose is flabby is
 * recorded and shown; it does not stand between a person and their deliverable.
 */
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { artifact, artifactValidation } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { type ArtifactRoots, defaultArtifactRoots, readArtifactContent } from './content.ts';

export type ArtifactGate = {
  passed: boolean;
  /** One readable sentence per failing or still-pending check, newest file first. */
  failures: string[];
};

export type ArtifactReader = Pick<Database | Transaction, 'select'>;

/** The newest declared artifact for each path this job wrote. */
export async function latestArtifacts(tx: ArtifactReader, jobId: string) {
  const rows = await tx
    .select({
      id: artifact.id,
      spaceId: artifact.spaceId,
      area: artifact.area,
      path: artifact.path,
      kind: artifact.kind,
      contentHash: artifact.contentHash,
      createdAt: artifact.createdAt,
    })
    .from(artifact)
    .where(and(eq(artifact.jobId, jobId), isNotNull(artifact.expectation)))
    .orderBy(asc(artifact.area), asc(artifact.path), desc(artifact.createdAt), desc(artifact.id));
  const newest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = `${row.area}\u0000${row.path}`;
    if (!newest.has(key)) newest.set(key, row);
  }
  return [...newest.values()];
}

export async function artifactGate(
  tx: ArtifactReader,
  jobId: string,
  roots: ArtifactRoots = defaultArtifactRoots(),
): Promise<ArtifactGate> {
  const artifacts = await latestArtifacts(tx, jobId);
  if (artifacts.length === 0) return { passed: true, failures: [] };
  const results = await tx
    .select({
      artifactId: artifactValidation.artifactId,
      name: artifactValidation.name,
      status: artifactValidation.status,
      detail: artifactValidation.detail,
      advisory: artifactValidation.advisory,
      validatedContentHash: artifactValidation.validatedContentHash,
    })
    .from(artifactValidation)
    .where(
      inArray(
        artifactValidation.artifactId,
        artifacts.map((row) => row.id),
      ),
    )
    .orderBy(asc(artifactValidation.artifactId), asc(artifactValidation.name));
  const paths = new Map(artifacts.map((row) => [row.id, row.path]));
  const failures: string[] = [];
  const hashes = new Map(artifacts.map((row) => [row.id, row.contentHash]));
  for (const row of artifacts) {
    try {
      const current = await readArtifactContent(roots, { ...row, jobId });
      if (current.hash !== row.contentHash)
        failures.push(`${row.path}: content changed since validation; write and check it again`);
    } catch {
      failures.push(`${row.path}: current content is unavailable for validation`);
    }
  }
  for (const result of results) {
    if (result.advisory) continue;
    if (result.validatedContentHash !== hashes.get(result.artifactId)) {
      failures.push(
        `${paths.get(result.artifactId)}: ${result.name} has no validation for the current digest`,
      );
      continue;
    }
    // `unavailable` is not a pass. A required validator that could not run has
    // established nothing, and a job that completes on it completes on a check
    // nobody made.
    if (result.status === 'passed') continue;
    const what =
      result.status === 'pending'
        ? 'is still waiting'
        : result.status === 'unavailable'
          ? 'could not run'
          : 'failed';
    failures.push(
      `${paths.get(result.artifactId)}: ${result.name} ${what}${
        result.detail ? ` (${result.detail})` : ''
      }`,
    );
  }
  return { passed: failures.length === 0, failures };
}
