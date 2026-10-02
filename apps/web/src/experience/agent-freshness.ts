/**
 * When the app reads its agents again. An agent can be made through the API,
 * in another tab or by another device, and the app holds the list it read at
 * sign-in. It reads it again when the person moves to another view or comes
 * back to the window, and whenever something on screen names an agent it does
 * not know: a link to an agent, a chat started with one, or a chat it answers.
 */
import type { Route } from '../router.ts';

type Known = { id: string };
type Answered = { id: string; agent_id: string };

/** The agents the current view and the chat list name. */
export function agentIdsIn(route: Route, conversations: readonly Answered[]): string[] {
  const ids = new Set<string>();
  const [view, target] = route.parts;
  if (view === 'agents' && target && target !== 'new') ids.add(target);
  const asked = route.query.get('agent');
  if (asked) ids.add(asked);
  const open = view === 'chat' && target ? conversations.find((chat) => chat.id === target) : null;
  if (open) ids.add(open.agent_id);
  for (const chat of conversations) ids.add(chat.agent_id);
  return [...ids];
}

/**
 * The named agents this app does not know, live or removed, and has not
 * already read the list again for. An id that is still unknown after that read
 * is not worth another one: it was mistyped, or it is gone.
 */
export function unknownAgentIds(
  ids: readonly string[],
  known: readonly Known[],
  asked: ReadonlySet<string>,
): string[] {
  return ids.filter((id) => !asked.has(id) && !known.some((agent) => agent.id === id));
}

/**
 * One read for a burst of reasons: coming back to a window fires both focus
 * and visibility, and a link opened from elsewhere moves the view as well.
 */
export function throttled(run: () => void, ms: number, now: () => number = Date.now) {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const at = now();
    if (at - last < ms) return;
    last = at;
    run();
  };
}
