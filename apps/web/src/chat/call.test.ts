import { describe, expect, test } from 'bun:test';
import type { TranscriptTurn } from '../experience/reduce.ts';
import {
  activityOf,
  PROGRESS_FIRST_MS,
  PROGRESS_GAP_MS,
  PROGRESS_STALE_MS,
  type ProgressState,
  progressDue,
  QUEUED,
  queuedMessage,
  quickCommand,
  routeAside,
  STILL_ON_IT,
  STOPPING,
} from './call.ts';

describe('progress words come at natural moments, never in a flood', () => {
  const base: ProgressState = {
    now: 0,
    startedAt: 0,
    lastAt: null,
    steps: 0,
    lastSteps: 0,
    busy: false,
  };
  const at = (change: Partial<ProgressState>) => progressDue({ ...base, ...change });

  test('nothing in the first seconds of a turn, even when a step finishes', () => {
    expect(at({ now: PROGRESS_FIRST_MS - 1, steps: 2 })).toBe(false);
    expect(at({ now: PROGRESS_FIRST_MS, steps: 2 })).toBe(true);
  });

  test('a finished step is the moment; with nothing new there is no word until it is stale', () => {
    expect(at({ now: 20_000, steps: 0 })).toBe(false);
    expect(at({ now: 20_000, steps: 1 })).toBe(true);
    expect(at({ now: PROGRESS_STALE_MS, steps: 0 })).toBe(true);
  });

  test('never sooner than the gap after the last word, however many steps finish', () => {
    const last = 30_000;
    expect(at({ now: last + PROGRESS_GAP_MS - 1, lastAt: last, steps: 9, lastSteps: 1 })).toBe(
      false,
    );
    expect(at({ now: last + PROGRESS_GAP_MS, lastAt: last, steps: 9, lastSteps: 1 })).toBe(true);
    // No new step since the last word: quiet until the work has been silent a while.
    expect(at({ now: last + PROGRESS_GAP_MS, lastAt: last, steps: 3, lastSteps: 3 })).toBe(false);
    expect(at({ now: last + PROGRESS_STALE_MS, lastAt: last, steps: 3, lastSteps: 3 })).toBe(true);
  });

  test('never over the person or over something already being said', () => {
    expect(at({ now: 60_000, steps: 4, busy: true })).toBe(false);
  });

  test('a ten-minute turn with a step every two seconds gets at most one word per gap', () => {
    let lastAt: number | null = null;
    let lastSteps = 0;
    let words = 0;
    for (let now = 0; now <= 600_000; now += 250) {
      const steps = Math.floor(now / 2000);
      if (progressDue({ now, startedAt: 0, lastAt, steps, lastSteps, busy: false })) {
        words += 1;
        lastAt = now;
        lastSteps = steps;
      }
    }
    expect(words).toBeLessThanOrEqual(Math.ceil(600_000 / PROGRESS_GAP_MS));
    expect(words).toBeGreaterThan(10);
  });
});

describe('what is said while the work runs is routed, never dropped', () => {
  test('plain stop, pause and carry on go straight to the controls', () => {
    expect(quickCommand('Stop.')).toBe('stop');
    expect(quickCommand('please cancel that')).toBe('stop');
    expect(quickCommand('Never mind!')).toBe('stop');
    expect(quickCommand('Hold on a second.')).toBe('pause');
    expect(quickCommand('Carry on')).toBe('resume');
  });

  test('anything longer is for the companion, even when it starts with a command word', () => {
    expect(quickCommand('Stop checking the first site and look at the second')).toBeNull();
    expect(quickCommand('Wait, also check the second site')).toBeNull();
    expect(quickCommand('How is it going?')).toBeNull();
  });

  test('an instruction for the work becomes the next message, and that is said', () => {
    expect(
      routeAside('Also check the second site.', { intent: 'steer', say: 'Sure, I did it.' }),
    ).toEqual({ kind: 'queue', text: 'Also check the second site.', say: QUEUED });
  });

  test('with no answer at all, the words are still kept for the next message', () => {
    expect(routeAside('Make it shorter.', null)).toEqual({
      kind: 'queue',
      text: 'Make it shorter.',
      say: QUEUED,
    });
  });

  test('a stop the companion recognises stops the work', () => {
    expect(routeAside('Actually forget the whole thing', { intent: 'stop', say: null })).toEqual({
      kind: 'stop',
      say: STOPPING,
    });
  });

  test('a question is answered out loud; silence is never the answer to the person', () => {
    expect(routeAside('How far along?', { intent: 'talk', say: 'Two of three pages.' })).toEqual({
      kind: 'say',
      say: 'Two of three pages.',
    });
    expect(routeAside('Are you there?', { intent: 'quiet', say: null })).toEqual({
      kind: 'say',
      say: STILL_ON_IT,
    });
  });

  test('everything kept goes as one message, in the order it was said', () => {
    expect(queuedMessage(['Also check the second site.', '  ', 'Make it shorter.'])).toBe(
      'Also check the second site.\nMake it shorter.',
    );
  });
});

describe('the activity the companion is shown', () => {
  const turn = (trail: TranscriptTurn['trail'], live: TranscriptTurn['live']) =>
    ({ trail, live }) as unknown as TranscriptTurn;
  const tool = (id: string, status: string) =>
    ({ id, status, title: id }) as unknown as NonNullable<
      Extract<TranscriptTurn['trail'][number], { type: 'action' }>['tool']
    >;

  test('finished steps, oldest first, and the one under way as now', () => {
    expect(
      activityOf(
        turn(
          [
            { type: 'say', text: 'Looking now.' },
            {
              type: 'action',
              label: 'Read page one',
              meta: '',
              sources: [],
              tool: tool('a', 'done'),
            },
            { type: 'action', label: 'Read page two', meta: '', sources: [] },
            {
              type: 'action',
              label: 'Reading page three',
              meta: '',
              sources: [],
              tool: tool('c', 'running'),
            },
          ],
          { id: 'c', title: 'Reading page three' },
        ),
      ),
    ).toEqual({ now: 'Reading page three', steps: ['Read page one', 'Read page two'] });
  });

  test('no turn, no activity; a long trail keeps its latest steps within the limits', () => {
    expect(activityOf(undefined)).toEqual({ now: null, steps: [] });
    const many = Array.from({ length: 20 }, (_, i) => ({
      type: 'action' as const,
      label: `Step ${i} ${'x'.repeat(300)}`,
      meta: '',
      sources: [],
    }));
    const shown = activityOf(turn(many, null));
    expect(shown.steps).toHaveLength(12);
    expect(shown.steps[0]?.startsWith('Step 8')).toBe(true);
    expect(shown.steps.every((step) => step.length <= 200)).toBe(true);
  });
});
