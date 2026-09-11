import { z } from 'zod';

const instant = z.iso.datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const metric = z.strictObject({
  family: z.string().min(1),
  template: z.string().min(1),
  space: z.string().min(1),
  occurredAt: instant,
  baseline: z.number().min(0).max(1),
  candidate: z.number().min(0).max(1),
  baselineCorrections: z.number().int().nonnegative(),
  candidateCorrections: z.number().int().nonnegative(),
  scopeViolations: z.number().int().nonnegative(),
});
export const gateInput = z.strictObject({
  phase: z.enum(['validation', 'sealed_final']),
  definitionHash: hash,
  suiteHash: hash,
  target: z.literal('skill_body'),
  source: z.strictObject({
    family: z.string(),
    template: z.string(),
    space: z.string(),
    occurredAt: instant,
  }),
  rows: z.array(metric).min(3).max(100),
  criticalFamilies: z.array(z.string()).min(1),
  budget: z.strictObject({
    jobs: z.number().int().min(1).max(40),
    reservedTokens: z.number().int().min(1).max(65536),
    durationMs: z.number().nonnegative(),
  }),
  selection: z
    .strictObject({
      definitionHash: hash,
      selectedAt: instant,
      templates: z.array(z.string()),
      spaces: z.array(z.string()),
      latestInstanceAt: instant,
    })
    .nullable(),
});
export type GateInput = z.infer<typeof gateInput>;
export type Metric = z.infer<typeof metric>;
export type GateDecision = {
  decision: 'reject' | 'select' | 'allow_canary';
  reason: string;
  definitionHash: string;
};

/** Pure decision code: its only output is a bounded decision, never code or a file edit. */
export function decidePromotion(raw: unknown): GateDecision {
  const input = gateInput.parse(raw);
  const reject = (reason: string): GateDecision => ({
    decision: 'reject',
    reason,
    definitionHash: input.definitionHash,
  });
  if (input.phase === 'validation' && input.selection)
    return reject('validation_cannot_claim_selection');
  if (
    input.phase === 'sealed_final' &&
    (!input.selection || input.selection.definitionHash !== input.definitionHash)
  )
    return reject('final_requires_prior_selection');
  const target = input.rows.filter((row) => row.family === input.source.family);
  if (target.length < 2 || new Set(target.map((row) => row.template)).size < 2)
    return reject('insufficient_held_out_templates');
  for (const row of input.rows) {
    if (row.scopeViolations !== 0) return reject('scope_violation');
    if (
      row.template === input.source.template ||
      row.space === input.source.space ||
      Date.parse(row.occurredAt) <= Date.parse(input.source.occurredAt)
    )
      return reject('training_partition_overlap');
    if (
      input.selection &&
      (input.selection.templates.includes(row.template) ||
        input.selection.spaces.includes(row.space) ||
        Date.parse(row.occurredAt) <= Date.parse(input.selection.latestInstanceAt) ||
        Date.parse(row.occurredAt) <= Date.parse(input.selection.selectedAt))
    )
      return reject('final_partition_overlap');
    // A family average cannot compensate for harming a task template.
    if (row.candidate < row.baseline || row.candidateCorrections > row.baselineCorrections)
      return reject(`negative_transfer:${row.family}:${row.template}`);
  }
  for (const family of input.criticalFamilies) {
    const checks = input.rows.filter((row) => row.family === family);
    if (!checks.length || checks.some((row) => row.candidate !== 1 || row.baseline !== 1))
      return reject(`critical_family_failed:${family}`);
  }
  const sum = (key: 'baseline' | 'candidate') => target.reduce((total, row) => total + row[key], 0);
  const corrections = (key: 'baselineCorrections' | 'candidateCorrections') =>
    target.reduce((total, row) => total + row[key], 0);
  if (
    sum('candidate') <= sum('baseline') ||
    corrections('candidateCorrections') >= corrections('baselineCorrections')
  )
    return reject('no_family_improvement');
  return {
    decision: input.phase === 'validation' ? 'select' : 'allow_canary',
    reason: 'held_out_improvement_without_regression',
    definitionHash: input.definitionHash,
  };
}
