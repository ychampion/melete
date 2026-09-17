import { ID_PREFIXES, type ToolSpec } from '@melete/contracts';
import type { Query } from './records.ts';

/**
 * Carry out an action the owner already approved, by its id and nothing else.
 *
 * The caller supplies no payload, so there are no bytes for a model to get
 * wrong: the broker admits and dispatches the canonical payload it stored when
 * the owner read it, through the same admission path a proposal takes. Offered
 * only while such an action exists for the job's current revision.
 */
export const RESUME_ACTION_TOOL: ToolSpec = {
  name: 'resume_action',
  description:
    'Carry out an action the owner already approved, exactly as approved. Pass its action_id; the stored payload is sent, so do not propose the tool again.',
  effect_class: 'write_external',
  connection_id: null,
  input_schema: {
    type: 'object',
    properties: {
      action_id: {
        type: 'string',
        pattern: `^${ID_PREFIXES.action}_`,
        description: 'The approved action, as named under "A decision was made".',
      },
    },
    required: ['action_id'],
    additionalProperties: false,
  },
};

/**
 * Approved for this revision, unexpired and not yet admitted: the only state
 * resume exists for. Admission still decides; this only chooses what to offer.
 */
export async function hasResumableAction(
  tx: Query,
  job: { id: string; revision: number },
): Promise<boolean> {
  const [row] = await tx`select 1 as present from action a
    join approval p on p.action_id = a.id and p.payload_hash = a.payload_hash
    where a.job_id = ${job.id} and a.status = 'approved' and p.decision = 'approved'
      and p.job_revision = ${job.revision}
      and (p.expires_at is null or p.expires_at > now()) limit 1`;
  return Boolean(row);
}
