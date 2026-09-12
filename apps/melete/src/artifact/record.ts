/**
 * Turning a receipt into an artifact record, and reading those records back
 * when a job wants to say it is finished.
 *
 * The rule the rest of the system leans on: a write that declared an
 * expectation produces exactly one artifact row per set of bytes, and every
 * validation result hangs off that row. Re-writing the same path makes a new
 * row with its own results. Nothing is ever edited in place, so the record of
 * what was wrong survives the fix, and "fix the file and the job completes"
 * works without anyone rewriting history.
 */
import {
  type ArtifactExpectation,
  type ArtifactValidation,
  artifactExpectation,
  artifactValidationsHold,
  type JsonObject,
  type PendingArtifactValidation,
  type PublishReceipt,
  pendingArtifactValidation,
  publishReceipt,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { BrokerFault } from '../broker/errors.ts';
import { type Query, recordId } from '../broker/records.ts';
import { type ArtifactRoots, defaultArtifactRoots, readArtifactContent } from './content.ts';
import { validateArtifact } from './validate.ts';

export type ArtifactCritique = {
  status: 'passed' | 'failed' | 'unavailable';
  detail: string;
  evidence?: JsonObject;
};

/**
 * A model reading the artifact and saying something about it. Advisory by
 * construction: whatever it answers, it cannot stop a job. Left unset in v0.1,
 * in which case the critique a write asked for is recorded as `unavailable`
 * rather than quietly dropped.
 */
export type ArtifactCritic = (input: {
  job_id: string;
  path: string;
  kind: string;
  prompt: string;
  content_hash: string;
}) => Promise<ArtifactCritique>;

type ReceiptLike = { detail: Record<string, unknown>; action_id: string };

/** What a files.write receipt carries when the write declared an expectation. */
type DeclaredArtifact = {
  area: string;
  path: string;
  kind: string;
  mime: string;
  size: number;
  content_hash: string;
  template: string | null;
  evidence: string[];
};

function declaredFrom(receipt: ReceiptLike): {
  artifact: DeclaredArtifact;
  expectation: ArtifactExpectation;
  validations: PendingArtifactValidation[];
} | null {
  const detail = receipt.detail as Record<string, unknown>;
  if (!detail || typeof detail !== 'object' || !detail.artifact || !detail.expectation) return null;
  const artifact = detail.artifact as DeclaredArtifact;
  if (typeof artifact.path !== 'string' || typeof artifact.content_hash !== 'string') return null;
  const expectation = artifactExpectation.parse(detail.expectation);
  const validations = Array.isArray(detail.validations)
    ? detail.validations.map((entry) => pendingArtifactValidation.parse(entry))
    : [];
  return { artifact, expectation, validations };
}

/**
 * Persist the artifact a receipt declares, with its validations. Called from
 * inside the broker's receipt transaction, so either all of it lands or none
 * of it does.
 */
export async function recordArtifactFromReceipt(
  tx: Query,
  input: {
    job: { id: string; space_id: string };
    action: { id: string; kind: string };
    receipt: ReceiptLike;
  },
  critic?: ArtifactCritic,
): Promise<string | null> {
  const declared = declaredFrom(input.receipt);
  if (!declared) return null;
  const { artifact, expectation, validations } = declared;
  const names = new Set<string>();
  for (const result of validations) {
    if (names.has(result.name))
      throw new BrokerFault('payload_invalid', `Duplicate validation name: ${result.name}`);
    names.add(result.name);
  }
  const id = recordId('art');
  await tx`insert into artifact
    (id, space_id, job_id, source_job_id, area, path, kind, content_hash, mime, size,
     template, expectation, evidence)
    values (${id}, ${input.job.space_id}, ${input.job.id}, ${input.job.id},
      ${artifact.area}, ${artifact.path}, ${artifact.kind}, ${artifact.content_hash},
      ${artifact.mime}, ${artifact.size}, ${artifact.template},
      ${JSON.stringify(expectation)}::jsonb,
      ${JSON.stringify(artifact.evidence ?? [])}::jsonb)`;
  const resolved: PendingArtifactValidation[] = [];
  for (const result of validations) {
    // A critique is the one result this side can still resolve: it is a model
    // call, so it could not happen in the connector, and it is advisory, so
    // failing to obtain one is not a failure of the artifact.
    if (result.class === 'critique' && result.status === 'pending') {
      const review: ArtifactCritique = critic
        ? await critic({
            job_id: input.job.id,
            path: artifact.path,
            kind: artifact.kind,
            prompt: result.detail,
            content_hash: artifact.content_hash,
          }).catch(
            (error: Error): ArtifactCritique => ({
              status: 'unavailable',
              detail: `the critique could not be obtained: ${error.message}`,
            }),
          )
        : { status: 'unavailable', detail: 'no model critic is configured in this release' };
      resolved.push({
        ...result,
        status: review.status,
        detail: review.detail,
        evidence: review.evidence ?? {},
        advisory: true,
      });
      continue;
    }
    resolved.push(result);
  }
  for (const result of resolved) {
    await tx`insert into artifact_validation
      (artifact_id, class, name, status, detail, evidence, advisory, checked_at, validated_content_hash)
      values (${id}, ${result.class}, ${result.name}, ${result.status}, ${result.detail},
        ${JSON.stringify(result.evidence)}::jsonb, ${result.advisory}, ${result.checked_at}, ${result.validated_content_hash ?? artifact.content_hash})`;
  }
  return id;
}

/** Persist where a published artifact went. One row per publish action. */
export async function recordPublication(
  tx: Query,
  artifactId: string,
  entry: PublishReceipt,
): Promise<void> {
  const parsed = publishReceipt.parse(entry);
  await tx`insert into artifact_publication
    (artifact_id, action_id, destination, external_ref, content_hash, detail, published_at)
    values (${artifactId}, ${parsed.action_id}, ${parsed.destination}, ${parsed.external_ref},
      ${parsed.content_hash}, ${JSON.stringify(parsed.detail)}::jsonb, ${parsed.published_at})
    on conflict (action_id) do nothing`;
}

/**
 * The one hook the broker calls when it persists a successful receipt. Two
 * shapes reach it: a write that declared an artifact, and a publish that says
 * where an artifact went. Anything else passes through untouched.
 */
export function createArtifactRecorder(
  critic?: ArtifactCritic,
  roots: ArtifactRoots = defaultArtifactRoots(),
) {
  return async (
    tx: Query,
    input: {
      job: { id: string; space_id: string };
      action: { id: string; kind: string };
      receipt: ReceiptLike;
    },
  ): Promise<void> => {
    await recordArtifactFromReceipt(tx, input, critic);
    // A write without expect and an in-cell execution can both change an
    // existing deliverable. Preserve its declaration and its historical rows,
    // then record a fresh set of checks for the changed bytes.
    if (['files.write', 'files.move', 'exec.run', 'exec.python'].includes(input.action.kind)) {
      const rows = await tx`select distinct on (area, path) * from artifact
        where job_id = ${input.job.id} and space_id = ${input.job.space_id} and expectation is not null
        order by area, path, created_at desc, id desc`;
      for (const row of rows) {
        const content = await readArtifactContent(roots, {
          jobId: input.job.id,
          spaceId: input.job.space_id,
          area: row.area,
          path: row.path,
        }).catch(() => null);
        // Missing/unreadable files fail the live gate; no fabricated validation.
        if (!content || content.hash === row.content_hash) continue;
        const expectation = artifactExpectation.parse(row.expectation);
        await recordArtifactFromReceipt(
          tx,
          {
            ...input,
            receipt: {
              action_id: input.action.id,
              detail: {
                artifact: { ...row, content_hash: content.hash, size: content.bytes.byteLength },
                expectation,
                validations: validateArtifact(expectation, content.bytes),
              },
            },
          },
          critic,
        );
      }
    }
    const detail = input.receipt.detail as Record<string, unknown>;
    const publication = detail?.publication;
    const artifactId = detail?.artifact_id;
    if (publication && typeof artifactId === 'string') {
      await recordPublication(tx, artifactId, publishReceipt.parse(publication));
    }
  };
}

/**
 * The owner's own answer. It replaces the pending row a declared `human`
 * expectation left behind, which is what lets the job move.
 */
export async function acceptArtifact(
  sql: Sql,
  input: { artifact_id: string; decision: 'accepted' | 'rejected'; note?: string },
): Promise<ArtifactValidation> {
  const [artifact] = await sql`select content_hash from artifact where id = ${input.artifact_id}`;
  if (!artifact) throw new Error('artifact is unavailable');
  const [row] = await sql`insert into artifact_validation
    (artifact_id, class, name, status, detail, evidence, advisory, checked_at, validated_content_hash)
    values (${input.artifact_id}, 'human', 'human',
      ${input.decision === 'accepted' ? 'passed' : 'failed'},
      ${input.note ?? (input.decision === 'accepted' ? 'accepted by the owner' : 'rejected by the owner')},
      ${JSON.stringify({ decision: input.decision })}::jsonb, false, now(), ${artifact.content_hash})
    on conflict (artifact_id, name) do update set status = excluded.status,
      detail = excluded.detail, evidence = excluded.evidence, checked_at = excluded.checked_at,
      validated_content_hash = excluded.validated_content_hash
    returning *`;
  if (!row) throw new Error('the acceptance was not recorded');
  return {
    artifact_id: row.artifact_id,
    class: 'human',
    name: 'human',
    status: row.status,
    detail: row.detail,
    evidence: row.evidence,
    advisory: false,
    checked_at: new Date(row.checked_at).toISOString(),
    validated_content_hash: row.validated_content_hash,
  };
}

export { artifactValidationsHold };
