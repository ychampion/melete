import type { JsonObject } from '@melete/contracts';
import {
  type BrowserRecipeCandidate,
  BrowserRecipeFault,
  type BrowserRecipeStore,
  matchRecipe,
  type RecipeMatch,
  type VisibleSchema,
} from './recipes.ts';

export type BrowserRecipePlan = {
  disposition: 'reuse' | 'fallback' | 'stop';
  reason: string;
  steps: RecipeMatch['steps'];
  aliases_used: number;
  repair_candidate?: { id: string; version: number; state: 'candidate' };
};

const needsRepair = new Set([
  'schema_mismatch',
  'multiple_aliases',
  'unknown_required_field',
  'ambiguous_control',
]);
const sameRepair = (candidate: BrowserRecipeCandidate, next: BrowserRecipeCandidate) =>
  candidate.state === 'candidate' &&
  JSON.stringify({ ...candidate, version: 0 }) === JSON.stringify({ ...next, version: 0 });

/** Only stored, space-scoped versions can supply steps. The worker supplies the current schema. */
export async function planBrowserRecipe(
  store: BrowserRecipeStore,
  spaceId: string,
  recipeId: string,
  version: number,
  currentSchema: unknown,
): Promise<BrowserRecipePlan> {
  const recipe = await store.get(spaceId, recipeId, version);
  if (!recipe)
    return { disposition: 'stop', reason: 'recipe_not_found', steps: [], aliases_used: 0 };
  const match = matchRecipe(recipe, currentSchema as VisibleSchema);
  if (!needsRepair.has(match.reason)) return match;
  // The store rejects literal input values and sensitive controls before any write. Conflicting
  // concurrent observations get another immutable version, never an overwrite of the first one.
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await store.get(spaceId, recipeId);
    const candidate: BrowserRecipeCandidate = {
      ...recipe,
      version: (latest?.version ?? recipe.version) + 1,
      state: 'candidate',
      schema: currentSchema as VisibleSchema,
      reason: match.reason,
    };
    if (latest && sameRepair(latest, candidate))
      return {
        ...match,
        repair_candidate: { id: latest.id, version: latest.version, state: 'candidate' },
      };
    try {
      const saved = await store.save(candidate);
      return {
        ...match,
        repair_candidate: { id: saved.id, version: saved.version, state: 'candidate' },
      };
    } catch (error) {
      if (!(error instanceof BrowserRecipeFault) || error.reason !== 'recipe_version_conflict')
        throw error;
    }
  }
  return { disposition: 'stop', reason: 'recipe_store_busy', steps: [], aliases_used: 0 };
}

export function recipePlanDetail(plan: BrowserRecipePlan): JsonObject {
  return { ...plan };
}
