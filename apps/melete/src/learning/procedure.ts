import { createHash } from 'node:crypto';
import { estimateTokens } from '@melete/skills';
import { z } from 'zod';
import type { ProcedureScope } from './contracts.ts';

/** The one family with bundled fixtures and an audited step vocabulary of its own. */
export const RECORDS_FAMILY = 'organize-records';

/** Audited vocabulary: the model can compose procedure steps, never carry private prose forward. */
export const STEP_BODIES = {
  'sort-typed-values':
    'Order records using the declared column type: compare numeric values numerically, dates chronologically, and text lexically. Read the direction and key from this job. Preserve the original value representation.',
  'sort-text-values':
    'Order records by comparing the selected values as text. Read the direction and key from this job. Preserve the original value representation.',
  'keep-header-and-rows':
    'Keep the header and every input row exactly once. Check the row count and column names before returning the result. Do not import values from earlier jobs.',
} as const;
export const procedureStep = z.enum([
  'sort-typed-values',
  'sort-text-values',
  'keep-header-and-rows',
]);
export const procedureChange = z
  .strictObject({
    target: z.literal('skill_body'),
    steps: z
      .array(procedureStep)
      .min(1)
      .max(3)
      .refine((steps) => new Set(steps).size === steps.length),
    test: z.literal('ordering-and-shape'),
  })
  .refine(
    (value) =>
      !(value.steps.includes('sort-typed-values') && value.steps.includes('sort-text-values')),
    'Choose one ordering rule',
  );
export type ProcedureChange = z.infer<typeof procedureChange>;

export function compileProcedure(raw: unknown) {
  const change = procedureChange.parse(raw);
  const body = change.steps.map((step) => STEP_BODIES[step]).join('\n');
  if (estimateTokens(body) > 400) throw new Error('procedure_token_limit');
  return {
    change,
    body,
    tests: [change.test],
    predictedBenefit:
      'Fewer owner corrections when arranging records in the evaluated task family.',
    knownRisk: change.steps.includes('sort-text-values')
      ? 'Text ordering can be incorrect for numeric and non-ISO date columns.'
      : 'Unknown column types require clarification; ordering may not apply to other task families.',
  };
}

/**
 * Every field that changes applicability or behaviour is bound to the evaluation.
 * Triggers decide which requests receive the body, checks decide what counts as
 * a correction, and the case templates decide which held-out work the evidence
 * came from, so all three are part of the definition and not metadata beside it.
 */
export function definitionHash(value: {
  body: string;
  scope: ProcedureScope;
  compatibleModels: string[];
  change: Record<string, unknown>;
  tests: string[];
  triggers?: readonly unknown[];
  checks?: readonly unknown[];
  caseTemplates?: Record<string, unknown>;
}) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          body: value.body,
          scope: value.scope,
          models: value.compatibleModels,
          change: value.change,
          tests: value.tests,
          triggers: value.triggers ?? [],
          checks: value.checks ?? [],
          cases: value.caseTemplates ?? {},
        }),
      ),
    )
    .digest('hex');
}

// Postgres jsonb may reorder object keys; evidence binds meaning, not serialization order.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export const PROPOSAL_INSTRUCTIONS = `Return only JSON with target:"skill_body", steps (one to three distinct step ids), and test:"ordering-and-shape".
Choose from the supplied audited vocabulary, using only the general intervention signal. Choose at most one ordering rule.
You receive no private episode text, task inputs, customer facts, receipts, or final evaluation tasks.
You have no tools, file access, or authority to change permissions. Do not return prose, a path, a skill body, or additional fields.`;
