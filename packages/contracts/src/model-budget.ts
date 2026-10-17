/**
 * Context windows for the models Melete knows about.
 *
 * The engine is told this number as `model.context_length`, and it derives its
 * compaction trigger from it, so a wrong entry here is not a rounding error: too
 * small and the engine compacts a conversation that still fits, too large and it
 * never compacts before the provider refuses the request. Entries are keyed on
 * the exact model id a provider answers to, because that is the string both the
 * gateway and the engine see. A Claude id with a snapshot date or a router's or
 * Bedrock's prefix and version is looked up under its plain name (see catalogKey).
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
  // Anthropic's current models, as its Messages API names them. Unlisted, a
  // Claude model fell back to 128,000, below the 128,000-token output cap the
  // engine asks of every current Claude model, so every call was refused.
  'claude-fable-5-1': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-opus-5-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-5-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-5-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
};

/** The window a model answers with, or the documented fallback. */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * The largest model request body the gateway reads. It is a memory bound on the
 * broker, not a statement about any model, and it is the last thing standing
 * between a runaway history and the upstream provider — so the engine has to be
 * told to compact well before a request reaches it.
 *
 * Four MiB, so that for a million-token model the body is never what decides
 * when to compact. With the screenshot reserve set aside it still leaves room
 * for about 760,000 tokens of text, above the engine's own trigger for any
 * window the catalog names (half of a million) and above the owner's cap, so the
 * trigger follows the model's real window and that cap. At one MiB the reserve
 * left a model that reads images only 131,072 tokens, well below both.
 */
export const GATEWAY_MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * Tokens the gateway charges every model request for framing, on top of its
 * estimate of the body. An input limit no larger than this admits no request.
 */
export const REQUEST_FRAMING_TOKENS = 256;

export function modelContextWindow(model: string): number {
  const key = catalogKey(model);
  const named = key === undefined ? undefined : CONTEXT_WINDOWS[key];
  return typeof named === 'number' ? named : FALLBACK_CONTEXT_WINDOW;
}

/**
 * The catalog entry a model id names: the id itself, or, for a Claude model, the id with the
 * spellings other routes add taken off. Anthropic answers to a dated snapshot
 * (`claude-haiku-4-5-20251001`), Vertex to one after an at sign (`claude-opus-4-8@20260101`),
 * a router to `anthropic/claude-opus-5-5`, and Bedrock to
 * `us.anthropic.claude-sonnet-5-5-v1:0`. Each is the same model and the same window.
 */
function catalogKey(model: string): string | undefined {
  if (Object.hasOwn(CONTEXT_WINDOWS, model)) return model;
  const claude = model
    .replace(/^(?:[a-z]{2,6}\.)?anthropic[./]/i, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/[-@]\d{8}$/, '');
  return claude !== model && claude.startsWith('claude-') && Object.hasOwn(CONTEXT_WINDOWS, claude)
    ? claude
    : undefined;
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
  return catalogKey(model) !== undefined;
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
