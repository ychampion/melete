/**
 * Loading skills and choosing which ones an attempt sees.
 *
 * Two sources: the skills that ship with the release, and the ones a person has
 * put in their space. A space skill with the same name as a built-in replaces
 * it, because the person's version of how they like something done is the
 * authority on how they like it done.
 *
 * Choosing never calls a model. Anything that decides what the model reads must
 * not itself depend on model judgment, or injected text gets a say in which
 * instructions arrive with it.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILT_IN_SKILLS,
  type Skill,
  type SkillFrontmatter,
  type SkillMatch,
  selectSkills,
  skillFrontmatter,
} from '@melete/contracts';
import matter from 'gray-matter';
import { estimateTokens, IDENTITY_MAX_TOKENS } from './tokens.ts';

export type SkillSource = 'builtin' | 'space';

export type LoadedSkill = Skill & {
  source: SkillSource;
  /** The estimated cost of the whole file, which is what an attempt pays. */
  tokens: number;
};

export type SkillFailure = {
  path: string;
  issues: string[];
};

export type LoadedSkills = {
  skills: LoadedSkill[];
  failures: SkillFailure[];
};

/** Where the skills that ship with the release live. */
export const builtInDirectory = (): string =>
  fileURLToPath(new URL('../builtin/', import.meta.url));

export const identityPath = (): string => join(builtInDirectory(), 'identity.md');

export type ParsedSkill =
  | { ok: true; frontmatter: SkillFrontmatter; body: string; tokens: number }
  | { ok: false; issues: string[] };

/**
 * Parse one skill file. A skill longer than its own declared cap is refused:
 * the budget is part of the contract, not a suggestion, and a skill that has
 * grown into a document should be split.
 */
export function parseSkill(source: string): ParsedSkill {
  if (
    !source
      .replace(/^\uFEFF/, '')
      .trimStart()
      .startsWith('---')
  ) {
    return { ok: false, issues: ['the file has no frontmatter block'] };
  }

  let data: unknown;
  let content: string;
  try {
    const parsed = matter(source);
    data = parsed.data;
    content = parsed.content;
  } catch (error) {
    return { ok: false, issues: [`frontmatter is not valid YAML: ${String(error)}`] };
  }

  const validated = skillFrontmatter.safeParse(data);
  if (!validated.success) {
    return {
      ok: false,
      issues: validated.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    };
  }

  const tokens = estimateTokens(source);
  if (tokens > validated.data.max_tokens) {
    return {
      ok: false,
      issues: [`the skill is about ${tokens} tokens; its own cap is ${validated.data.max_tokens}`],
    };
  }

  return { ok: true, frontmatter: validated.data, body: content.trim(), tokens };
}

const readSkillFiles = (directory: string): string[] => {
  if (!existsSync(directory)) return [];
  if (lstatSync(directory).isSymbolicLink()) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const full = join(directory, entry);
    const stats = lstatSync(full);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      const nested = join(full, 'SKILL.md');
      if (existsSync(nested) && !lstatSync(nested).isSymbolicLink()) files.push(nested);
      continue;
    }
    // identity.md is not a skill: it loads on every attempt, not on a trigger.
    if (entry.endsWith('.md') && entry !== 'identity.md') files.push(full);
  }
  return files;
};

function loadFrom(directory: string, source: SkillSource): LoadedSkills {
  const skills: LoadedSkill[] = [];
  const failures: SkillFailure[] = [];

  for (const path of readSkillFiles(directory)) {
    const parsed = parseSkill(readFileSync(path, 'utf8'));
    if (!parsed.ok) {
      failures.push({ path, issues: parsed.issues });
      continue;
    }
    skills.push({
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      path,
      source,
      tokens: parsed.tokens,
    });
  }
  return { skills, failures };
}

/** The skills that ship with the release, in the order the contract names them. */
export function loadBuiltInSkills(): LoadedSkills {
  const loaded = loadFrom(builtInDirectory(), 'builtin');
  const order = new Map(BUILT_IN_SKILLS.map((name, index) => [name as string, index]));
  loaded.skills.sort(
    (a, b) =>
      (order.get(a.frontmatter.name) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.frontmatter.name) ?? Number.MAX_SAFE_INTEGER) ||
      a.frontmatter.name.localeCompare(b.frontmatter.name),
  );
  return loaded;
}

/** The skills a person has added to one space. */
export const loadSpaceSkills = (skillsDirectory: string): LoadedSkills =>
  loadFrom(skillsDirectory, 'space');

export type LoadOptions = {
  /** A space's `skills/` directory, when the caller is working in one. */
  spaceSkillsDirectory?: string;
};

/**
 * Everything an attempt could load, built-ins first so the order is stable, with
 * a space's own version of a skill replacing the built-in of the same name.
 */
export function loadSkills(options: LoadOptions = {}): LoadedSkills {
  const builtIn = loadBuiltInSkills();
  if (!options.spaceSkillsDirectory) return builtIn;

  const fromSpace = loadSpaceSkills(options.spaceSkillsDirectory);
  const skills = [...builtIn.skills];
  for (const skill of fromSpace.skills) {
    const at = skills.findIndex((s) => s.frontmatter.name === skill.frontmatter.name);
    if (at === -1) skills.push(skill);
    else skills[at] = skill;
  }
  return { skills, failures: [...builtIn.failures, ...fromSpace.failures] };
}

/** Who Melete is. Short by contract, because it loads on every attempt. */
export function loadIdentity(): string {
  const text = readFileSync(identityPath(), 'utf8').trim();
  const tokens = estimateTokens(text);
  if (tokens > IDENTITY_MAX_TOKENS) {
    throw new Error(
      `the identity file is about ${tokens} tokens; the cap is ${IDENTITY_MAX_TOKENS}`,
    );
  }
  return text;
}

/**
 * Pick the skills for one attempt. A thin wrapper over the contract's matcher,
 * so the service and the tests agree on what selection means.
 */
export const chooseSkills = (
  objective: string,
  latestMessage: string,
  skills: readonly LoadedSkill[],
  max = 3,
): SkillMatch<LoadedSkill>[] => selectSkills(objective, latestMessage, skills, max);

/** The chosen skills as they reach the model: a heading and the instructions. */
export const renderSkills = (matches: readonly SkillMatch<LoadedSkill>[]): string =>
  matches.map((m) => `## ${m.skill.frontmatter.name}\n\n${m.skill.body}`).join('\n\n');

/** How one index line reads to the model: the name to pass to `skills.read`, and what it is for. */
export const indexLine = (entry: { name: string; description: string }): string =>
  `- ${entry.name}: ${entry.description}`;

/**
 * The skills an attempt may read but was not given in full, by name and one
 * line, within `budget` estimated tokens. Those whose triggers the request
 * matches come first, so a tight budget keeps the likeliest; the rest follow in
 * the order they were supplied. Nothing is dropped silently: whatever does not
 * fit is left to tool search, which reads the same skills.
 */
export function indexSkills(
  objective: string,
  latestMessage: string,
  skills: readonly LoadedSkill[],
  budget: number,
): { name: string; description: string }[] {
  const ranked = selectSkills(objective, latestMessage, skills, skills.length).map(
    (match) => match.skill,
  );
  const ordered = [...ranked, ...skills.filter((skill) => !ranked.includes(skill))];
  const index: { name: string; description: string }[] = [];
  let used = 0;
  for (const skill of ordered) {
    const entry = { name: skill.frontmatter.name, description: skill.frontmatter.description };
    const cost = estimateTokens(`${indexLine(entry)}\n`);
    if (used + cost > budget) continue;
    used += cost;
    index.push(entry);
  }
  return index;
}
