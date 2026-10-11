/**
 * Which conversations wait on the person. A job whose send or question waits
 * for a decision cannot go on, whatever its last turn says, so every list that
 * shows a conversation's state reads it from here rather than from the status
 * alone.
 */
import type { Conversation } from './types.ts';

/** The conversations an open permission or question belongs to. */
export function waitingOn(decisions: {
  permissions: { conversation_id: string | null }[];
  questions: { conversation_id: string | null }[];
}): Set<string> {
  const ids = new Set<string>();
  for (const decision of [...decisions.permissions, ...decisions.questions])
    if (decision.conversation_id) ids.add(decision.conversation_id);
  return ids;
}

/** Whether a conversation waits on the person: an open decision, or a turn that asked. */
export function isWaiting(
  conversation: Pick<Conversation, 'id' | 'status' | 'waiting_until'>,
  waiting: ReadonlySet<string>,
): boolean {
  return (
    waiting.has(conversation.id) ||
    (conversation.status === 'needs_you' && !conversation.waiting_until)
  );
}

/** "Waiting until 10:50 PM", or with the day when it is not today. */
export function waitingUntilWords(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (at.toDateString() === new Date(now).toDateString()) return `Waiting until ${time}`;
  if (at.toDateString() === new Date(now + 86_400_000).toDateString())
    return `Waiting until tomorrow at ${time}`;
  return `Waiting until ${at.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`;
}
