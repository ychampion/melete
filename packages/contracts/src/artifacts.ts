/**
 * Artifacts as deliverables, and the validations that decide whether one is
 * finished.
 *
 * A file appearing in the workspace is not a deliverable. A deliverable is a
 * file that was declared, checked, and found to hold. So a write may carry an
 * expectation: what kind of thing this is meant to be and what has to be true
 * of it. The service runs the checks it can run without asking anyone, records
 * every result next to the content hash it was computed over, and a job that
 * declared an expectation cannot complete while one of its own checks is
 * failing. The model is not asked whether the file is good.
 *
 * Four classes of validator, in descending order of how much they prove:
 *
 * - `deterministic`  a function of the bytes. Parses, totals, sections,
 *                    dimensions. Passing means the property holds.
 * - `render`         the file was opened by a real renderer and produced
 *                    output. Passing means it is not a file that only looks
 *                    like one. `unavailable` when no renderer exists yet.
 * - `critique`       a model read it and said something. Always advisory: it
 *                    is recorded, it is shown, it never gates a completion.
 * - `human`          a person accepted it. The only one that can speak for
 *                    whether the thing was worth making.
 */
import { z } from 'zod';
import { ID_PREFIXES, jsonObject, jsonSchema, prefixedId, timestamp } from './common.ts';

export const ARTIFACT_KINDS = [
  'markdown',
  'csv',
  'json',
  'text',
  'html',
  'image',
  'pdf',
  'docx',
  'xlsx',
  'binary',
] as const;
export const artifactKind = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof artifactKind>;

export const ARTIFACT_AREAS = ['work', 'artifacts'] as const;
export const artifactArea = z.enum(ARTIFACT_AREAS);
export type ArtifactArea = z.infer<typeof artifactArea>;

export const ARTIFACT_VALIDATOR_CLASSES = ['deterministic', 'render', 'critique', 'human'] as const;
export const artifactValidatorClass = z.enum(ARTIFACT_VALIDATOR_CLASSES);
export type ArtifactValidatorClass = z.infer<typeof artifactValidatorClass>;

/**
 * `pending` is a real resting state and it blocks: a declared human acceptance
 * that nobody has given yet is not a pass. `unavailable` does not block, and
 * says so in its own word rather than borrowing `passed`.
 */
export const ARTIFACT_VALIDATION_STATUSES = ['passed', 'failed', 'pending', 'unavailable'] as const;
export const artifactValidationStatus = z.enum(ARTIFACT_VALIDATION_STATUSES);
export type ArtifactValidationStatus = z.infer<typeof artifactValidationStatus>;

// --------------------------------------------------------------------------
// checks
// --------------------------------------------------------------------------

/**
 * A deterministic check. Each one is a function of the bytes and the declared
 * kind, and each one is refusable: if the check cannot be computed the result
 * is `failed` with the reason, never a shrug.
 */
export const artifactCheck = z.discriminatedUnion('kind', [
  /** The file parses as its declared kind. Implied by every other check. */
  z.object({ kind: z.literal('parses') }),
  /** The file is not empty, and not only whitespace. */
  z.object({ kind: z.literal('non_empty') }),
  /** A JSON document validates against a schema. */
  z.object({ kind: z.literal('schema'), schema: jsonSchema }),
  /** Markdown contains a heading for each named section. */
  z.object({
    kind: z.literal('required_sections'),
    sections: z.array(z.string().min(1)).min(1).max(50),
  }),
  /** A tabular file has these columns, in any order. */
  z.object({
    kind: z.literal('required_columns'),
    columns: z.array(z.string().min(1)).min(1).max(100),
  }),
  /** A tabular file has at least this many data rows, and at most that many. */
  z.object({
    kind: z.literal('row_count'),
    min: z.number().int().nonnegative().default(1),
    max: z.number().int().positive().nullable().default(null),
  }),
  /**
   * The numbers in `column` add up to `equals`, or to the value in the row
   * whose first cell is `total_label`. This is the check that catches the
   * spreadsheet that looks right and is not.
   */
  z.object({
    kind: z.literal('totals'),
    column: z.string().min(1),
    equals: z.number().nullable().default(null),
    total_label: z.string().min(1).nullable().default(null),
    tolerance: z.number().nonnegative().default(0.005),
  }),
  /** An image is exactly, or at least, this big. */
  z.object({
    kind: z.literal('image_dimensions'),
    width: z.number().int().positive().nullable().default(null),
    height: z.number().int().positive().nullable().default(null),
    min_width: z.number().int().positive().nullable().default(null),
    min_height: z.number().int().positive().nullable().default(null),
  }),
]);
export type ArtifactCheck = z.infer<typeof artifactCheck>;

