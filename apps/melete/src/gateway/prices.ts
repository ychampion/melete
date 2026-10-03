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
 *
 * Input a provider read from its prompt cache, or wrote to it, is charged at
 * its own price. An entry that names none takes its provider's published share
 * of the input price (`CACHE_PRICE_SHARE`); a provider not listed there, an
 * operator's own endpoint included, is assumed to give no discount.
 */
import { z } from 'zod';

export type ModelPrice = {
  /** Dollars per million input tokens that were not read from a cache. */
  input: number;
  /** Dollars per million output tokens. */
  output: number;
  /** Dollars per million cached input tokens. Left out, the provider's share of `input`. */
  cached_input?: number;
  /** Dollars per million input tokens written to the cache. Left out, the provider's share of `input`. */
  cache_write_input?: number;
};

/**
 * What a provider charges for input read from, or written to, its prompt cache,
 * as a share of its ordinary input price: Anthropic a tenth for a read and a
 * quarter more for a five-minute write; OpenAI's current models, and the
 * ChatGPT plan served the same way, a tenth; Gemini a tenth. Fireworks prices
 * each model's cached input on its own, from a fiftieth to a fifth of its input
 * price; its share is the highest of those, so a model priced by share is never
 * undercharged, and the default model carries its own listed price below.
 */
export const CACHE_PRICE_SHARE: Readonly<Record<string, { read: number; write: number }>> = {
  anthropic: { read: 0.1, write: 1.25 },
  openai: { read: 0.1, write: 1 },
  chatgpt: { read: 0.1, write: 1 },
  fireworks: { read: 0.2, write: 1 },
  google: { read: 0.1, write: 1 },
};

const NO_DISCOUNT = { read: 1, write: 1 } as const;

const shareOf = (provider: string) =>
  Object.hasOwn(CACHE_PRICE_SHARE, provider)
    ? (CACHE_PRICE_SHARE[provider] ?? NO_DISCOUNT)
    : NO_DISCOUNT;

/** The token counts a call's cost and charged input are read from. */
export type PricedUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
};

/** The input split into what was read from the cache, written to it, and neither. */
function split(usage: PricedUsage) {
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const written = Math.min(usage.cacheWriteInputTokens ?? 0, usage.inputTokens - cached);
  return { cached, written, fresh: usage.inputTokens - cached - written };
}

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
  // The default model, at its listed price: cached input at a fiftieth.
  'fireworks/*deepseek-v4p1-flash*': { input: 0.3, output: 1.2, cached_input: 0.006 },
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
  'google/*': { input: 1.25, output: 10, cached_input: 0.125 },
  'google/*flash*': { input: 0.3, output: 2.5, cached_input: 0.03 },
  'google/*flash-lite*': { input: 0.1, output: 0.4, cached_input: 0.01 },
};

const priceSchema = z
  .object({
    input: z.number().nonnegative().finite(),
    output: z.number().nonnegative().finite(),
    cached_input: z.number().nonnegative().finite().optional(),
    cache_write_input: z.number().nonnegative().finite().optional(),
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

  /** The operator's own price for a model, if MELETE_MODEL_PRICES names one. */
  operatorPrice(provider: string, model: string): ModelPrice | null {
    const key = `${provider}/${model}`;
    for (const [pattern, price] of this.operator) if (matches(pattern, key)) return price;
    return null;
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

  /** Dollars per million tokens for a cache read and a cache write of this model. */
  private cachePrices(provider: string, price: ModelPrice): { read: number; write: number } {
    const share = shareOf(provider);
    return {
      read: price.cached_input ?? price.input * share.read,
      write: price.cache_write_input ?? price.input * share.write,
    };
  }

  /**
   * Dollars one call cost. `inputTokens` includes any cached input, as the
   * gateway records it; the cached part is charged at the cached price and a
   * cache write at the write price.
   */
  cost(provider: string, model: string, usage: PricedUsage): number {
    const price = this.priceFor(provider, model);
    const cache = this.cachePrices(provider, price);
    const { cached, written, fresh } = split(usage);
    const dollars =
      (fresh * price.input +
        cached * cache.read +
        written * cache.write +
        usage.outputTokens * price.output) /
      1_000_000;
    // Kept to the micro-dollar the ledger stores.
    return Math.round(dollars * 1_000_000) / 1_000_000;
  }

  /**
   * The input one call is charged for in full-price-equivalent tokens, from the
   * same prices as its cost: cached input at its cached price, a cache write at
   * its write price, the rest at full price. A model priced at nothing (a plan
   * or the scripted provider) takes its provider's share. Rounded up, so a call
   * with any input is never charged nothing.
   */
  chargedInputTokens(provider: string, model: string, usage: PricedUsage): number {
    const price = this.priceFor(provider, model);
    const share =
      price.input > 0
        ? (() => {
            const cache = this.cachePrices(provider, price);
            return { read: cache.read / price.input, write: cache.write / price.input };
          })()
        : shareOf(provider);
    const { cached, written, fresh } = split(usage);
    return Math.ceil(fresh + cached * share.read + written * share.write);
  }
}
