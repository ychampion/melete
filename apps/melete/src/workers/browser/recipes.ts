import type { Sql } from 'postgres';
import { z } from 'zod';
import {
  isSensitiveControl,
  sensitiveName,
  type VisibleControl,
  type VisibleSchema,
} from './visible.ts';

export { isSensitiveControl, type VisibleControl, type VisibleSchema } from './visible.ts';

/** Values stay in the current broker action; a reusable recipe stores only their keys. */
export type RecipeStep =
  | { action: 'fill'; label: string; value_key: string }
  | { action: 'select'; label: string; value_key: string }
  | { action: 'click'; role: string; name: string }
  | { action: 'submit'; role: string; name: string };

export const RECIPE_STATES = [
  'candidate',
  'validated',
  'promoted',
  'rejected',
  'superseded',
] as const;
export type RecipeState = (typeof RECIPE_STATES)[number];
export const RECIPE_REASONS = [
  'recorded',
  'matched_schema',
  'safe_alias',
  'recipe_not_checked',
  'schema_mismatch',
  'multiple_aliases',
  'unknown_required_field',
  'ambiguous_control',
  'sensitive_control',
  'invalid_recipe',
] as const;
export type RecipeReason = (typeof RECIPE_REASONS)[number];

export type BrowserRecipeCandidate = {
  id: string;
  space_id: string;
  version: number;
  state: RecipeState;
  schema: VisibleSchema;
  steps: RecipeStep[];
  /** Recorded label -> replacement label; written by the trusted recipe review path. */
  safe_aliases: Record<string, string>;
  reason: RecipeReason;
};

export type RecipeMatch = {
  disposition: 'reuse' | 'fallback' | 'stop';
  reason: RecipeReason;
  /** Empty on refusal/fallback so an unchecked plan cannot accidentally run. */
  steps: RecipeStep[];
  aliases_used: number;
};

export class BrowserRecipeFault extends Error {
  constructor(
    readonly reason:
      | 'invalid_recipe'
      | 'sensitive_control'
      | 'recipe_version_conflict'
      | 'invalid_recipe_transition',
  ) {
    // Never attach rejected input: validation failures can contain credentials.
    super(reason);
    this.name = 'BrowserRecipeFault';
  }
}

const label = z.string().min(1).max(240);
const role = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/)
  .max(40);
const visibleControl = z.strictObject({
  label: z.string().max(240),
  role,
  required: z.boolean(),
  sensitive: z.boolean(),
});
const visibleSchema = z.array(visibleControl).max(128);
const valueFields = {
  label,
  value_key: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(80),
};
const semanticStep = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('fill'), ...valueFields }),
  z.strictObject({ action: z.literal('select'), ...valueFields }),
  z.strictObject({ action: z.literal('click'), role, name: label }),
  z.strictObject({ action: z.literal('submit'), role, name: label }),
]);
const recipeCandidate = z.strictObject({
  id: z.string().min(1).max(120),
  space_id: z.string().min(1).max(120),
  version: z.number().int().positive(),
  state: z.enum(RECIPE_STATES),
  schema: visibleSchema,
  steps: z.array(semanticStep).min(1).max(64),
  safe_aliases: z.record(label, label).refine((aliases) => Object.keys(aliases).length <= 16),
  reason: z.enum(RECIPE_REASONS),
});

function sensitiveStep(step: RecipeStep): boolean {
  return step.action === 'fill' || step.action === 'select'
    ? sensitiveName.test(step.label) || sensitiveName.test(step.value_key)
    : sensitiveName.test(step.name) || sensitiveName.test(step.role);
}

/** Strict parsing rejects extra `value`, screenshot, or transcript fields before any write. */
export function validateBrowserRecipeCandidate(input: unknown): BrowserRecipeCandidate {
  const parsed = recipeCandidate.safeParse(input);
  if (!parsed.success) throw new BrowserRecipeFault('invalid_recipe');
  const candidate = parsed.data;
  if (
    candidate.schema.some(isSensitiveControl) ||
    candidate.steps.some(sensitiveStep) ||
    Object.entries(candidate.safe_aliases).some(
      ([from, to]) => sensitiveName.test(from) || sensitiveName.test(to),
    )
  ) {
    throw new BrowserRecipeFault('sensitive_control');
  }
  return candidate;
}

function controlKey(control: VisibleControl): string {
  return JSON.stringify([control.role, control.label]);
}

