/**
 * Reading and writing knowledge records. The file is the source of truth, so
 * parsing has to be forgiving about how a person wrote the YAML and strict
 * about what the record means once parsed.
 */
import { createHash } from 'node:crypto';
import {
  hasLintErrors,
  type KnowledgeFrontmatter,
  knowledgeFrontmatter,
  type LintContext,
  type LintFinding,
  lintRecord,
} from '@melete/contracts';
import matter from 'gray-matter';

export type ParsedRecord = {
  frontmatter: KnowledgeFrontmatter;
  body: string;
  /** Over the body only, so reformatting the frontmatter does not look like an edit. */
  contentHash: string;
};

export type ParseFailure = {
  ok: false;
  issues: string[];
};

export type ParseSuccess = {
  ok: true;
  record: ParsedRecord;
};

export type ParseResult = ParseSuccess | ParseFailure;

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * YAML turns an unquoted `2026-09-10` into a date. Zod wants the string a
 * person typed, so dates go back to `YYYY-MM-DD` before validation and the
 * record round-trips unchanged.
 */
function normalizeDates(value: unknown): unknown {
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  if (Array.isArray(value)) return value.map(normalizeDates);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeDates(v);
    }
    return out;
  }
  return value;
}

export const bodyHash = (body: string): string =>
  createHash('sha256').update(body.trim(), 'utf8').digest('hex');

/** Parse one record. Never throws: a malformed file is a report, not a crash. */
export function parseRecord(source: string): ParseResult {
  // gray-matter returns an empty object for a file with no `---` block at all,
  // which would otherwise fail as fourteen missing fields instead of one clear
  // sentence about the block that is not there.
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
    data = normalizeDates(parsed.data);
    content = parsed.content;
  } catch (error) {
    return { ok: false, issues: [`frontmatter is not valid YAML: ${String(error)}`] };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, issues: ['the frontmatter block is not a mapping'] };
  }

  const validated = knowledgeFrontmatter.safeParse(data);
  if (!validated.success) {
    return {
      ok: false,
      issues: validated.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    };
  }

  const body = content.trim();
  return {
    ok: true,
    record: { frontmatter: validated.data, body, contentHash: bodyHash(body) },
  };
}

/** Write a record back out. The output parses back to the same record. */
export function serializeRecord(frontmatter: KnowledgeFrontmatter, body: string): string {
  const ordered = knowledgeFrontmatter.parse(frontmatter);
  const text = matter.stringify(`\n${body.trim()}\n`, ordered, { lineWidth: -1 } as never);
  return text.endsWith('\n') ? text : `${text}\n`;
}

export type ValidationResult = {
  ok: boolean;
  findings: LintFinding[];
};

/** Schema validation happened at parse time; this is the rules layer on top. */
export function validateRecord(
  frontmatter: KnowledgeFrontmatter,
  context: LintContext,
): ValidationResult {
  const findings = lintRecord(frontmatter, context);
  return { ok: !hasLintErrors(findings), findings };
}
