/**
 * A conversation turn that has become long work is pointed at background work,
 * and one that has gone several steps without a word is asked for an update.
 *
 * Asked for research "in the background", a model read page after page in the
 * conversation itself: the person waited with nothing to show, and a step that
 * needed their approval held the whole conversation. The tool's description
 * and the instructions say when to start background work; this is the
 * deterministic backstop. Once one turn of a conversation that is offered
 * `run.start` has made `LONG_TURN_ROUNDS` rounds of tool calls without
 * starting any, the request carries one closing note saying so.
 *
 * Before that, a turn that has made `PROGRESS_ROUNDS` rounds of tool calls
 * with nothing said to the person (no words of its own, no `say`) carries one
 * line asking for a specific update. Only a conversation's own agent is offered
 * `say`, so a helper or background work is never asked. A request carries at
 * most one of the two notes; the closing note already asks for an answer.
 *
 * Both are read from the request alone, the conversation's own record is not
 * changed, and a turn that stays short and talks as it goes never sees either.
 */
import type { GatewayProtocol } from './types.ts';

/** Rounds of tool calls in one turn before it is pointed at background work. */
export const LONG_TURN_ROUNDS = 6;

export const LONG_TURN_NOTE =
  'This reply has already taken many steps. If what the person asked for is research across several sources, a comparison, or anything that needs more steps, start it now with run.start (it keeps working and reports back), then tell them in one sentence and end your reply. Otherwise answer now with what you have.';

/** Rounds of tool calls with nothing said to the person before they are given an update. */
export const PROGRESS_ROUNDS = 5;

export const PROGRESS_NOTE =
  'You have taken several steps without telling the person anything. Before your next step, tell them in one specific sentence what you have found or done so far and what you are doing next.';

const START = 'run.start';
const SAY = 'say';

const toolName = (tool: unknown): string | undefined => {
  if (!tool || typeof tool !== 'object') return undefined;
  const fn = (tool as { function?: { name?: unknown } }).function;
  return typeof fn?.name === 'string' ? fn.name : undefined;
};

/** Words the model wrote to the person in this message, outside its tool calls. */
const spoke = (content: unknown): boolean => {
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== 'object') return false;
    const { type, text } = part as { type?: unknown; text?: unknown };
    return type === 'text' && typeof text === 'string' && text.trim().length > 0;
  });
};

/** The request, with a note added when its turn has run long or gone quiet; otherwise the same body. */
export function withLongTurnNote(
  body: Record<string, unknown>,
  protocol: GatewayProtocol,
): Record<string, unknown> {
  if (protocol !== 'chat/completions') return body;
  const { messages, tools } = body;
  if (!Array.isArray(messages) || !Array.isArray(tools)) return body;
  const offers = (name: string) => tools.some((tool) => toolName(tool) === name);
  const background = offers(START);
  const narrated = offers(SAY);
  if (!background && !narrated) return body;
  let from = 0;
  messages.forEach((message, index) => {
    if (message && typeof message === 'object' && (message as { role?: unknown }).role === 'user')
      from = index + 1;
  });
  let rounds = 0;
  // Rounds since the person was last told anything.
  let quiet = 0;
  for (const message of messages.slice(from)) {
    if (!message || typeof message !== 'object') continue;
    const {
      role,
      tool_calls: calls,
      content,
    } = message as {
      role?: unknown;
      tool_calls?: unknown;
      content?: unknown;
    };
    if (role !== 'assistant') continue;
    const said = spoke(content);
    if (!Array.isArray(calls) || !calls.length) {
      if (said) quiet = 0;
      continue;
    }
    if (calls.some((call) => toolName(call) === START)) return body;
    rounds++;
    quiet = said || calls.some((call) => toolName(call) === SAY) ? 0 : quiet + 1;
  }
  const note =
    background && rounds >= LONG_TURN_ROUNDS
      ? LONG_TURN_NOTE
      : narrated && quiet >= PROGRESS_ROUNDS
        ? PROGRESS_NOTE
        : null;
  if (!note) return body;
  return { ...body, messages: [...messages, { role: 'system', content: note }] };
}
