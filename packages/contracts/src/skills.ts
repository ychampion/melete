/**
 * Skills are short Markdown files with a trigger list. Selection is a
 * deterministic string match, not a model call: the harness has to work with a
 * mid-tier model, so nothing that decides what the model sees may itself
 * depend on model judgment.
 */
import { z } from 'zod';
import { qualifiedAudience } from './principals.ts';

export const skillFrontmatter = z.object({
  audience: qualifiedAudience.optional(),
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase kebab-case'),
  description: z.string().min(1).max(300),
  /** Phrases matched against the objective and the latest user message. */
  triggers: z.array(z.string().min(1)).min(1),
  /** Tool names this skill expects, for example `email.search`. */
  tools: z.array(z.string()).default([]),
  /** Skills are short by contract; the loader refuses anything longer. */
  max_tokens: z.number().int().positive().max(400).default(400),
});
export type SkillFrontmatter = z.infer<typeof skillFrontmatter>;

export const skill = z.object({
  frontmatter: skillFrontmatter,
  body: z.string(),
  path: z.string().min(1),
});
export type Skill = z.infer<typeof skill>;

export type SkillCandidate = {
  frontmatter: SkillFrontmatter;
  body?: string;
  path?: string;
};

export type SkillMatch<T extends SkillCandidate = SkillCandidate> = {
  skill: T;
  score: number;
  matched: string[];
};

/** Lowercase, collapse whitespace, strip punctuation that splits phrases. */
export const normalizeForMatch = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The latest message is what the person just said, so it counts for more. */
const OBJECTIVE_WEIGHT = 1;
const MESSAGE_WEIGHT = 2;

const countMatches = (haystack: string, needle: string): number => {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
};

/**
 * Pick at most `max` skills for one attempt. Ties break on the order the
 * skills were supplied, so the same inputs always produce the same bundle and
 * a failing attempt can be replayed exactly.
 */
export function selectSkills<T extends SkillCandidate>(
  objective: string,
  latestMessage: string,
  skills: readonly T[],
  max = 3,
): SkillMatch<T>[] {
  if (max <= 0) return [];
  const haystackObjective = normalizeForMatch(objective);
  const haystackMessage = normalizeForMatch(latestMessage);

  const scored: Array<SkillMatch<T> & { order: number }> = [];

  skills.forEach((candidate, order) => {
    let score = 0;
    const matched: string[] = [];
    for (const trigger of candidate.frontmatter.triggers) {
      const needle = normalizeForMatch(trigger);
      const hits =
        countMatches(haystackObjective, needle) * OBJECTIVE_WEIGHT +
        countMatches(haystackMessage, needle) * MESSAGE_WEIGHT;
      if (hits > 0) {
        score += hits;
        matched.push(trigger);
      }
    }
    if (score > 0) scored.push({ skill: candidate, score, matched, order });
  });

  scored.sort((a, b) => b.score - a.score || a.order - b.order);

  return scored.slice(0, max).map(({ skill: s, score, matched }) => ({ skill: s, score, matched }));
}

/** The skills that ship with v0.1. User-added skills live in the space. */
export const BUILT_IN_SKILLS = [
  'plan-a-responsibility',
  'draft-follow-up',
  'organize-documents',
  'research-with-sources',
  'schedule-a-check-in',
  'remember-this',
  /** Offered only where a speech capability is configured. */
  'make-a-podcast',
  /**
   * One playbook per `LAUNCH_PLAYBOOKS` entry, in that order. A ledger item is
   * handled by the job objective naming its playbook, which is what the
   * deterministic matcher above then selects; the names are the same string in
   * both lists on purpose.
   */
  'refund-owed',
  'wrong-charge',
  'cancel-subscription',
  'price-rise',
  'get-quotes',
  'unpaid-invoice',
] as const;
export type BuiltInSkill = (typeof BUILT_IN_SKILLS)[number];
