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

/**
 * The largest model request body the gateway reads. It is a memory bound on the
 * broker, not a statement about any model, and it is the last thing standing
 * between a runaway history and the upstream provider — so the engine has to be
 * told to compact well before a request reaches it.
 */
export const GATEWAY_MAX_REQUEST_BYTES = 1024 * 1024;

export function modelContextWindow(model: string): number {
  const named = hasKnownContextWindow(model) ? CONTEXT_WINDOWS[model] : undefined;
  return typeof named === 'number' ? named : FALLBACK_CONTEXT_WINDOW;
}

/**
 * True when the catalog names this model rather than falling back.
 *
 * The question is whether the catalog names the model, not whether a lookup
 * answers: every object inherits `constructor`, `toString` and their
 * neighbours, so a model id spelled like one of those would otherwise answer
 * with a function. That function reaches the arithmetic below as NaN, and no
 * comparison is greater than NaN, so the input-context refusal would stop
 * firing rather than fail closed.
 */
export function hasKnownContextWindow(model: string): boolean {
  return Object.hasOwn(CONTEXT_WINDOWS, model);
}

/**
 * The most input any one request to this model may carry before that request's
 * own output is set aside: the window, narrowed by an explicit input limit. It
 * is what an attempt can be told before any request exists.
 */
export function inputTokenCeiling(model: string, limits: { max_input_tokens?: number }): number {
  const window = modelContextWindow(model);
  return Math.min(window, limits.max_input_tokens ?? window);
}

/**
 * The input one request may carry: the window less the output that request asks
 * for, narrowed by an explicit input limit.
 *
 * The output set aside is the request's own cap, never the job's output budget.
 * That budget is spent across every request in the job and is bounded where it
 * is reserved; subtracting it here as well shrank every request's input by the
 * whole job's output, and a budget at or above the window left no room at all.
 */
export function inputTokenAllowance(
  model: string,
  requestOutputTokens: number,
  limits: { max_input_tokens?: number } = {},
): number {
  const available = Math.max(0, modelContextWindow(model) - requestOutputTokens);
  return Math.min(available, limits.max_input_tokens ?? available);
}
