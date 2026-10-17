/**
 * Where a conversation's work stands, in a few words for the chat's header:
 * working, waiting on the person, waiting until a time, paused or stopped.
 * While the work is under way and nothing has come from it for a while, it
 * says so plainly, with how long, rather than going on saying "Working".
 */
import type { Conversation } from '../experience/types.ts';
import { waitingUntilWords } from '../experience/waiting.ts';

/** How long a turn may go with nothing from the work before the header says so. */
export const QUIET_AFTER_MS = 20_000;

export type HeadState = {
  tone: 'working' | 'quiet' | 'waiting' | 'stopped';
  words: string;
};

const UNDER_WAY: readonly Conversation['status'][] = ['queued', 'working', 'streaming', 'stalled'];

/** "34 s", "2 min", "1 h 5 min". */
export function quietFor(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''}`;
}

/**
 * The header's state, or null when there is nothing to say: a conversation
 * that is ready, or whose last turn is done.
 */
export function headState(
  conversation: Pick<Conversation, 'status' | 'waiting_until'> | null,
  lastEventAt: number | null,
  now: number,
  /** Whether the page is following the work's stream right now. */
  live = true,
): HeadState | null {
  if (!conversation) return null;
  const { status } = conversation;
  if (conversation.waiting_until)
    return { tone: 'waiting', words: waitingUntilWords(conversation.waiting_until, now) };
  if (UNDER_WAY.includes(status)) {
    const quiet = lastEventAt === null ? 0 : now - lastEventAt;
    // While the stream is down the page cannot see progress, so it does not
    // claim there is none: the work may be moving where it cannot look.
    if (!live && quiet >= QUIET_AFTER_MS) return { tone: 'quiet', words: 'Reconnecting' };
    if (status === 'stalled' || quiet >= QUIET_AFTER_MS)
      return {
        tone: 'quiet',
        words:
          quiet >= QUIET_AFTER_MS ? `No progress for ${quietFor(quiet)}` : 'No progress lately',
      };
    return { tone: 'working', words: status === 'queued' ? 'Starting' : 'Working' };
  }
  switch (status) {
    case 'needs_you':
      return { tone: 'waiting', words: 'Waiting for you' };
    case 'paused':
      return { tone: 'stopped', words: 'Paused' };
    case 'stopped':
      return { tone: 'stopped', words: 'Stopped' };
    case 'failed':
      return { tone: 'stopped', words: 'Stopped without finishing' };
    default:
      return null;
  }
}
