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
 *
 * Every protocol the engine uses with tools carries them, each where it takes
 * the service's words at the end of a request: a system message for chat
 * completions, a developer message for Responses, and for Messages a text
 * block after the tool results of the last user message, since Anthropic
 * takes no system message there. Whatever came before stays byte for byte as
 * it was, so the provider's cached prefix still matches; the gateway's own
 * cache breakpoint is kept off the note (`caching.ts`), because the next
 * request will not carry it.
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

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** A tool's or a tool call's name: nested under `function` in chat completions, its own field elsewhere. */
const toolName = (tool: unknown): string | undefined => {
  const entry = record(tool);
  if (!entry) return undefined;
  const name = record(entry.function)?.name ?? entry.name;
  return typeof name === 'string' ? name : undefined;
};

/** Words the model wrote to the person in this message, outside its tool calls. */
const spoke = (content: unknown): boolean => {
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const { type, text } = record(part) ?? {};
    return (
      (type === 'text' || type === 'output_text') &&
      typeof text === 'string' &&
      text.trim().length > 0
    );
  });
};

/** One step the model took: whether it said anything to the person, and the tools it called. */
type Step = { said: boolean; calls: (string | undefined)[] };

/** Everything after the person's latest message, from the index past it. */
const sinceLast = (list: unknown[], person: (entry: Record<string, unknown>) => boolean) => {
  let from = 0;
  list.forEach((item, index) => {
    const entry = record(item);
    if (entry && person(entry)) from = index + 1;
  });
  return list.slice(from).map(record);
};

/** The steps of the current turn, in each protocol's own shape. */
function turnSteps(list: unknown[], protocol: GatewayProtocol): Step[] {
  if (protocol === 'responses') {
    // A step's calls come as separate items, its words as a message beside
    // them, and its results after them all.
    const steps: Step[] = [];
    let step: Step = { said: false, calls: [] };
    for (const item of sinceLast(list, (entry) => entry.role === 'user')) {
      if (item?.role === 'assistant') step.said ||= spoke(item.content);
      else if (item?.type === 'function_call') step.calls.push(toolName(item));
      else if (item?.type === 'function_call_output' && step.calls.length) {
        steps.push(step);
        step = { said: false, calls: [] };
      }
    }
    if (step.said || step.calls.length) steps.push(step);
    return steps;
  }
  // In Messages a step's results come back in a user message, so only a user
  // message with no tool result in it is the person's.
  const person = (entry: Record<string, unknown>) =>
    entry.role === 'user' &&
    (protocol !== 'messages' ||
      !Array.isArray(entry.content) ||
      !entry.content.some((part) => record(part)?.type === 'tool_result'));
  return sinceLast(list, person)
    .filter((message) => message?.role === 'assistant')
    .map((message) => {
      const calls =
        protocol === 'messages'
          ? Array.isArray(message?.content)
            ? message.content.filter((part) => record(part)?.type === 'tool_use')
            : []
          : Array.isArray(message?.tool_calls)
            ? message.tool_calls
            : [];
      return { said: spoke(message?.content), calls: calls.map(toolName) };
    });
}

/** The request with the note at its end, where this protocol takes it; null where it cannot go. */
function noted(
  body: Record<string, unknown>,
  protocol: GatewayProtocol,
  list: unknown[],
  note: string,
): Record<string, unknown> | null {
  if (protocol === 'chat/completions')
    return { ...body, messages: [...list, { role: 'system', content: note }] };
  // A developer message, as `turn-notes.ts` sends: a system message in the
  // middle of a Responses conversation can be refused.
  if (protocol === 'responses')
    return { ...body, input: [...list, { role: 'developer', content: note }] };
  // After the tool results of the last user message: a step's results come
  // before anything else in it, and nothing goes between a call and its result.
  const last = record(list.at(-1));
  if (last?.role !== 'user' || !Array.isArray(last.content)) return null;
  return {
    ...body,
    messages: [
      ...list.slice(0, -1),
      { ...last, content: [...last.content, { type: 'text', text: note }] },
    ],
  };
}

/** A text block holding one of these notes, which only the request it was added to carries. */
export const isLongTurnNote = (block: unknown): boolean => {
  const entry = record(block);
  return entry?.type === 'text' && (entry.text === LONG_TURN_NOTE || entry.text === PROGRESS_NOTE);
};

/** The request, with a note added when its turn has run long or gone quiet; otherwise the same body. */
export function withLongTurnNote(
  body: Record<string, unknown>,
  protocol: GatewayProtocol,
): Record<string, unknown> {
  const list = protocol === 'responses' ? body.input : body.messages;
  const { tools } = body;
  if (!Array.isArray(list) || !Array.isArray(tools)) return body;
  const offers = (name: string) => tools.some((tool) => toolName(tool) === name);
  const background = offers(START);
  const narrated = offers(SAY);
  if (!background && !narrated) return body;
  let rounds = 0;
  // Rounds since the person was last told anything.
  let quiet = 0;
  for (const { said, calls } of turnSteps(list, protocol)) {
    if (!calls.length) {
      if (said) quiet = 0;
      continue;
    }
    if (calls.includes(START)) return body;
    rounds++;
    quiet = said || calls.includes(SAY) ? 0 : quiet + 1;
  }
  const note =
    background && rounds >= LONG_TURN_ROUNDS
      ? LONG_TURN_NOTE
      : // A note of the service's that already follows the latest step, such
        // as `turn-notes.ts` asking for a line after a quiet stretch, is the
        // update this request asks for: a second ask beside it would only
        // repeat it.
        narrated && quiet >= PROGRESS_ROUNDS && !endsOnNote(list, protocol)
        ? PROGRESS_NOTE
        : null;
  if (!note) return body;
  return noted(body, protocol, list, note) ?? body;
}

/** The request already ends on words of the service's, after the latest step's results. */
function endsOnNote(list: unknown[], protocol: GatewayProtocol): boolean {
  const last = record(list.at(-1));
  if (protocol === 'chat/completions') return last?.role === 'system';
  if (protocol === 'responses') return last?.role === 'developer' || last?.role === 'system';
  const content = last?.role === 'user' && Array.isArray(last.content) ? last.content : [];
  return (
    record(content.at(-1))?.type === 'text' &&
    content.some((part) => record(part)?.type === 'tool_result')
  );
}