/**
 * The name a check's result is recorded under. Two checks with the same name
 * are the same claim about the file, and only one of them can be true, so the
 * declaration is refused rather than one of them being dropped on the floor.
 */
export const artifactCheckName = (check: ArtifactCheck): string =>
  check.kind === 'totals' ? `totals:${check.column.trim().toLowerCase()}` : check.kind;

/**
 * What a write says the file is meant to be. Optional on every write: a
 * scratch file declares nothing and is not an artifact.
 */
const uniqueChecks = (checks: ArtifactCheck[], ctx: z.RefinementCtx): void => {
  const seen = new Set<string>();
  for (const [index, check] of checks.entries()) {
    const name = artifactCheckName(check);
    if (seen.has(name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['checks', index],
        message: `two checks would both be recorded as ${name}; declare each one once`,
      });
    }
    seen.add(name);
  }
};

export const artifactExpectation = z.object({
  kind: artifactKind,
  checks: z.array(artifactCheck).max(25).default([]).superRefine(uniqueChecks),
  /** Open it with a renderer as well. Default on: it is cheap and it catches a lot. */
  render: z.boolean().default(true),
  /** Ask a model to read it. Advisory, recorded, never a gate. */
  critique: z.string().min(1).max(2000).nullable().default(null),
  /** Require a person to accept it before the job may complete. */
  human: z.boolean().default(false),
  /** The template this was produced from, if any. Carried onto the record. */
  template: z.string().min(1).max(200).nullable().default(null),
});
export type ArtifactExpectation = z.infer<typeof artifactExpectation>;

// --------------------------------------------------------------------------
// results
// --------------------------------------------------------------------------

/**
 * One validation result, bound to the content hash it was computed over. A new
 * write of the same path is a new artifact row with its own results, which is
 * how fixing a file clears a failure without anyone editing a record.
 */
export const artifactValidation = z.object({
  artifact_id: prefixedId(ID_PREFIXES.artifact),
  class: artifactValidatorClass,
  /** `csv.parses`, `totals:amount`, `render:markdown`, `human`. Stable enough to grep. */
  name: z.string().min(1).max(120),
  status: artifactValidationStatus,
  /** One sentence a person can read. Empty for a pass that needs no words. */
  detail: z.string().max(2000).default(''),
  /** Whatever the validator wants kept: counts, sums, dimensions, the model's note. */
  evidence: jsonObject.default({}),
  /** True for classes that never block a completion. */
  advisory: z.boolean().default(false),
  checked_at: timestamp,
  /** Digest of the bytes checked; absent on records produced before digest binding. */
  validated_content_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type ArtifactValidation = z.infer<typeof artifactValidation>;

/** A validation that has not been assigned to a stored artifact yet. */
export const pendingArtifactValidation = artifactValidation.omit({ artifact_id: true });
export type PendingArtifactValidation = z.infer<typeof pendingArtifactValidation>;

/**
 * Does this set of results let a job say it is done?
 *
 * Only a pass counts. `unavailable` is not a pass: a validator that could not
 * run has not established anything, and treating it as success is how a job
 * completes on a check nobody made. A validator whose absence is genuinely
 * acceptable says so by marking its result advisory.
 */
export const artifactValidationsHold = (
  validations: readonly Pick<ArtifactValidation, 'status' | 'advisory'>[],
): boolean => validations.every((result) => result.advisory || result.status === 'passed');

// --------------------------------------------------------------------------
// publishing
// --------------------------------------------------------------------------

/**
 * Where a finished artifact goes. v0.1 has two: the space's own artifacts
 * directory, which is where the owner looks for finished work, and an email
 * with the file attached.
 */
export const publishDestination = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('space_artifacts'),
    /** Relative path under the space's artifacts directory. Defaults to the source name. */
    path: z.string().min(1).max(1024).nullable().default(null),
  }),
  z.object({
    kind: z.literal('email'),
    to: z.union([z.email(), z.array(z.email()).min(1).max(20)]),
    subject: z
      .string()
      .min(1)
      .max(500)
      .regex(/^[^\r\n]*$/),
    body: z.string().max(20_000).default(''),
    filename: z.string().min(1).max(200).nullable().default(null),
  }),
]);
export type PublishDestination = z.infer<typeof publishDestination>;

