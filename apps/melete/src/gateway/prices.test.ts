import { expect, test } from 'bun:test';
import { PriceTable, parseModelPrices } from './prices.ts';

const usage = (inputTokens: number, outputTokens = 0, cachedInputTokens = 0) => ({
  inputTokens,
  outputTokens,
  cachedInputTokens,
});

test('Haiku 5.5 is charged five times as much for a prompt above 100,000 tokens', () => {
  const prices = new PriceTable();
  const model = 'claude-haiku-5-5';
  // At or under the line: $0.10 in, $0.50 out per million.
  expect(prices.cost('anthropic', model, usage(100_000, 1_000_000))).toBeCloseTo(0.01 + 0.5, 6);
  // Above it, the whole call at $0.50 in, $2.50 out.
  expect(prices.cost('anthropic', model, usage(100_001, 1_000_000))).toBeCloseTo(
    (100_001 * 0.5) / 1_000_000 + 2.5,
    5,
  );
  // Cached input is a tenth of the long price, $0.05.
  expect(prices.cost('anthropic', model, usage(200_000, 0, 200_000))).toBeCloseTo(0.01, 6);
  // The cost a cap counts never falls when the prompt grows.
  let last = 0;
  for (const tokens of [99_999, 100_000, 100_001, 150_000]) {
    const cost = prices.cost('anthropic', model, usage(tokens, 4_000));
    expect(cost).toBeGreaterThanOrEqual(last);
    last = cost;
  }
  // A cached read is still charged as a tenth of full-price input.
  expect(prices.chargedInputTokens('anthropic', model, usage(200_000, 0, 100_000))).toBe(110_000);
});

test('each Claude model is charged its own list price, and an unlisted one the highest', () => {
  const prices = new PriceTable();
  const listed: [string, number, number, number][] = [
    ['claude-fable-5-1', 10, 50, 0.25],
    ['claude-mythos-5-1', 10, 50, 0.25],
    ['claude-fable-5', 10, 50, 1],
    ['claude-mythos-5', 10, 50, 1],
    ['claude-opus-5-5', 4, 20, 0.2],
    ['claude-opus-5', 5, 25, 0.5],
    ['claude-opus-4-8', 5, 25, 0.5],
    ['claude-opus-4-7', 5, 25, 0.5],
    ['claude-opus-4-6', 5, 25, 0.5],
    ['claude-opus-4-5-20251101', 5, 25, 0.5],
    ['claude-opus-4-1-20250805', 15, 75, 1.5],
    ['claude-opus-4-20250514', 15, 75, 1.5],
    ['claude-sonnet-5-5', 2, 10, 0.2],
    ['claude-sonnet-5', 2, 10, 0.2],
    ['claude-sonnet-4-6', 3, 15, 0.3],
    ['claude-sonnet-4-5-20250929', 3, 15, 0.3],
    ['claude-haiku-5-5', 0.1, 0.5, 0.01],
    ['claude-haiku-4-5', 1, 5, 0.1],
    // A Claude model this table has never heard of.
    ['claude-new-tier-9', 10, 50, 1],
  ];
  for (const [model, input, output, cached] of listed) {
    const price = prices.priceFor('anthropic', model);
    expect([model, price.input, price.output, price.cached_input]).toEqual([
      model,
      input,
      output,
      cached,
    ]);
  }
});

test('an operator price may name a long-prompt price of its own', () => {
  const overrides = parseModelPrices(
    JSON.stringify({
      'openai/x': { input: 1, output: 2, long_prompt: { above: 1_000, input: 3, output: 4 } },
    }),
  );
  const prices = new PriceTable(overrides);
  expect(prices.cost('openai', 'x', usage(1_000, 1_000_000))).toBeCloseTo(0.001 + 2, 6);
  expect(prices.cost('openai', 'x', usage(1_001, 1_000_000))).toBeCloseTo(0.003003 + 4, 6);
  expect(() =>
    parseModelPrices(JSON.stringify({ 'openai/x': { input: 1, output: 2, long_prompt: {} } })),
  ).toThrow('MELETE_MODEL_PRICES');
});