function ambiguous(schema: VisibleSchema, steps: RecipeStep[]): boolean {
  const keys = schema.map(controlKey);
  if (new Set(keys).size !== keys.length) return true;
  // Fill/select locate by label. Two different roles sharing one label are also ambiguous.
  return steps.some(
    (step) =>
      (step.action === 'fill' || step.action === 'select') &&
      schema.filter((control) => control.label === step.label).length > 1,
  );
}

function refusal(disposition: 'fallback' | 'stop', reason: RecipeReason): RecipeMatch {
  return { disposition, reason, steps: [], aliases_used: 0 };
}

/**
 * The visible schema is checked as a multiset before any recipe step is returned.
 * A mismatch is evidence for a candidate, never permission to widen a selector.
 */
export function matchRecipe(
  recipe: BrowserRecipeCandidate,
  currentSchema: VisibleSchema,
): RecipeMatch {
  let checked: BrowserRecipeCandidate;
  try {
    checked = validateBrowserRecipeCandidate(recipe);
  } catch (error) {
    return refusal(
      'stop',
      error instanceof BrowserRecipeFault && error.reason === 'sensitive_control'
        ? 'sensitive_control'
        : 'invalid_recipe',
    );
  }
  const parsed = visibleSchema.safeParse(currentSchema);
  if (!parsed.success) return refusal('stop', 'invalid_recipe');
  const current = parsed.data;
  if (current.some(isSensitiveControl)) return refusal('stop', 'sensitive_control');
  if (ambiguous(current, checked.steps) || ambiguous(checked.schema, checked.steps)) {
    return refusal('stop', 'ambiguous_control');
  }

  const aliases = new Map<string, string>();
  for (const expected of checked.schema) {
    if (current.some((control) => controlKey(control) === controlKey(expected))) continue;
    const replacement = checked.safe_aliases[expected.label];
    if (
      replacement &&
      current.some((control) => control.role === expected.role && control.label === replacement)
    ) {
      aliases.set(expected.label, replacement);
    }
  }

  for (const control of current) {
    if (
      control.required &&
      !checked.schema.some(
        (expected) =>
          expected.role === control.role &&
          (expected.label === control.label || aliases.get(expected.label) === control.label),
      )
    ) {
      return refusal('stop', 'unknown_required_field');
    }
  }
  if (aliases.size > 1) return refusal('fallback', 'multiple_aliases');

  const mappedSchema = checked.schema.map((control) => ({
    ...control,
    label: aliases.get(control.label) ?? control.label,
  }));
  const steps: RecipeStep[] = checked.steps.map((step) =>
    step.action === 'fill' || step.action === 'select'
      ? { ...step, label: aliases.get(step.label) ?? step.label }
      : { ...step, name: aliases.get(step.name) ?? step.name },
  );
  if (ambiguous(current, steps) || ambiguous(mappedSchema, steps)) {
    return refusal('stop', 'ambiguous_control');
  }
  const fingerprint = (schema: VisibleSchema) =>
    schema.map((control) => JSON.stringify([controlKey(control), control.required])).sort();
  if (JSON.stringify(fingerprint(mappedSchema)) !== JSON.stringify(fingerprint(current))) {
    return refusal('fallback', 'schema_mismatch');
  }
  if (
    steps.some((step) =>
      step.action === 'fill' || step.action === 'select'
        ? !current.some((control) => control.label === step.label)
        : !current.some((control) => control.role === step.role && control.label === step.name),
    )
  ) {
    return refusal('fallback', 'schema_mismatch');
  }
  if (checked.state !== 'validated' && checked.state !== 'promoted') {
    return refusal('fallback', 'recipe_not_checked');
  }
  return {
    disposition: 'reuse',
    reason: aliases.size ? 'safe_alias' : 'matched_schema',
    steps,
    aliases_used: aliases.size,
  };
}

export interface BrowserRecipeStore {
  save(candidate: BrowserRecipeCandidate): Promise<BrowserRecipeCandidate>;
  get(spaceId: string, id: string, version?: number): Promise<BrowserRecipeCandidate | null>;
  list(spaceId: string, state?: RecipeState): Promise<BrowserRecipeCandidate[]>;
}

const transitions: Record<RecipeState, readonly RecipeState[]> = {
  candidate: ['validated', 'rejected'],
  validated: ['promoted', 'rejected'],
  promoted: ['superseded'],
  rejected: [],
  superseded: [],
};

