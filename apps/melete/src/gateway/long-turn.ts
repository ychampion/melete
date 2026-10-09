/**
 * A conversation turn that has become long work is pointed at background work.
 *
 * Asked for research "in the background", a model read page after page in the
 * conversation itself: the person waited with nothing to show, and a step that
 * needed their approval held the whole conversation. The tool's description
 * and the instructions say when to start background work; this is the
 * deterministic backstop. Once one turn of a conversation that is offered
 * `run.start` has made `LONG_TURN_ROUNDS` rounds of tool calls without
 * starting any, the request carries one closing note saying so. It is read
 * from the request alone, the conversation's own record is not changed, and a
 * turn that stays short never sees it.
 */
import type { GatewayProtocol } from './types.ts';

/** Rounds of tool calls in one turn before it is pointed at background work. */
export const LONG_TURN_ROUNDS = 6;

export const LONG_TURN_NOTE =
  'This reply has already taken many steps. If what the person asked for is research across several sources, a comparison, or anything that needs more steps, start it now with run.start (it keeps working and reports back), then tell them in one sentence and end your reply. Otherwise answer now with what you have.';

const START = 'run.start';

const toolName = (tool: unknown): string | undefined => {
  if (!tool || typeof tool !== 'object') return undefined;
  const fn = (tool as { function?: { name?: unknown } }).function;
  return typeof fn?.name === 'string' ? fn.name : undefined;
};

/** The request, with the note added when its turn has run long; otherwise the same body. */
export function withLongTurnNote(
  body: Record<string, unknown>,
  protocol: GatewayProtocol,
): Record<string, unknown> {
  if (protocol !== 'chat/completions') return body;
  const { messages, tools } = body;
  if (!Array.isArray(messages) || !Array.isArray(tools)) return body;
  if (!tools.some((tool) => toolName(tool) === START)) return body;
  let from = 0;
  messages.forEach((message, index) => {
    if (message && typeof message === 'object' && (message as { role?: unknown }).role === 'user')
      from = index + 1;
  });
  let rounds = 0;
  for (const message of messages.slice(from)) {
    if (!message || typeof message !== 'object') continue;
    const calls = (message as { role?: unknown; tool_calls?: unknown }).tool_calls;
    if ((message as { role?: unknown }).role !== 'assistant' || !Array.isArray(calls)) continue;
    if (!calls.length) continue;
    if (calls.some((call) => toolName(call) === START)) return body;
    rounds++;
  }
  if (rounds < LONG_TURN_ROUNDS) return body;
  return { ...body, messages: [...messages, { role: 'system', content: LONG_TURN_NOTE }] };
}
