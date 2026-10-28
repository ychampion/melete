/**
 * The look a browser fill, click or select returns when it stays on its page:
 * the page as it is now, what the step returned before when the page cannot be
 * observed, and a person's takeover said so rather than hidden.
 */
import { expect, test } from 'bun:test';
import {
  type BrowserCommandResult,
  observedAfterStep,
  TAKEN_OVER_AFTER_STEP,
} from './controller.ts';
import { BrowserFault } from './sessions.ts';

const unobserved: BrowserCommandResult = {
  session_id: 'brws_1',
  control_epoch: 3,
  result: { changed: false },
};
const now = () => ({ id: 'brws_1', control_epoch: 4 });

test('a step that stays on its page returns the page as it is after it', async () => {
  const observed: BrowserCommandResult = {
    session_id: 'brws_1',
    control_epoch: 3,
    result: { submit_intents: [] },
  };
  expect(await observedAfterStep(async () => observed, now, unobserved)).toBe(observed);
});

test('a step that ran onto a page that cannot be observed is done, and says why it was not seen', async () => {
  // A click that went to another page, and a submit whose form was sent.
  for (const ran of [
    { ...unobserved, result: { changed: true } },
    { ...unobserved, result: { changed: true, commit_status: 200 } },
  ])
    for (const [reason, why] of [
      ['sensitive_input_require_takeover', 'a field for a code, a card or another secret'],
      ['observation_too_large', 'too large'],
      ['worker_unavailable', 'worker_unavailable'],
    ] as const) {
      const done = await observedAfterStep(
        async () => {
          throw new BrowserFault(reason);
        },
        now,
        ran,
      );
      expect(done).toMatchObject({
        session_id: 'brws_1',
        control_epoch: 3,
        result: { ...ran.result, observed: false, not_observed: reason },
      });
      const note = String(done.result?.note);
      expect(note).toContain('The step ran');
      expect(note).toContain('do not repeat it');
      expect(note).toContain(why);
    }
});

test('a person who took the browser during the step is said so, with the epoch they hold', async () => {
  expect(
    await observedAfterStep(
      async () => {
        throw new BrowserFault('human_control');
      },
      now,
      unobserved,
    ),
  ).toEqual({
    session_id: 'brws_1',
    control_epoch: 4,
    result: { changed: false, human_control: true, note: TAKEN_OVER_AFTER_STEP },
  });
});

test('a look that fails in any other way leaves the step done, and says the page was not seen', async () => {
  const done = await observedAfterStep(
    async () => {
      throw new Error('Execution context was destroyed, most likely because of a navigation');
    },
    now,
    { ...unobserved, result: { changed: true } },
  );
  expect(done).toMatchObject({
    session_id: 'brws_1',
    control_epoch: 3,
    result: { changed: true, observed: false, not_observed: 'observe_failed' },
  });
  expect(String(done.result?.note)).toContain('do not repeat it');
  // What the error said is the page's business, not the model's.
  expect(JSON.stringify(done)).not.toContain('Execution context');
});
