/**
 * What a model call costs, in US dollars, estimated from the tokens the
 * gateway recorded for it. Spending caps are computed from these estimates.
 *
 * Prices are per million tokens. Each entry is keyed `provider/model`, where
 * the model part may use `*` for any run of characters; the most specific
 * matching entry wins (the one with the most literal characters). The
 * operator's MELETE_MODEL_PRICES entries are matched before the defaults, so a
 * real price for a deployment's models always replaces an estimate here.
 *
 * The defaults are deliberately rounded estimates for the providers Melete
 * serves. A model nothing here names is charged at the conservative `*`
 * entry, so an unknown model never counts as free.
 */
import { z } from 'zod';

export type ModelPrice = {
  /** Dollars per million input tokens that were not read from a cache. */
  input: number;
  /** Dollars per million output tokens. */
  output: number;
  /** Dollars per million cached input tokens. Left out, a tenth of `input`. */
  cached_input?: number;
};

/** Estimates for the configured providers. Override with MELETE_MODEL_PRICES. */
export const DEFAULT_MODEL_PRICES: Record<string, ModelPrice> = {
  // Unknown models: priced high, so a cap is reached early rather than late.
  '*': { input: 3, output: 15 },
  // The scripted provider costs nothing.
  'fake/*': { input: 0, output: 0 },
  // A ChatGPT sign-in draws on the owner's plan; its tokens still count.
  'chatgpt/*': { input: 0, output: 0 },
  'fireworks/*': { input: 0.9, output: 0.9 },
  'fireworks/*flash*': { input: 0.3, output: 1.2 },
  'fireworks/*deepseek*': { input: 0.6, output: 2.2 },
  'fireworks/*qwen*': { input: 0.5, output: 1.5 },
  'fireworks/*llama*': { input: 0.2, output: 0.6 },
  'anthropic/*': { input: 3, output: 15, cached_input: 0.3 },
  'anthropic/*opus*': { input: 15, output: 75, cached_input: 1.5 },
  'anthropic/*sonnet*': { input: 3, output: 15, cached_input: 0.3 },
  'anthropic/*haiku*': { input: 1, output: 5, cached_input: 0.1 },
  'openai/*': { input: 2.5, output: 10, cached_input: 0.25 },
  'openai/*mini*': { input: 0.4, output: 1.6, cached_input: 0.1 },
  'openai/*nano*': { input: 0.1, output: 0.4, cached_input: 0.025 },
  'google/*': { input: 1.25, output: 10, cached_input: 0.3 },
  'google/*flash*': { input: 0.3, output: 2.5, cached_input: 0.075 },
  'google/*flash-lite*': { input: 0.1, output: 0.4, cached_input: 0.025 },
};

const priceSchema = z
  .object({
    input: z.number().nonnegative().finite(),
    output: z.number().nonnegative().finite(),
    cached_input: z.number().nonnegative().finite().optional(),
  })
  .strict();

/** Reads MELETE_MODEL_PRICES: a JSON object of `provider/model` keys to prices. */
export function parseModelPrices(value: string | undefined): Record<string, ModelPrice> {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      'MELETE_MODEL_PRICES must be a JSON object, for example {"fireworks/accounts/fireworks/models/x":{"input":0.5,"output":1.5}}',
    );
  }
  const result = z.record(z.string().min(1).max(400), priceSchema).safeParse(parsed);
  if (!result.success)
    throw new Error(
      'MELETE_MODEL_PRICES entries are "provider/model": {"input": dollars, "output": dollars, "cached_input"?: dollars} per million tokens',
    );
  return result.data;
}

function matches(pattern: string, key: string): boolean {
  if (!pattern.includes('*')) return pattern === key;
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}$`, 'i').test(key);
}

const specificity = (pattern: string) => pattern.replaceAll('*', '').length;

export class PriceTable {
  private readonly operator: [string, ModelPrice][];
  private readonly defaults: [string, ModelPrice][];

  constructor(overrides: Record<string, ModelPrice> = {}) {
    const ordered = (entries: Record<string, ModelPrice>) =>
      Object.entries(entries).sort(([a], [b]) => specificity(b) - specificity(a));
    this.operator = ordered(overrides);
    this.defaults = ordered(DEFAULT_MODEL_PRICES);
  }

  /** The price that applies to one model, and the entry it came from. */
  priceFor(provider: string, model: string): ModelPrice & { entry: string } {
    const key = `${provider}/${model}`;
    for (const list of [this.operator, this.defaults])
      for (const [pattern, price] of list)
        if (matches(pattern, key)) return { ...price, entry: pattern };
    const fallback = DEFAULT_MODEL_PRICES['*'] as ModelPrice;
    return { ...fallback, entry: '*' };
  }

  /**
   * Dollars one call cost. `inputTokens` includes any cached input, as the
   * gateway records it; the cached part is charged at the cached price.
   */
  cost(
    provider: string,
    model: string,
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
  ): number {
    const price = this.priceFor(provider, model);
    const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
    const fresh = usage.inputTokens - cached;
    const cachedPrice = price.cached_input ?? price.input / 10;
    const dollars =
      (fresh * price.input + cached * cachedPrice + usage.outputTokens * price.output) / 1_000_000;
    // Kept to the micro-dollar the ledger stores.
    return Math.round(dollars * 1_000_000) / 1_000_000;
  }
}
