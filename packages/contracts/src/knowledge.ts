/**
 * The knowledge file contract. A record is a Markdown file with provenance
 * frontmatter; the Postgres row is a catalog and the FTS index is derived. The
 * four fields that carry their weight are the stable id, the split between
 * observed and valid time, the status plus superseded-by pointer, and the
 * audience that makes a shared directory safe.
 */
import { z } from 'zod';
import { dateOnly, ID_PREFIXES, prefixedId, SCHEMA_VERSION } from './common.ts';

export const KNOWLEDGE_TYPES = [
  'fact',
  'preference',
  'decision',
  'procedure',
  'reference',
  'event',
] as const;
export const knowledgeType = z.enum(KNOWLEDGE_TYPES);
export type KnowledgeType = z.infer<typeof knowledgeType>;

export const KNOWLEDGE_AUDIENCES = ['private', 'space', 'public'] as const;
export const knowledgeAudience = z.enum(KNOWLEDGE_AUDIENCES);
export type KnowledgeAudience = z.infer<typeof knowledgeAudience>;

export const KNOWLEDGE_STATUSES = ['active', 'superseded', 'retracted', 'disputed'] as const;
export const knowledgeRecordStatus = z.enum(KNOWLEDGE_STATUSES);
export type KnowledgeRecordStatus = z.infer<typeof knowledgeRecordStatus>;

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export const confidence = z.enum(CONFIDENCE_LEVELS);
export type Confidence = z.infer<typeof confidence>;

export const ASSERTED_BY = ['user', 'agent', 'document', 'tool'] as const;
export const assertedBy = z.enum(ASSERTED_BY);
export type AssertedBy = z.infer<typeof assertedBy>;

export const SOURCE_KINDS = ['statement', 'file', 'url', 'tool_output'] as const;
export const sourceKind = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof sourceKind>;

export const knowledgeSource = z.object({
  kind: sourceKind,
  /** Where it came from: a session stamp, a path, a URL, a tool call id. */
  ref: z.string().min(1),
  /** The words that were actually said or written. Empty when there is no quote. */
  quote: z.string().default(''),
  /** Over the body only, for file and url sources; drift detection. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
});
export type KnowledgeSource = z.infer<typeof knowledgeSource>;

export const knowledgeId = prefixedId(ID_PREFIXES.knowledge);

export const knowledgeFrontmatter = z.object({
  /** Stable across retitling, so a supersedes chain never breaks. */
  id: knowledgeId,
  title: z.string().min(1).max(200),
  /** MUST equal the directory this file lives in. The linter enforces it. */
  space: z.string().min(1),
  audience: knowledgeAudience,
  type: knowledgeType,
  status: knowledgeRecordStatus,
  confidence,
  asserted_by: assertedBy,
  source: knowledgeSource,
  /** When Melete learned it. */
  observed_at: dateOnly,
  /** When it became true in the world. Not the same thing. */
  valid_from: dateOnly,
  /** Null means still true. */
  valid_until: dateOnly.nullable().default(null),
  supersedes: z.array(knowledgeId).default([]),
  superseded_by: knowledgeId.nullable().default(null),
  created: dateOnly,
  updated: dateOnly,
  tags: z.array(z.string()).default([]),
  links: z.array(knowledgeId).default([]),
  schema_version: z.literal(SCHEMA_VERSION),
});
export type KnowledgeFrontmatter = z.infer<typeof knowledgeFrontmatter>;

export const knowledgeRecord = z.object({
  frontmatter: knowledgeFrontmatter,
  body: z.string(),
  /** Relative to the space root, for example `knowledge/prefers-bun.md`. */
  path: z.string().min(1),
});
export type KnowledgeRecord = z.infer<typeof knowledgeRecord>;

// --------------------------------------------------------------------------
// Lint rules
// --------------------------------------------------------------------------

export const LINT_RULES = [
  'space-equals-directory',
  'supersedes-resolve',
  'status-transition',
  'superseded-needs-pointer',
  'valid-window',
] as const;
export type LintRule = (typeof LINT_RULES)[number];

export type LintSeverity = 'error' | 'warning';

export type LintFinding = {
  rule: LintRule;
  severity: LintSeverity;
  message: string;
  field?: string;
};

/** Normalize a path so Windows and POSIX callers lint the same way. */
const toPosix = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * Isolation is structural: a record's `space` must equal the directory it lives
 * in, so a file written or moved into the wrong space is caught by the linter
 * rather than silently searchable from another space.
 */
export function lintSpaceMatchesDirectory(
  frontmatter: Pick<KnowledgeFrontmatter, 'space'>,
  filePath: string,
  spacesRoot: string,
): LintFinding[] {
  const root = toPosix(spacesRoot);
  const file = toPosix(filePath);
  if (!file.startsWith(`${root}/`)) {
    return [
      {
        rule: 'space-equals-directory',
        severity: 'error',
        field: 'space',
        message: `record at ${file} is outside the spaces root ${root}`,
      },
    ];
  }
  const relative = file.slice(root.length + 1);
  const directorySpace = relative.split('/')[0];
  if (!directorySpace) {
    return [
      {
        rule: 'space-equals-directory',
        severity: 'error',
        field: 'space',
        message: `record at ${file} is not inside a space directory`,
      },
    ];
  }
  if (directorySpace !== frontmatter.space) {
    return [
      {
        rule: 'space-equals-directory',
        severity: 'error',
        field: 'space',
        message: `frontmatter says space "${frontmatter.space}" but the file lives in "${directorySpace}"`,
      },
    ];
  }
  return [];
}