/** What came back from a destination. Persisted on the artifact record. */
export const publishReceipt = z.object({
  destination: z.enum(['space_artifacts', 'email']),
  /** The action whose receipt this is. The evidence handle for a completion. */
  action_id: prefixedId(ID_PREFIXES.action),
  /** A path, a Message-ID: whatever the destination calls the thing it now holds. */
  external_ref: z.string().nullable(),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  detail: jsonObject.default({}),
  published_at: timestamp,
});
export type PublishReceipt = z.infer<typeof publishReceipt>;

// --------------------------------------------------------------------------
// the record
// --------------------------------------------------------------------------

/**
 * Everything an artifact points at: the job that made it, the evidence that
 * went into it, the template it came from, what was checked, and where it went.
 *
 * `source_job_id` is the one that matters for continuity. "Update this with the
 * latest data" is the same job waking again, not a new job that happens to
 * write a similarly named file, and it is this field that lets the service tell
 * the difference.
 */
export const artifactRecord = z.object({
  id: prefixedId(ID_PREFIXES.artifact),
  space_id: prefixedId(ID_PREFIXES.space),
  job_id: prefixedId(ID_PREFIXES.job).nullable(),
  /** The job whose work this artifact is, kept even if the job row is later detached. */
  source_job_id: prefixedId(ID_PREFIXES.job).nullable().default(null),
  area: artifactArea.default('work'),
  path: z.string().min(1),
  kind: artifactKind.default('binary'),
  content_hash: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  template: z.string().nullable().default(null),
  expectation: artifactExpectation.nullable().default(null),
  /** Handles the content was derived from: actions, knowledge revisions, other artifacts. */
  evidence: z.array(z.string().min(1)).default([]),
  validations: z.array(artifactValidation).default([]),
  publications: z.array(publishReceipt).default([]),
  created_at: timestamp,
});
export type ArtifactRecord = z.infer<typeof artifactRecord>;

/** The MIME type Melete stores for each declared kind. */
export const ARTIFACT_MIME: Record<ArtifactKind, string> = {
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  text: 'text/plain',
  html: 'text/html',
  image: 'image/png',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  binary: 'application/octet-stream',
};

/** Guess the kind from an extension, for a write that declared none. */
export function artifactKindForPath(path: string): ArtifactKind {
  const match = /\.([a-z0-9]+)$/i.exec(path.trim());
  switch (match?.[1]?.toLowerCase()) {
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'csv':
      return 'csv';
    case 'json':
      return 'json';
    case 'html':
    case 'htm':
      return 'html';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
      return 'image';
    case 'pdf':
      return 'pdf';
    case 'docx':
      return 'docx';
    case 'xlsx':
      return 'xlsx';
    case 'txt':
      return 'text';
    default:
      return 'binary';
  }
}
