/** Context windows from the pinned Hermes model metadata; unknown models use its 128k fallback. */
export function modelContextWindow(model: string): number {
  if (model === 'gpt-6-astra') return 1_050_000;
  if (['deepseek-v4-pro', 'deepseek-v4-flash'].includes(model)) return 1_000_000;
  return 128_000;
}

/** Context is a per-request allowance. Output remains a separate cumulative ceiling. */
export function inputTokenAllowance(
  model: string,
  budget: { max_output_tokens: number; max_input_tokens?: number },
): number {
  const available = Math.max(0, modelContextWindow(model) - budget.max_output_tokens);
  return Math.min(available, budget.max_input_tokens ?? available);
}
