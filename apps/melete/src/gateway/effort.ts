/**
 * How hard a reasoning model thinks before it answers, set per role.
 *
 * The agent's own turns default to `medium`, one step less on a brief turn
 * (`BRIEF_TURN_CHARS`) until its tool loop is multi-step, and one step more when
 * the person asks for depth or the loop's latest tools failed (`turnEffort`);
 * the service's side calls (memory
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

/**
 * A person's message at most this long, a line or two, is answered thinking
 * one step less than the agent's effort: `medium` becomes `low`. Measured on
 * DeepSeek V4.1 Flash, `medium` spent 400 to 1,050 reasoning tokens (5 to 14
 * seconds) on "note that I'm flying to Chicago next Friday" and `low` 350 to
 * 400, choosing the same tools on short requests. A longer, detailed request
 * keeps the full effort.
 */
export const BRIEF_TURN_CHARS = 280;

/**
 * Words a person uses to ask for depth. Such a turn thinks one step more than
 * the agent's effort, however short the message.
 */
const DEPTH =
  /\b(think (hard|harder|carefully|deeply|it through)|in[- ]depth|deep[- ]dive|thoroughly|take your time|detailed analysis)\b/i;

export const asksForDepth = (text: string): boolean => DEPTH.test(text);

/**
 * Tool rounds after which a brief turn's work is multi-step and thinks at the
 * agent's own effort again. A one-search answer (a search, a page or two, then
 * the reply) stays under it.
 */
export const MULTI_STEP_ROUNDS = 4;

/** Failed tool results in a row after which the next call thinks one step more. */
export const FAILING_STREAK = 2;

/** What the turn is, for its effort: its message and the tool loop so far. */
export type TurnShape = {
  /** The person's message is at most `BRIEF_TURN_CHARS`. */
  brief?: boolean;
  /** The person asked for depth (`asksForDepth`). */
  deep?: boolean;
  /** Tool rounds the request already carries. */
  rounds?: number;
  /** The latest tool results failed, `FAILING_STREAK` or more in a row. */
  failing?: boolean;
};

const LADDER = ['none', 'low', 'medium', 'high'] as const;

/**
 * The effort an agent call is made with. Plain chat and writing, which come as
 * brief messages, think one step less than the agent's effort; a brief turn
 * whose tool loop has run `MULTI_STEP_ROUNDS` rounds is multi-step work and
 * thinks at the agent's effort again. Asking for depth, or a loop whose latest
 * tools failed, adds a step, to at most `high`. `off` and an unset effort are
 * left alone.
 */
export function turnEffort(
  effort: ReasoningEffort | undefined,
  turn: boolean | TurnShape,
): ReasoningEffort | undefined {
  const shape = typeof turn === 'boolean' ? { brief: turn } : turn;
  if (effort === undefined || effort === 'off') return effort;
  let step: number = LADDER.indexOf(effort);
  const multiStep = (shape.rounds ?? 0) >= MULTI_STEP_ROUNDS;
  if (shape.deep) step += 1;
  else if (shape.brief && !multiStep && step > 1) step -= 1;
  if (shape.failing) step += 1;
  return LADDER[Math.min(step, LADDER.length - 1)];
}

/** A message's text, written as a string or as text parts. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '',
    )
    .join('');
}

/**
 * Whether one tool result reports a failure: the broker's `failed` or
 * `denied`, an error, or a command that exited non-zero. Anything that is not
 * a JSON object is not counted as one.
 */
export function failedResult(content: unknown): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textOf(content));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const result = parsed as Record<string, unknown>;
  return (
    result.status === 'failed' ||
    result.status === 'denied' ||
    Boolean(result.error) ||
    (typeof result.exit_code === 'number' && result.exit_code !== 0)
  );
}

/**
 * The tool loop a request carries: how many rounds of tool calls the model has
 * made, and whether its latest results failed. Read from the request alone, so
 * it needs no state between calls. Only the protocols effort is sent on.
 */
export function toolLoop(
  body: Record<string, unknown>,
  protocol: GatewayProtocol,
): { rounds: number; failing: boolean } {
  const results: unknown[] = [];
  let rounds = 0;
  if (protocol === 'chat/completions' && Array.isArray(body.messages)) {
    for (const message of body.messages as Record<string, unknown>[]) {
      if (!message || typeof message !== 'object') continue;
      if (
        message.role === 'assistant' &&
        Array.isArray(message.tool_calls) &&
        message.tool_calls.length > 0
      )
        rounds++;
      if (message.role === 'tool') results.push(message.content);
    }
  } else if (protocol === 'responses' && Array.isArray(body.input)) {
    let calling = false;
    for (const item of body.input as Record<string, unknown>[]) {
      if (!item || typeof item !== 'object') continue;
      // Calls made together are one round: count the first of each run.
      if (item.type === 'function_call') {
        if (!calling) rounds++;
        calling = true;
        continue;
      }
      calling = false;
      if (item.type === 'function_call_output') results.push(item.output);
    }
  }
  const latest = results.slice(-FAILING_STREAK);
  return {
    rounds,
    failing: latest.length === FAILING_STREAK && latest.every(failedResult),
  };
}

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
