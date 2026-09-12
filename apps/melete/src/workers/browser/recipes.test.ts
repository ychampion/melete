import { describe, expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import {
  type BrowserRecipeCandidate,
  BrowserRecipeFault,
  MemoryBrowserRecipeStore,
  matchRecipe,
  PostgresBrowserRecipeStore,
  type RecipeStep,
  type VisibleSchema,
  validateBrowserRecipeCandidate,
} from './recipes.ts';

const schema: VisibleSchema = [
  { label: 'Name', role: 'textbox', required: true, sensitive: false },
  { label: 'Email', role: 'textbox', required: true, sensitive: false },
  { label: 'Topic', role: 'combobox', required: false, sensitive: false },
  { label: 'Save', role: 'button', required: false, sensitive: false },
];
const steps: RecipeStep[] = [
  { action: 'fill', label: 'Name', value_key: 'name' },
  { action: 'fill', label: 'Email', value_key: 'email' },
  { action: 'select', label: 'Topic', value_key: 'topic' },
  { action: 'submit', role: 'button', name: 'Save' },
];
function recipe(overrides: Partial<BrowserRecipeCandidate> = {}): BrowserRecipeCandidate {
  return structuredClone({
    id: 'recipe_contact',
    space_id: 'space_personal',
    version: 1,
    state: 'validated',
    schema,
    steps,
    safe_aliases: { Name: 'Full name' },
    reason: 'recorded',
    ...overrides,
  });
}

describe('checked browser recipes', () => {
  test('reordered controls reuse the checked semantic steps without mutating the recipe', () => {
    const baseline = recipe();
    const reordered = [...schema].reverse();
    const result = matchRecipe(baseline, reordered);
    expect(result).toEqual({
      disposition: 'reuse',
      reason: 'matched_schema',
      steps,
      aliases_used: 0,
    });
    expect(baseline.schema).toEqual(schema);
    expect(reordered).toEqual([...schema].reverse());
  });

  test('one explicit safe alias resolves a renamed label and preserves the value key', () => {
    const renamed = schema.map((control) =>
      control.label === 'Name' ? { ...control, label: 'Full name' } : control,
    );
    const result = matchRecipe(recipe(), renamed);
    expect(result.disposition).toBe('reuse');
    expect(result.reason).toBe('safe_alias');
    expect(result.aliases_used).toBe(1);
    expect(result.steps[0]).toEqual({ action: 'fill', label: 'Full name', value_key: 'name' });
    expect(result.steps.slice(1)).toEqual(steps.slice(1));
  });

  test('two safe aliases require observation instead of widening the checked recipe', () => {
    const renamed = schema.map((control) => ({
      ...control,
      label:
        control.label === 'Name'
          ? 'Full name'
          : control.label === 'Email'
            ? 'Email address'
            : control.label,
    }));
    const result = matchRecipe(
      recipe({ safe_aliases: { Name: 'Full name', Email: 'Email address' } }),
      renamed,
    );
    expect(result.disposition).toBe('fallback');
    expect(result.reason).toBe('multiple_aliases');
    expect(result.steps).toEqual([]);
  });

  test('an unknown required field stops before returning any inputs', () => {
    const result = matchRecipe(recipe(), [
      ...schema,
      { label: 'Account number', role: 'textbox', required: true, sensitive: false },
    ]);
    expect(result.disposition).toBe('stop');
    expect(result.reason).toBe('unknown_required_field');
    expect(result.steps).toEqual([]);
  });

  test('two Save controls stop with ambiguous_control and no inputs', () => {
    const result = matchRecipe(recipe(), [
      ...schema,
      { label: 'Save', role: 'button', required: false, sensitive: false },
    ]);
    expect(result.disposition).toBe('stop');
    expect(result.reason).toBe('ambiguous_control');
    expect(result.steps).toEqual([]);
  });

  test('label-only actions cannot silently select one of two roles with the same label', () => {
    const result = matchRecipe(recipe(), [
      ...schema,
      { label: 'Name', role: 'combobox', required: false, sensitive: false },
    ]);
    expect(result.reason).toBe('ambiguous_control');
    expect(result.steps).toEqual([]);
  });

  test('an alias cannot collapse two controls into one semantic target', () => {
    const result = matchRecipe(
      recipe({ safe_aliases: { Name: 'Email' } }),
      schema.filter((control) => control.label !== 'Name'),
    );
    expect(result.reason).toBe('ambiguous_control');
    expect(result.steps).toEqual([]);
  });

  test('a new optional field falls back to observe-per-action', () => {
    const result = matchRecipe(recipe(), [
      ...schema,
      { label: 'Notes', role: 'textbox', required: false, sensitive: false },
    ]);
    expect(result.disposition).toBe('fallback');
    expect(result.reason).toBe('schema_mismatch');
    expect(result.steps).toEqual([]);
  });

  test('a changed required flag cannot reuse the old visible schema', () => {
    const result = matchRecipe(
      recipe(),
      schema.map((control) =>
        control.label === 'Topic' ? { ...control, required: true } : control,
      ),
    );
    expect(result.disposition).toBe('fallback');
    expect(result.reason).toBe('schema_mismatch');
  });

  test('an unknown renamed required label is not inferred to be a safe alias', () => {
    const result = matchRecipe(
      recipe(),
      schema.map((control) =>
        control.label === 'Name' ? { ...control, label: 'Legal name' } : control,
      ),
    );
    expect(result.reason).toBe('unknown_required_field');
    expect(result.steps).toEqual([]);
  });

  test('a missing step target is a mismatch even if the supplied schema is unchanged', () => {
    const result = matchRecipe(
      recipe({ steps: [...steps, { action: 'click', role: 'button', name: 'Next' }] }),
      schema,
    );
    expect(result.reason).toBe('schema_mismatch');
    expect(result.steps).toEqual([]);
  });

  test.each(['candidate', 'rejected', 'superseded'] as const)(
    'state %s cannot reuse a template merely because its schema matches',
    (state) => {
      expect(matchRecipe(recipe({ state }), schema)).toEqual({
        disposition: 'fallback',
        reason: 'recipe_not_checked',
        steps: [],
        aliases_used: 0,
      });
    },
  );

  test('promoted recipes still require the current visible schema', () => {
    expect(matchRecipe(recipe({ state: 'promoted' }), schema).disposition).toBe('reuse');
    expect(matchRecipe(recipe({ state: 'promoted' }), []).reason).toBe('schema_mismatch');
  });
});

describe('recipe persistence boundary', () => {
  test('versions and spaces remain distinct, and callers cannot mutate stored data', async () => {
    const store = new MemoryBrowserRecipeStore();
    const input = recipe();
    const saved = await store.save(input);
    input.steps.splice(0, 1);
    saved.schema.splice(0, 1);
    await store.save(recipe({ version: 2, state: 'candidate', reason: 'schema_mismatch' }));
    expect((await store.get('space_personal', 'recipe_contact', 1))?.steps).toEqual(steps);
    expect((await store.get('space_personal', 'recipe_contact'))?.version).toBe(2);
    expect(await store.get('another_space', 'recipe_contact')).toBeNull();
    expect(await store.list('another_space')).toEqual([]);
    expect((await store.list('space_personal', 'candidate')).map((r) => r.version)).toEqual([2]);
  });

  test('a checked version cannot be silently rewritten with a different submit target', async () => {
    const store = new MemoryBrowserRecipeStore();
    await store.save(recipe());
    const changed = recipe({ steps: [{ action: 'submit', role: 'button', name: 'Purchase' }] });
    await expect(store.save(changed)).rejects.toThrow('recipe_version_conflict');
    expect((await store.get('space_personal', 'recipe_contact'))?.steps).toEqual(steps);
  });

  test('a rejected or superseded version cannot be resurrected', async () => {
    const store = new MemoryBrowserRecipeStore();
    await store.save(recipe({ state: 'candidate' }));
    await store.save(recipe({ state: 'validated' }));
    await store.save(recipe({ state: 'promoted' }));
    await store.save(recipe({ state: 'superseded' }));
    await expect(store.save(recipe({ state: 'promoted' }))).rejects.toThrow(
      'invalid_recipe_transition',
    );
    await store.save(recipe({ version: 2, state: 'rejected' }));
    await expect(store.save(recipe({ version: 2, state: 'validated' }))).rejects.toThrow(
      'invalid_recipe_transition',
    );
  });

  test.each(['Password', 'One-time code', 'OTP', 'Authenticator PIN', 'Verification code'])(
    '%s cannot enter the recipe store even with a false sensitive flag',
    async (label) => {
      const store = new MemoryBrowserRecipeStore();
      const input = recipe({
        schema: [{ label, role: 'textbox', required: true, sensitive: false }],
        steps: [{ action: 'fill', label, value_key: 'field' }],
      });
      await expect(store.save(input)).rejects.toThrow('sensitive_control');
      expect(await store.list('space_personal')).toEqual([]);
      expect(matchRecipe(recipe(), input.schema).reason).toBe('sensitive_control');
    },
  );

  test('controller-marked sensitive fields reject an otherwise innocuous label', async () => {
    const store = new MemoryBrowserRecipeStore();
    const input = recipe({
      schema: [{ label: 'Code', role: 'textbox', required: true, sensitive: true }],
    });
    await expect(store.save(input)).rejects.toThrow('sensitive_control');
    expect(await store.list('space_personal')).toEqual([]);
  });

  test('credential value keys, aliases, and authentication controls are rejected', async () => {
    const store = new MemoryBrowserRecipeStore();
    const rejected = [
      recipe({ steps: [{ action: 'fill', label: 'Code', value_key: 'otp' }] }),
      recipe({ safe_aliases: { Name: 'Password' } }),
      recipe({ steps: [{ action: 'click', role: 'button', name: 'Sign in' }] }),
    ];
    for (const input of rejected) {
      await expect(store.save(input)).rejects.toThrow('sensitive_control');
    }
    expect(await store.list('space_personal')).toEqual([]);
  });

  test('literal values and arbitrary episode text are rejected rather than stripped and saved', async () => {
    const store = new MemoryBrowserRecipeStore();
    for (const input of [
      { ...recipe(), steps: [{ ...steps[0], value: 'do-not-record-this-value' }] },
      { ...recipe(), schema: [{ ...schema[0], value: 'do-not-record-this-value' }] },
      { ...recipe(), episode: 'do-not-record-this-value' },
      { ...recipe(), reason: 'do-not-record-this-value' },
    ]) {
      await expect(store.save(input as BrowserRecipeCandidate)).rejects.toThrow('invalid_recipe');
    }
    expect(await store.list('space_personal')).toEqual([]);
  });

  test('durable store refuses sensitive data before opening a transaction', async () => {
    let transactions = 0;
    const sql = {
      begin: async () => {
        transactions++;
        throw new Error('must not reach the database');
      },
    } as unknown as Sql;
    const store = new PostgresBrowserRecipeStore(sql);
    await expect(
      store.save(recipe({ steps: [{ action: 'fill', label: 'Password', value_key: 'password' }] })),
    ).rejects.toThrow('sensitive_control');
    expect(transactions).toBe(0);
  });

  test('validation errors contain the reason only, never rejected data', () => {
    try {
      validateBrowserRecipeCandidate({ ...recipe(), value: 'do-not-record-this-value' });
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserRecipeFault);
      expect(String(error)).toBe('BrowserRecipeFault: invalid_recipe');
      expect(JSON.stringify(error)).not.toContain('do-not-record-this-value');
    }
  });
});
