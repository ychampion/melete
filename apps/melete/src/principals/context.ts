import { basename, dirname, join } from 'node:path';
import { type KnowledgeExcerpt, normalizeAudience, type SkillPayload } from '@melete/contracts';
import { loadSpace, spacePaths } from '@melete/knowledge';
import { chooseSkills, loadSkills } from '@melete/skills';
import type { Transaction } from '../db/transaction.ts';
import { overlapsProcedure, type ProcedureReach } from '../learning/triggers.ts';
import { spaceAuthority } from './authority.ts';

/** A file's audience can narrow membership; it can never grant membership. */
export function audienceVisible(audience: string | undefined, spaceId: string, isOwner: boolean) {
  if (audience === undefined || audience === 'private') return isOwner;
  try {
    return ['space', 'public'].includes(normalizeAudience(audience, spaceId).audience);
  } catch {
    return false;
  }
}

/**
 * At most three skills for the objective and latest message, from those the
 * principal may read. `offered` says whether the attempt could use a skill
 * naming these tools; one it cannot is never chosen, so it takes no place.
 */
export async function selectedSkills(
  tx: Transaction,
  spaceId: string,
  principalId: string | null,
  objective: string,
  latestMessage: string,
  publicCompartment = false,
  offered: (tools: readonly string[]) => boolean = () => true,
  /** What a delivered learned procedure covers; a built-in covering the same work gives way to it. */
  beside?: ProcedureReach,
): Promise<SkillPayload[]> {
  const access = await spaceAuthority(tx, spaceId, principalId, true);
  const loaded = loadSkills(
    publicCompartment ? {} : { spaceSkillsDirectory: join(access.space.gitPath, 'skills') },
  );
  const eligible = loaded.skills.filter(
    (skill) =>
      (skill.source === 'builtin' ||
        audienceVisible(skill.frontmatter.audience, spaceId, access.role === 'owner')) &&
      offered(skill.frontmatter.tools) &&
      !(
        skill.source === 'builtin' &&
        beside &&
        overlapsProcedure(skill.frontmatter.triggers, beside)
      ),
  );
  return chooseSkills(objective, latestMessage, eligible, 3).map(({ skill }) => ({
    name: skill.frontmatter.name,
    body: skill.body,
    ...(skill.source === 'space' ? { space_id: spaceId } : {}),
  }));
}

/** No cross-space scan: the selected space is checked before its bytes are opened. */
export async function selectedContext(
  tx: Transaction,
  spaceId: string,
  principalId: string | null,
  objective: string,
  latestMessage: string,
  publicCompartment = false,
  beside?: ProcedureReach,
): Promise<{ skills: SkillPayload[]; knowledge: KnowledgeExcerpt[] }> {
  const skills = await selectedSkills(
    tx,
    spaceId,
    principalId,
    objective,
    latestMessage,
    publicCompartment,
    undefined,
    beside,
  );
  const access = await spaceAuthority(tx, spaceId, principalId, true);
  if (publicCompartment) return { skills, knowledge: [] };
  const paths = spacePaths(dirname(access.space.gitPath), basename(access.space.gitPath));
  // Bounded excerpts use only active published records. Candidate evaluation belongs to the learning loop.
  const records = loadSpace(paths).records.filter(
    (record) =>
      !('memory_revision' in record.frontmatter) &&
      record.frontmatter.space === paths.space &&
      record.frontmatter.status === 'active' &&
      audienceVisible(record.frontmatter.audience, spaceId, access.role === 'owner'),
  );
  const knowledge = records.slice(0, 12).map((record) => ({
    path: record.path,
    excerpt: record.body.slice(0, 1000),
    key: null,
    origin_trust: 'inferred' as const,
    disputed: false,
    provenance: {
      id: record.frontmatter.id,
      asserted_by: record.frontmatter.asserted_by,
      observed_at: record.frontmatter.observed_at,
      status: record.frontmatter.status,
    },
  }));
  return { skills, knowledge };
}
