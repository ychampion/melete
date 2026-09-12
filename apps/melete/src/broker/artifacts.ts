import {
  type Action,
  artifactIdForAction,
  artifactReceiptDetail,
  type Receipt,
} from '@melete/contracts';
import type { LockedJob, Query } from './records.ts';

/** Publish the retrieval row in the same transaction as the durable action receipt. */
export async function recordGeneratedArtifact(
  tx: Query,
  job: LockedJob,
  action: Action,
  receipt: Receipt,
): Promise<Receipt> {
  if (action.kind !== 'audio.synthesize') return receipt;
  const detail = artifactReceiptDetail.parse(receipt.detail);
  const id = artifactIdForAction(action.id);
  if (
    receipt.external_ref !== detail.content_hash ||
    (detail.artifact_id && detail.artifact_id !== id) ||
    !/^artifacts\/[A-Za-z0-9][A-Za-z0-9._-]*\.wav$/.test(detail.path) ||
    detail.path.includes('..')
  ) {
    throw new Error('Invalid generated artifact receipt');
  }
  await tx`insert into artifact (id, space_id, job_id, path, content_hash, mime, size, audience)
    values (${id}, ${job.space_id}, ${job.id}, ${detail.path}, ${detail.content_hash}, ${detail.mime}, ${detail.bytes}, 'owner')
    on conflict (id) do nothing`;
  return { ...receipt, detail: { ...receipt.detail, artifact_id: id } };
}
