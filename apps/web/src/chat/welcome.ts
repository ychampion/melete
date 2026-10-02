/**
 * A library agent's first chat opens with its welcome: it offers its starter
 * routine, then asks its getting-to-know-you questions one at a time. Where
 * the person has got to is kept for this session, by agent and template, so
 * the welcome reads the same when they come back to it, and it stays above
 * the chat that starts when they send their first message.
 */

export type WelcomeRef = { agentId: string; templateId: string };

export type WelcomeProgress = {
  /** The routine offer: still open, set up, or turned down. */
  routine: 'offered' | 'made' | 'declined';
  /** Each question asked so far, with the answer given, or null when skipped. */
  answers: { id: string; text: string | null }[];
};

const progress = new Map<string, WelcomeProgress>();
const carried = new Map<string, WelcomeRef>();

const keyOf = (ref: WelcomeRef) => `${ref.agentId}:${ref.templateId}`;

export function welcomeProgress(ref: WelcomeRef, hasRoutine: boolean): WelcomeProgress {
  return progress.get(keyOf(ref)) ?? { routine: hasRoutine ? 'offered' : 'declined', answers: [] };
}

export function saveWelcome(ref: WelcomeRef, next: WelcomeProgress) {
  progress.set(keyOf(ref), next);
}

/** The chat that started from a welcome keeps it above its first message. */
export function carryWelcome(conversationId: string, ref: WelcomeRef) {
  carried.set(conversationId, ref);
}

export const carriedWelcome = (conversationId: string): WelcomeRef | null =>
  carried.get(conversationId) ?? null;

/** The step the welcome is on: the routine, a question by its index, or done. */
export function welcomeStep(
  state: WelcomeProgress,
  questions: number,
): { kind: 'routine' } | { kind: 'question'; index: number } | { kind: 'done' } {
  if (state.routine === 'offered') return { kind: 'routine' };
  if (state.answers.length < questions) return { kind: 'question', index: state.answers.length };
  return { kind: 'done' };
}
