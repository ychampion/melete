/**
 * Every job a person owns carries a learning scope, whether or not the caller
 * supplied one. Without this, anything created through the conversation lands
 * on the unclassified sentinel and is filtered out of proposal and delivery, so
 * corrections made in the place people actually work could never teach anything.
 *
 * The derived scope is deterministic: one family for everything general, and a
 * template id that is a digest of the normalised objective. Applicability
 * inside the family is decided by trigger matching at delivery, not by a
 * per-objective family, because the promotion gate needs at least two held-out
 * templates from the same family before it will believe an improvement.
 */
import { createHash } from 'node:crypto';
import { normalizeForMatch, RESERVED_TASK_FAMILIES } from '@melete/contracts';
import type { JobLearningScope } from './contracts.ts';

export { RESERVED_TASK_FAMILIES };
export const GENERAL_FAMILY = 'general';
/** Pinned, and bumped only by a reviewed commit: the runtime version is rechecked at delivery. */
export const GENERAL_APP_VERSION = '1.0';
export const GENERAL_APP = 'melete';

/**
 * Stable across whitespace, case and punctuation, so the same request phrased
 * twice is one template and a second run of it is held-out history rather than
 * a new family of one.
 */
export const objectiveTemplate = (objective: string) =>
  `obj.${createHash('sha256').update(normalizeForMatch(objective), 'utf8').digest('hex').slice(0, 32)}`;

export const derivedScope = (objective: string): JobLearningScope => ({
  scope: {
    task_family: GENERAL_FAMILY,
    app: GENERAL_APP,
    app_version: GENERAL_APP_VERSION,
    role: 'owner',
    audience: 'private',
  },
  template_id: objectiveTemplate(objective),
  input_refs: [],
});
