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
  conversation: Pick<Conversation, 'id' | 'status'>,
  waiting: ReadonlySet<string>,
): boolean {
  return waiting.has(conversation.id) || conversation.status === 'needs_you';
}
