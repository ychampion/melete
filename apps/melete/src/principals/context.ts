import { basename, dirname, join } from 'node:path';
import { type KnowledgeExcerpt, normalizeAudience, type SkillPayload } from '@melete/contracts';
import { loadSpace, spacePaths } from '@melete/knowledge';
import { chooseSkills, loadSkills } from '@melete/skills';
import type { Transaction } from '../db/transaction.ts';
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

/** No cross-space scan: the selected space is checked before its bytes are opened. */
export async function selectedContext(
  tx: Transaction,
  spaceId: string,
  principalId: string | null,
  objective: string,
  latestMessage: string,
  publicCompartment = false,
  pinned: { required?: readonly string[]; selectionText?: string } = {},
): Promise<{ skills: SkillPayload[]; knowledge: KnowledgeExcerpt[] }> {
  const access = await spaceAuthority(tx, spaceId, principalId, true);
  const loaded = loadSkills(
    publicCompartment ? {} : { spaceSkillsDirectory: join(access.space.gitPath, 'skills') },
  );
  const eligible = loaded.skills.filter(
    (skill) =>
      skill.source === 'builtin' ||
      audienceVisible(skill.frontmatter.audience, spaceId, access.role === 'owner'),
  );
  const payload = (skill: (typeof eligible)[number]): SkillPayload => ({
    name: skill.frontmatter.name,
    body: skill.body,
    ...(skill.source === 'space' ? { space_id: spaceId } : {}),
  });
  // A job that already knows which procedure applies names it, and that naming
  // is not up for a vote. Pinned skills take their places first; matching fills
  // whatever room is left, and reads only what the job says it may read.
  const required = (pinned.required ?? []).flatMap((name) => {
    const found = eligible.find((skill) => skill.frontmatter.name === name);
    return found ? [payload(found)] : [];
  });
  const matched = chooseSkills(pinned.selectionText ?? objective, latestMessage, eligible, 3).map(
    ({ skill }) => payload(skill),
  );
  const seen = new Set<string>();
  const skills: SkillPayload[] = [];
  for (const entry of [...required, ...matched]) {
    if (seen.has(entry.name) || skills.length >= 3) continue;
    seen.add(entry.name);
    skills.push(entry);
  }
  if (publicCompartment) return { skills, knowledge: [] };
  const paths = spacePaths(dirname(access.space.gitPath), basename(access.space.gitPath));
  // Bounded excerpts use only active published records. Candidate evaluation belongs to W11.
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
