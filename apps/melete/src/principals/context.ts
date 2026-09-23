import { basename, dirname, join } from 'node:path';
import { type KnowledgeExcerpt, normalizeAudience, type SkillPayload } from '@melete/contracts';
import { loadSpace, spacePaths } from '@melete/knowledge';
import { chooseSkills, type LoadedSkill, loadSkills } from '@melete/skills';
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
 * Every skill this attempt may read: built-ins, and the space's own skills the
 * principal's audience admits, that the attempt could use. `offered` says
 * whether it could use a skill naming these tools. A built-in covering the
 * same work as a delivered learned procedure gives way to it.
 */
export async function usableSkills(
  tx: Transaction,
  spaceId: string,
  principalId: string | null,
  publicCompartment = false,
  offered: (tools: readonly string[]) => boolean = () => true,
  beside?: ProcedureReach,
): Promise<LoadedSkill[]> {
  const access = await spaceAuthority(tx, spaceId, principalId, true);
  const loaded = loadSkills(
    publicCompartment ? {} : { spaceSkillsDirectory: join(access.space.gitPath, 'skills') },
  );
  return loaded.skills.filter(
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
}

/** A skill as an attempt is given it in full. */
export const skillPayloadOf = (skill: LoadedSkill, spaceId: string): SkillPayload => ({
  name: skill.frontmatter.name,
  body: skill.body,
  ...(skill.source === 'space' ? { space_id: spaceId } : {}),
});

/** At most three skills for the objective and latest message, from the usable ones. */
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
  const eligible = await usableSkills(tx, spaceId, principalId, publicCompartment, offered, beside);
  return chooseSkills(objective, latestMessage, eligible, 3).map(({ skill }) =>
    skillPayloadOf(skill, spaceId),
  );
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
