/**
 * How hard a reasoning model thinks before it answers, set per role.
 *
 * The agent's own turns default to `medium`; the service's side calls (memory
 * reads, voice asides, the auto-review classifier, the companies scan,
 * learning proposals) default to `low`. MELETE_REASONING_EFFORT_AGENT and
 * MELETE_REASONING_EFFORT_SIDE change them; `off` sends nothing, leaving the
 * provider's own default.
 *
 * The parameter is only ever added: every other field of the request, such
 * as a structured-output `output_config` or `text.format`, is left as it is.
 *
 * The gateway adds the provider's parameter only where the request names no
 * reasoning control of its own (the engine's, or a side call's, always wins),
 * and only for model families that accept it, since a model that does not
 * reason refuses the field:
 *
 * - OpenAI and ChatGPT over responses: `reasoning.effort`.
 * - Chat completions (OpenAI, Fireworks, Google, compatible endpoints):
 *   `reasoning_effort`.
 * - Anthropic: nothing. Extended thinking needs every earlier tool-use turn
 *   of the conversation to carry its thinking blocks, which a history the
 *   engine kept without them does not, so turning it on would refuse turns.
 */
import type { GatewayProtocol } from './types.ts';

export const REASONING_EFFORTS = ['off', 'none', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Model families known to take a reasoning-effort parameter, by provider. */
const REASONS: Record<string, RegExp> = {
  openai: /^(o\d|gpt-5|gpt-6)/i,
  chatgpt: /^(o\d|gpt-5|gpt-6|codex)/i,
  'openai-compatible': /(^|\/)(o\d|gpt-5|gpt-6|gpt-oss|deepseek-r|qwq|qwen3)/i,
  fireworks: /(deepseek|qwen3|gpt-oss|kimi-k2-thinking|glm-4\.[5-9])/i,
  google: /gemini-(2\.5|[3-9])/i,
};

export function acceptsEffort(provider: string, model: string): boolean {
  return REASONS[provider]?.test(model) ?? false;
}

/** Whether the request already says how much to reason, in any protocol's words. */
function namesOwnEffort(body: Record<string, unknown>): boolean {
  const reasoning = body.reasoning;
  return (
    body.reasoning_effort !== undefined ||
    (reasoning !== undefined &&
      (typeof reasoning !== 'object' ||
        reasoning === null ||
        (reasoning as Record<string, unknown>).effort !== undefined)) ||
    body.thinking !== undefined ||
    body.reasoning_budget !== undefined
  );
}

/**
 * How a model takes "think as little as you can": `none` for the newer OpenAI
 * models (GPT-5.1 on, GPT-6), `minimal` for GPT-5, and nothing at all for the
 * o-series and Gemini Pro, which take neither.
 */
function leastEffort(provider: string, model: string): string | null {
  if (/(^|\/)o\d/i.test(model) || /gemini-[\d.]+-pro/i.test(model)) return null;
  if (/(^|\/)gpt-5(?![.\d])/i.test(model) && ['openai', 'chatgpt'].includes(provider))
    return 'minimal';
  return 'none';
}

/** Models that refused the parameter in this process, so they are not asked twice. */
const refused = new Set<string>();
export const effortRefused = (provider: string, model: string) =>
  refused.has(`${provider}/${model}`);
export function refuseEffort(provider: string, model: string): void {
  if (refused.size > 1000) refused.clear();
  refused.add(`${provider}/${model}`);
}

/**
 * The request with the role's effort added, when the model takes it and the
 * request named none. The body is changed in place and returned.
 */
export function withEffort(
  body: Record<string, unknown>,
  input: {
    protocol: GatewayProtocol;
    provider: string;
    model: string;
    effort: ReasoningEffort | undefined;
  },
): Record<string, unknown> {
  const { protocol, provider, model, effort } = input;
  if (!effort || effort === 'off' || namesOwnEffort(body) || !acceptsEffort(provider, model))
    return body;
  const value = effort === 'none' ? leastEffort(provider, model) : effort;
  if (!value) return body;
  if (protocol === 'responses') {
    // Added to whatever else the request already says about reasoning (a
    // summary setting, say); no other field of the request is touched.
    const existing = (body.reasoning ?? {}) as Record<string, unknown>;
    body.reasoning = { ...existing, effort: value };
  } else if (protocol === 'chat/completions') body.reasoning_effort = value;
  return body;
}
