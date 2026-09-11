import { z } from 'zod';
import { ID_PREFIXES, prefixedId } from './common.ts';

/** Receipt metadata for a generated file; older receipts may lack a retrieval ID. */
export const artifactReceiptDetail = z.object({
  kind: z.literal('artifact'),
  path: z.string().min(1),
  mime: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  artifact_id: prefixedId(ID_PREFIXES.artifact).optional(),
});

/** One generated artifact per synthesis action, including after reconciliation. */
export function artifactIdForAction(actionId: string): string {
  prefixedId(ID_PREFIXES.action).parse(actionId);
  return `${ID_PREFIXES.artifact}_${actionId.slice(ID_PREFIXES.action.length + 1)}`;
}
