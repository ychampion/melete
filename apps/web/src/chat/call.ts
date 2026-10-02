/**
 * The decisions voice mode makes while the work runs, kept apart from the
 * audio so each can be checked on its own:
 *
 * - what the running turn is doing, as the companion is shown it;
 * - whether something said is a plain stop, pause or carry on;
 * - what to do with the companion's answer: say it, stop the work, or keep it
 *   as the next message (nothing said is ever dropped);
 * - when a progress word is due, so updates come at natural moments and never
 *   in a flood.
 */
import type { TranscriptTurn } from '../experience/reduce.ts';
import type { VoiceActivity, VoiceAside } from '../experience/types.ts';

/** Matches the contract: the companion is shown at most this much of the activity. */
const STEPS = 12;
const STEP_CHARACTERS = 200;

const FINISHED = new Set(['done', 'failed', 'unknown']);

const clip = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= STEP_CHARACTERS ? flat : `${flat.slice(0, STEP_CHARACTERS - 1)}…`;
};

/** What the running turn has done and is doing, from its trail. */
export function activityOf(turn: TranscriptTurn | undefined): VoiceActivity {
  if (!turn) return { now: null, steps: [] };
  // A step counts once it has finished; the one under way is `now`.
  const steps = turn.trail
    .flatMap((step) =>
      step.type === 'action' && (!step.tool || FINISHED.has(step.tool.status))
        ? [clip(step.label)]
        : [],
    )
    .filter(Boolean)
    .slice(-STEPS);
  return { now: turn.live ? clip(turn.live.title) || null : null, steps };
}

/** How many steps the running turn has finished: the moments a progress word can follow. */
export const stepsDone = (activity: VoiceActivity): number => activity.steps.length;

export type QuickCommand = 'stop' | 'pause' | 'resume';

const QUICK: [QuickCommand, RegExp][] = [
  [
    'stop',
    /^(please )?(stop|cancel|cancel (it|that)|stop (it|that|working)|never mind|forget it)( please)?$/,
  ],
  ['pause', /^(please )?(pause|hold on|hold it|wait)( please| a (second|moment|minute))?$/],
  ['resume', /^(please )?(carry on|continue|keep going|go on|resume|go ahead)( please)?$/],
];

/**
 * A short, whole utterance that is plainly a stop, pause or carry on. These go
 * straight to the existing controls, with no model in between, so stopping
 * works even when nothing else does. Anything longer is for the companion.
 */
export function quickCommand(heard: string): QuickCommand | null {
  const said = heard
    .toLowerCase()
    .replace(/[.!?,…]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [command, pattern] of QUICK) if (pattern.test(said)) return command;
  return null;
}

/** Said when what was heard is kept for the work to see next. */
export const QUEUED = 'Got it. I’ll pass that on as soon as this part is done.';
/** Said when the companion had nothing to say to something heard. */
export const STILL_ON_IT = 'I’m still on it.';
export const STOPPING = 'Stopping now.';

export type AsideAction =
  | { kind: 'say'; say: string }
  | { kind: 'queue'; text: string; say: string }
  | { kind: 'stop'; say: string };

/**
 * Whether the person's own words ask for the work to stop. The companion's
 * answer is model text, and the model reads what the work brought back from
 * pages and tools, so its `stop` is believed only when this agrees.
 */
export function asksToStop(heard: string): boolean {
  return /\b(stop|stopping|cancel|halt|abort|quit|never mind|forget (it|that|about it|the whole thing))\b/i.test(
    heard,
  );
}

/**
 * What to do with something heard while the work runs, given the companion's
 * answer. There is no way to reach a step already under way, so an instruction
 * for the work becomes the next message, and that is said out loud. With no
 * answer at all, the words are kept the same way: never dropped. A stop the
 * person did not ask for in their own words is kept as their words instead.
 */
export function routeAside(heard: string, answer: VoiceAside | null): AsideAction {
  if (!answer || answer.intent === 'steer') return { kind: 'queue', text: heard, say: QUEUED };
  if (answer.intent === 'stop')
    return asksToStop(heard)
      ? { kind: 'stop', say: STOPPING }
      : { kind: 'queue', text: heard, say: QUEUED };
  if (answer.intent === 'talk' && answer.say) return { kind: 'say', say: answer.say };
  return { kind: 'say', say: STILL_ON_IT };
}

/** The next message made of everything kept while the work ran, in the order it was said. */
export const queuedMessage = (kept: string[]): string =>
  kept
    .map((text) => text.trim())
    .filter(Boolean)
    .join('\n');

/* ---------- progress words ---------- */

/** No word in the first moments of a turn: a quick answer needs none. */
export const PROGRESS_FIRST_MS = 10_000;
/** At least this long between two words, however busy the work is. */
export const PROGRESS_GAP_MS = 25_000;
/** With no new step, a word after this long so the silence is not mistaken for a hang. */
export const PROGRESS_STALE_MS = 60_000;

export type ProgressState = {
  now: number;
  /** When the turn started working. */
  startedAt: number;
  /** When the last progress word, or any answer, was spoken; null for none yet. */
  lastAt: number | null;
  /** Steps finished now, and when the last word was said. */
  steps: number;
  lastSteps: number;
  /** The person is talking, audio is playing, or a word is already being fetched. */
  busy: boolean;
};

/**
 * Whether a progress word is due. A natural moment is a step finishing; a word
 * never interrupts, never comes in the first seconds, and never comes sooner
 * than the gap after the last one.
 */
export function progressDue(state: ProgressState): boolean {
  if (state.busy) return false;
  if (state.now - state.startedAt < PROGRESS_FIRST_MS) return false;
  if (state.lastAt !== null && state.now - state.lastAt < PROGRESS_GAP_MS) return false;
  if (state.steps > state.lastSteps) return true;
  return state.now - (state.lastAt ?? state.startedAt) >= PROGRESS_STALE_MS;
}