function template(candidate: BrowserRecipeCandidate): string {
  return JSON.stringify({
    schema: candidate.schema,
    steps: candidate.steps,
    safe_aliases: Object.entries(candidate.safe_aliases).sort(([a], [b]) => a.localeCompare(b)),
    reason: candidate.reason,
  });
}

function checkUpdate(previous: BrowserRecipeCandidate, next: BrowserRecipeCandidate): void {
  if (template(previous) !== template(next))
    throw new BrowserRecipeFault('recipe_version_conflict');
  if (previous.state !== next.state && !transitions[previous.state].includes(next.state)) {
    throw new BrowserRecipeFault('invalid_recipe_transition');
  }
}

/** A test store uses the same parser and version gates as the durable store. */
export class MemoryBrowserRecipeStore implements BrowserRecipeStore {
  private readonly records = new Map<string, BrowserRecipeCandidate>();

  async save(input: BrowserRecipeCandidate): Promise<BrowserRecipeCandidate> {
    const candidate = validateBrowserRecipeCandidate(input);
    const key = JSON.stringify([candidate.space_id, candidate.id, candidate.version]);
    const previous = this.records.get(key);
    if (previous) checkUpdate(previous, candidate);
    this.records.set(key, candidate);
    return structuredClone(candidate);
  }

  async get(spaceId: string, id: string, version?: number): Promise<BrowserRecipeCandidate | null> {
    const found = [...this.records.values()]
      .filter(
        (candidate) =>
          candidate.space_id === spaceId &&
          candidate.id === id &&
          (version === undefined || candidate.version === version),
      )
      .sort((a, b) => b.version - a.version)[0];
    return found ? structuredClone(found) : null;
  }

  async list(spaceId: string, state?: RecipeState): Promise<BrowserRecipeCandidate[]> {
    return structuredClone(
      [...this.records.values()]
        .filter(
          (candidate) =>
            candidate.space_id === spaceId && (state === undefined || candidate.state === state),
        )
        .sort((a, b) => a.id.localeCompare(b.id) || b.version - a.version)
        .slice(0, 100),
    );
  }
}

/** The service owns this store; the browser worker is never given a database handle. */
export class PostgresBrowserRecipeStore implements BrowserRecipeStore {
  constructor(private readonly sql: Sql) {}

  async save(input: BrowserRecipeCandidate): Promise<BrowserRecipeCandidate> {
    const candidate = validateBrowserRecipeCandidate(input);
    await this.sql.begin(async (tx) => {
      // A per-version advisory lock also serializes two first inserts, before a row exists.
      const key = JSON.stringify([candidate.space_id, candidate.id, candidate.version]);
      await tx`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
      const rows = await tx`
        select id, space_id, version, state, schema, steps, safe_aliases, reason
        from browser_recipe_candidate where space_id = ${candidate.space_id}
        and id = ${candidate.id} and version = ${candidate.version} for update`;
      if (rows[0]) checkUpdate(validateBrowserRecipeCandidate(rows[0]), candidate);
      await tx`
        insert into browser_recipe_candidate
          (id, space_id, version, state, schema, steps, safe_aliases, reason)
        values (${candidate.id}, ${candidate.space_id}, ${candidate.version}, ${candidate.state},
          ${JSON.stringify(candidate.schema)}::jsonb, ${JSON.stringify(candidate.steps)}::jsonb,
          ${JSON.stringify(candidate.safe_aliases)}::jsonb, ${candidate.reason})
        on conflict (space_id, id, version) do update set state = excluded.state`;
    });
    return candidate;
  }

  async get(spaceId: string, id: string, version?: number): Promise<BrowserRecipeCandidate | null> {
    const rows = await this.sql`
      select id, space_id, version, state, schema, steps, safe_aliases, reason
      from browser_recipe_candidate where space_id = ${spaceId} and id = ${id}
        and (${version ?? null}::integer is null or version = ${version ?? null})
      order by version desc limit 1`;
    return rows[0] ? validateBrowserRecipeCandidate(rows[0]) : null;
  }

  async list(spaceId: string, state?: RecipeState): Promise<BrowserRecipeCandidate[]> {
    const rows = await this.sql`
      select id, space_id, version, state, schema, steps, safe_aliases, reason
      from browser_recipe_candidate where space_id = ${spaceId}
        and (${state ?? null}::text is null or state = ${state ?? null})
      order by id, version desc limit 100`;
    return rows.map(validateBrowserRecipeCandidate);
  }
}
