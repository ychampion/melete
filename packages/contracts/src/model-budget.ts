/**
 * Context windows for the models Melete knows about.
 *
 * The engine is told this number as `model.context_length`, and it derives its
 * compaction trigger from it, so a wrong entry here is not a rounding error: too
 * small and the engine compacts a conversation that still fits, too large and it
 * never compacts before the provider refuses the request. Entries are keyed on
 * the exact model id a provider answers to, because that is the string both the
 * gateway and the engine see.
 *
 * A model with no entry falls back to 128,000 tokens, the smallest window in
 * common use among the providers Melete talks to. The fallback is deliberately
 * conservative: an unknown model is compacted early rather than refused late.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  // Fireworks and Hugging Face spellings of the same weights.
  'accounts/fireworks/models/deepseek-v4p1-flash': 1_000_000,
  'deepseek-ai/DeepSeek-V4.1-Flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
  'deepseek-v4-flash': 1_000_000,
  'gpt-6-astra': 1_050_000,
};

/** The window a model answers with, or the documented fallback. */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

export function modelContextWindow(model: string): number {
  return CONTEXT_WINDOWS[model] ?? FALLBACK_CONTEXT_WINDOW;
}

/** True when the catalog names this model rather than falling back. */
export function hasKnownContextWindow(model: string): boolean {
  return model in CONTEXT_WINDOWS;
}

/** Context is a per-request allowance. Output remains a separate cumulative ceiling. */
export function inputTokenAllowance(
  model: string,
  budget: { max_output_tokens: number; max_input_tokens?: number },
): number {
  const available = Math.max(0, modelContextWindow(model) - budget.max_output_tokens);
  return Math.min(available, budget.max_input_tokens ?? available);
}
