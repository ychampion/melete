/**
 * What a skill the engine wrote may contain.
 *
 * The owner-words rule of `admit.ts` cannot apply here: nothing in an
 * engine-written skill quotes the owner, and a skill legitimately holds
 * commands, paths and code, which that rule refuses. So this scan asks a
 * different question. Credential material must never be installed or even
 * stored, so it is refused and only its reason code is kept. A link reaches
 * outside, and the vocabulary of granting permission claims authority no skill
 * has, so either one waits for the owner to read the text. Everything else may
 * go live.
 *
 * Pure, deterministic and linear in the length of the package: the body is data
 * here, never something to evaluate, and nothing in it can change what this
 * decides beyond matching these patterns.
 */
import { CONTEXT_LIMITS } from '@melete/contracts';
import { estimateTokens } from '@melete/skills';
import { authorityScan } from './admit.ts';
import { definitionHash } from './procedure.ts';

export const ENGINE_ORIGIN = 'engine_staged';
export const ENGINE_BASIS = 'engine_live';

/** Lowercase words joined by single hyphens: what a skill directory may be called. */
export const ENGINE_SKILL_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,7}$/;
export const MAX_ENGINE_BODY_BYTES = 64 * 1024;
/**
 * A delivered skill is read on every attempt in its space, so its length is a
 * standing cost rather than a one-off one. The declared per-skill budget is the
 * point at which the owner should read a skill before it is installed; ten times
 * that is more model-authored instruction than belongs in every attempt whoever
 * approves it, so it is refused and the engine can write a shorter one, or two.
 */
export const ENGINE_SKILL_TOKENS = CONTEXT_LIMITS.skill_tokens;
export const MAX_ENGINE_SKILL_TOKENS = ENGINE_SKILL_TOKENS * 10;
export const MAX_ENGINE_NAME_CHARS = 64;
export const MAX_ENGINE_DESCRIPTION_CHARS = 400;
/** Five per attempt, and the database holds the count; this is the same number. */
export const MAX_ENGINE_SKILLS_PER_ATTEMPT = 5;

export type EngineVerdict = 'live' | 'held' | 'rejected';
export type EngineScan = { verdict: EngineVerdict; reason: string | null };

const CREDENTIAL_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['private_key', /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/],
  ['api_key', /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|glpat|xox[abopsr])[-_][A-Za-z0-9_-]{16,}/],
  ['access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['signed_token', /\bey[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  [
    'assigned_secret',
    /(?:password|passwd|secret|token|api[-_ ]?key|access[-_ ]?key|client[-_ ]?secret|authorization)\s*[:=]\s*["']?[^\s"']{8,}/i,
  ],
];

const LINK_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['url', /\bhttps?:\/\/\S/i],
  ['url', /\b(?:www|ftp)\.[a-z0-9-]+\.[a-z]{2,}/i],
  ['url', /\bmailto:\S/i],
  ['address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
];

/**
 * A run long enough and mixed enough to be a secret rather than a word, a path
 * or a digest. The floor is above four bits per character on purpose: a hex
 * digest reaches exactly four and skills cite digests, while a base64 secret
 * draws on a much larger alphabet and goes well past it.
 */
export const ENTROPY_RUN = /[A-Za-z0-9+/=_-]{32,}/g;
export const ENTROPY_BITS = 4.2;

export function runEntropy(run: string): number {
  const counts = new Map<string, number>();
  for (const character of run) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const share = count / run.length;
    bits -= share * Math.log2(share);
  }
  return bits;
}

/** The first credential-shaped thing in the text, named by kind and never quoted. */
export function credentialMaterial(text: string): string | null {
  for (const [kind, pattern] of CREDENTIAL_PATTERNS) if (pattern.test(text)) return kind;
  for (const [run] of text.matchAll(ENTROPY_RUN))
    if (runEntropy(run) >= ENTROPY_BITS) return 'high_entropy';
  return null;
}

export function linkMaterial(text: string): string | null {
  for (const [kind, pattern] of LINK_PATTERNS) if (pattern.test(text)) return kind;
  return null;
}

/**
 * The whole package, name and description included, because a link or a
 * credential is no safer in the description than in the body.
 */
export function scanEngineSkill(skill: {
  name: string;
  description: string;
  body: string;
}): EngineScan {
  const text = `${skill.name}\n${skill.description}\n${skill.body}`;
  const credential = credentialMaterial(text);
  if (credential) return { verdict: 'rejected', reason: `credential_material:${credential}` };
  const tokens = estimateTokens(text);
  if (tokens > MAX_ENGINE_SKILL_TOKENS) return { verdict: 'rejected', reason: 'body_too_long' };
  if (tokens > ENGINE_SKILL_TOKENS) return { verdict: 'held', reason: 'body_over_budget' };
  const authority = authorityScan(text);
  if (authority) return { verdict: 'held', reason: 'authority_language' };
  const link = linkMaterial(text);
  if (link) return { verdict: 'held', reason: `link:${link}` };
  return { verdict: 'live', reason: null };
}

export const isEngineSkill = (row: { origin: string }) => row.origin === ENGINE_ORIGIN;

/**
 * The stored bytes still hash to the definition that was decided, and still
 * carry no credential material. Re-checked at every delivery and before every
 * promotion, so a body edited in storage stops being used even when nothing
 * else about the row changed.
 */
export function engineDefinitionIntact(row: {
  origin: string;
  body: string;
  bodyHash: string;
  skillName: string | null;
  description: string | null;
  scope: Parameters<typeof definitionHash>[0]['scope'];
  compatibleModels: string[];
  change: Record<string, unknown>;
  tests: string[];
  triggers?: readonly unknown[];
  checks?: readonly unknown[];
  caseTemplates?: Record<string, unknown>;
}): boolean {
  if (!isEngineSkill(row) || definitionHash(row) !== row.bodyHash) return false;
  return !credentialMaterial(`${row.skillName ?? ''}\n${row.description ?? ''}\n${row.body}`);
}
