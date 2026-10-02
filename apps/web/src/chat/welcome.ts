/**
 * A library agent's first chat opens with its welcome: it offers its starter
 * routine, then asks its getting-to-know-you questions one at a time. The
 * chat's link names the template, so the welcome stays above the chat once it
 * starts and after a reload. What the person said yes to is read back from
 * the service (the routine, the answers saved to memory); what they turned
 * down or skipped rides in the chat's link, since the service keeps nothing
 * for a no.
 */

export type WelcomeRef = { agentId: string; templateId: string };

export type WelcomeProgress = {
  /** The routine offer: still open, set up, or turned down. */
  routine: 'offered' | 'made' | 'declined';
  /** Each question asked so far, with the answer given, or null when skipped. */
  answers: { id: string; text: string | null }[];
};

const progress = new Map<string, WelcomeProgress>();

const keyOf = (ref: WelcomeRef) => `${ref.agentId}:${ref.templateId}`;

/** Where the person got to in this session, if anywhere. */
export const sessionWelcome = (ref: WelcomeRef): WelcomeProgress | null =>
  progress.get(keyOf(ref)) ?? null;

export function saveWelcome(ref: WelcomeRef, next: WelcomeProgress) {
  progress.set(keyOf(ref), next);
}

/** What the chat's link keeps: a routine turned down and the questions skipped. */
export function welcomeQuery(templateId: string, state: WelcomeProgress): string {
  const query = new URLSearchParams({ welcome: templateId });
  if (state.routine === 'declined') query.set('routine', 'no');
  const skipped = state.answers.filter((item) => item.text === null).map((item) => item.id);
  if (skipped.length) query.set('skipped', skipped.join(','));
  return query.toString();
}

/**
 * How the memory list names a `pref.<purpose>.<name>` key: "purpose: name",
 * with dashes as spaces, the same words the service and the mock use.
 */
export function prefLabel(key: string): string {
  const [, subject = '', field = ''] = key.split('.');
  return `${subject.replaceAll('-', ' ')}: ${field.replaceAll('-', ' ')}`;
}

/**
 * The welcome as the service and the chat's link hold it: the routine is set
 * up when one with its title runs as this agent, a question is answered when
 * its key holds a saved detail, and skipped when the link says so. Questions
 * are asked in order, so the first one neither answered nor skipped is next.
 */
export function restoreWelcome(input: {
  hasRoutine: boolean;
  routineMade: boolean;
  routineDeclined: boolean;
  questions: { id: string; memory_key: string }[];
  /** Saved details by the label the memory list shows for their key. */
  saved: ReadonlyMap<string, string>;
  skipped: ReadonlySet<string>;
}): WelcomeProgress {
  const routine = !input.hasRoutine
    ? 'declined'
    : input.routineMade
      ? 'made'
      : input.routineDeclined
        ? 'declined'
        : 'offered';
  const answers: WelcomeProgress['answers'] = [];
  for (const question of input.questions) {
    const text = input.saved.get(prefLabel(question.memory_key));
    if (text !== undefined) answers.push({ id: question.id, text });
    else if (input.skipped.has(question.id)) answers.push({ id: question.id, text: null });
    else break;
  }
  return { routine, answers };
}

/** The step the welcome is on: the routine, a question by its index, or done. */
export function welcomeStep(
  state: WelcomeProgress,
  questions: number,
): { kind: 'routine' } | { kind: 'question'; index: number } | { kind: 'done' } {
  if (state.routine === 'offered') return { kind: 'routine' };
  if (state.answers.length < questions) return { kind: 'question', index: state.answers.length };
  return { kind: 'done' };
}