/**
 * Every id a record points at must exist. A dangling supersedes is a hole in
 * the chain that explains why Melete changed its mind.
 */
export function lintSupersedesResolve(
  frontmatter: Pick<KnowledgeFrontmatter, 'id' | 'supersedes' | 'superseded_by' | 'links'>,
  knownIds: ReadonlySet<string>,
): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const id of frontmatter.supersedes) {
    if (id === frontmatter.id) {
      findings.push({
        rule: 'supersedes-resolve',
        severity: 'error',
        field: 'supersedes',
        message: `${frontmatter.id} supersedes itself`,
      });
      continue;
    }
    if (!knownIds.has(id)) {
      findings.push({
        rule: 'supersedes-resolve',
        severity: 'error',
        field: 'supersedes',
        message: `supersedes ${id}, which does not exist in this space`,
      });
    }
  }
  if (frontmatter.superseded_by && !knownIds.has(frontmatter.superseded_by)) {
    findings.push({
      rule: 'supersedes-resolve',
      severity: 'error',
      field: 'superseded_by',
      message: `superseded_by ${frontmatter.superseded_by}, which does not exist in this space`,
    });
  }
  for (const id of frontmatter.links) {
    if (!knownIds.has(id)) {
      findings.push({
        rule: 'supersedes-resolve',
        severity: 'warning',
        field: 'links',
        message: `links to ${id}, which does not exist in this space`,
      });
    }
  }
  return findings;
}

/**
 * Legal status moves. Retraction is final in the file: the text and the reason
 * stay, and hard deletion is a separate operation that removes the file and
 * rebuilds the index.
 */
export const LEGAL_STATUS_TRANSITIONS: Readonly<
  Record<KnowledgeRecordStatus, readonly KnowledgeRecordStatus[]>
> = {
  active: ['superseded', 'retracted', 'disputed'],
  disputed: ['active', 'superseded', 'retracted'],
  superseded: ['retracted'],
  retracted: [],
};

export function lintStatusTransition(
  from: KnowledgeRecordStatus,
  to: KnowledgeRecordStatus,
): LintFinding[] {
  if (from === to) return [];
  const allowed = LEGAL_STATUS_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    return [
      {
        rule: 'status-transition',
        severity: 'error',
        field: 'status',
        message: `status cannot move from ${from} to ${to}`,
      },
    ];
  }
  return [];
}

/** A superseded record must say what replaced it, or the trail stops there. */
export function lintSupersededNeedsPointer(
  frontmatter: Pick<KnowledgeFrontmatter, 'status' | 'superseded_by'>,
): LintFinding[] {
  if (frontmatter.status === 'superseded' && !frontmatter.superseded_by) {
    return [
      {
        rule: 'superseded-needs-pointer',
        severity: 'error',
        field: 'superseded_by',
        message: 'a superseded record must name the record that replaced it',
      },
    ];
  }
  return [];
}

export function lintValidWindow(
  frontmatter: Pick<KnowledgeFrontmatter, 'valid_from' | 'valid_until'>,
): LintFinding[] {
  if (frontmatter.valid_until && frontmatter.valid_until < frontmatter.valid_from) {
    return [
      {
        rule: 'valid-window',
        severity: 'error',
        field: 'valid_until',
        message: `valid_until ${frontmatter.valid_until} is before valid_from ${frontmatter.valid_from}`,
      },
    ];
  }
  return [];
}

export type LintContext = {
  filePath: string;
  spacesRoot: string;
  knownIds: ReadonlySet<string>;
  /** The status this record had before this write, when there was one. */
  previousStatus?: KnowledgeRecordStatus;
};

/** Every rule, in one call. Errors block a write; warnings are shown and allowed. */
export function lintRecord(frontmatter: KnowledgeFrontmatter, context: LintContext): LintFinding[] {
  const findings: LintFinding[] = [
    ...lintSpaceMatchesDirectory(frontmatter, context.filePath, context.spacesRoot),
    ...lintSupersedesResolve(frontmatter, context.knownIds),
    ...lintSupersededNeedsPointer(frontmatter),
    ...lintValidWindow(frontmatter),
  ];
  if (context.previousStatus) {
    findings.push(...lintStatusTransition(context.previousStatus, frontmatter.status));
  }
  return findings;
}

export const hasLintErrors = (findings: readonly LintFinding[]): boolean =>
  findings.some((f) => f.severity === 'error');

/** Retrieval never returns these, before or after a restart. */
export const isRetrievable = (status: KnowledgeRecordStatus): boolean =>
  status === 'active' || status === 'disputed';

/**
 * A write the agent asked for. It lands in `.proposed/` and becomes a diff a
 * person can read; nothing the agent writes reaches the space directly.
 */
export const proposedWrite = z.object({
  space: z.string().min(1),
  /** Relative to the space root. Must resolve inside it. */
  path: z.string().min(1),
  frontmatter: knowledgeFrontmatter,
  body: z.string(),
  rationale: z.string().min(1).max(500),
});
export type ProposedWrite = z.infer<typeof proposedWrite>;

/** The canonical directory layout inside one space. */
export const SPACE_LAYOUT = {
  schema: 'SCHEMA.md',
  index: 'index.md',
  log: 'log.md',
  knowledge: 'knowledge',
  raw: 'raw',
  artifacts: 'artifacts',
  skills: 'skills',
  index_db: '.index/fts.sqlite',
  proposed: '.proposed',
} as const;
