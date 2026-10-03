/**
 * How much of a model's window each part of an attempt's context may take.
 *
 * The thin-harness numbers in `CONTEXT_LIMITS` were set for the smallest window
 * in common use, 128,000 tokens, and they stay exactly that for such a model and
 * for any model the catalog does not name. A larger window scales each budget by
 * the same share of the window it has at 128,000 tokens, up to a cap: the caps
 * are what a person's allowance can carry on every turn, and they keep the whole
 * first request well inside the engine's compaction trigger. Past these budgets
 * the engine's own compaction takes over, inside the attempt.
 *
 * The identity and each skill body keep fixed sizes: they are authored to those
 * caps, and a bigger window is no reason to accept a longer one.
 */
import { modelContextWindow } from './model-budget.ts';
import { CONTEXT_LIMITS } from './runtime.ts';

/** The window the thin-harness numbers were set for. */
export const BASELINE_CONTEXT_WINDOW = 128_000;

/**
 * The transcript bound at the baseline window, in tokens. 32,000 characters of
 * serialized transcript at the engine's four characters to the token.
 */
export const BASELINE_TRANSCRIPT_TOKENS = 8_000;

/** Messages the transcript may carry at the baseline window. */
export const BASELINE_TRANSCRIPT_MESSAGES = 100;

/** The engine's own estimate, and the gateway's: four characters to the token. */
export const CONTEXT_CHARS_PER_TOKEN = 4;

/**
 * The most each budget may grow to, whatever the window. A 1,000,000-token model
 * reaches every cap except the core catalog's, which it nearly reaches.
 */
export const CONTEXT_BUDGET_CAPS = {
  max_skills: 6,
  knowledge_tokens: 8_000,
  max_tools: 64,
  core_catalog_tokens: 8_000,
  catalog_index_tokens: 1_000,
  skill_index_tokens: 2_000,
  transcript_tokens: 64_000,
  transcript_messages: 800,
} as const;

export type ContextBudget = {
  /** The window these budgets were derived from. */
  window: number;
  identity_tokens: number;
  max_skills: number;
  skill_tokens: number;
  knowledge_tokens: number;
  max_tools: number;
  /** Serialized schemas in the first catalog, the two discovery tools included. */
  core_catalog_tokens: number;
  /** The names-only listing of tools left outside that catalog. */
  catalog_index_tokens: number;
  /** The skill index: names and one-line descriptions of the skills not given in full. */
  skill_index_tokens: number;
  /** The prior conversation and tool results carried into a new attempt. */
  transcript_tokens: number;
  transcript_messages: number;
};

/**
 * The budgets for a window. A window at or below the baseline gets the baseline
 * numbers; above it each budget grows in proportion, rounded down, to its cap.
 */
export function contextBudgetForWindow(window: number): ContextBudget {
  const usable = Number.isFinite(window) && window > 0 ? window : BASELINE_CONTEXT_WINDOW;
  const share = Math.max(1, usable / BASELINE_CONTEXT_WINDOW);
  const scale = (baseline: number, cap: number) =>
    Math.max(baseline, Math.min(cap, Math.floor(baseline * share)));
  return {
    window: usable,
    identity_tokens: CONTEXT_LIMITS.identity_tokens,
    max_skills: scale(CONTEXT_LIMITS.max_skills, CONTEXT_BUDGET_CAPS.max_skills),
    skill_tokens: CONTEXT_LIMITS.skill_tokens,
    knowledge_tokens: scale(CONTEXT_LIMITS.knowledge_tokens, CONTEXT_BUDGET_CAPS.knowledge_tokens),
    max_tools: scale(CONTEXT_LIMITS.max_tools, CONTEXT_BUDGET_CAPS.max_tools),
    core_catalog_tokens: scale(
      CONTEXT_LIMITS.core_catalog_tokens,
      CONTEXT_BUDGET_CAPS.core_catalog_tokens,
    ),
    catalog_index_tokens: scale(
      CONTEXT_LIMITS.catalog_index_tokens,
      CONTEXT_BUDGET_CAPS.catalog_index_tokens,
    ),
    skill_index_tokens: scale(
      CONTEXT_LIMITS.skill_index_tokens,
      CONTEXT_BUDGET_CAPS.skill_index_tokens,
    ),
    transcript_tokens: scale(BASELINE_TRANSCRIPT_TOKENS, CONTEXT_BUDGET_CAPS.transcript_tokens),
    transcript_messages: scale(
      BASELINE_TRANSCRIPT_MESSAGES,
      CONTEXT_BUDGET_CAPS.transcript_messages,
    ),
  };
}

/** The limits beyond the catalog window that bound one attempt's context. */
export type ContextBudgetLimits = {
  /** The job's own per-request input ceiling (`budget.max_input_tokens`). */
  maxInputTokens?: number;
  /** The window the operator states for this deployment's models (`MELETE_MODEL_CONTEXT_WINDOW`). */
  statedWindow?: number;
  /** The engine's compaction trigger, in tokens, for this attempt. */
  compactionTokens?: number;
};

/**
 * The share of the engine's compaction trigger the transcript may fill. The
 * rest is the tool definitions, the instructions, recalled knowledge and the
 * reply, so the first request of an attempt never starts at the trigger.
 */
export const TRANSCRIPT_COMPACTION_SHARE = 0.4;

const below = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : Number.POSITIVE_INFINITY;

/**
 * The budgets for a model. They scale with the smallest of the window the
 * catalog gives it, the window the operator states, and the job's own input
 * ceiling, so a narrower limit is never exceeded by a budget sized for a wider
 * one. The transcript is further held to a share of the engine's compaction
 * trigger. No limit takes a budget below the baseline every model had before.
 */
export function contextBudget(model: string, limits: ContextBudgetLimits = {}): ContextBudget {
  const window = Math.min(
    modelContextWindow(model),
    below(limits.statedWindow),
    below(limits.maxInputTokens),
  );
  const budget = contextBudgetForWindow(window);
  const compaction = below(limits.compactionTokens);
  if (Number.isFinite(compaction)) {
    budget.transcript_tokens = Math.min(
      budget.transcript_tokens,
      Math.max(BASELINE_TRANSCRIPT_TOKENS, Math.floor(compaction * TRANSCRIPT_COMPACTION_SHARE)),
    );
  }
  return budget;
}

/** The baseline: what a 128,000-token model, or one the catalog does not name, gets. */
export const BASELINE_CONTEXT_BUDGET: ContextBudget =
  contextBudgetForWindow(BASELINE_CONTEXT_WINDOW);
