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

test('a page that cannot be observed answers what the step returned before', async () => {
  for (const reason of ['sensitive_input_require_takeover', 'observation_too_large'])
    expect(
      await observedAfterStep(
        async () => {
          throw new BrowserFault(reason);
        },
        now,
        unobserved,
      ),
    ).toBe(unobserved);
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

test('anything else still fails the step', async () => {
  await expect(
    observedAfterStep(
      async () => {
        throw new Error('worker gone');
      },
      now,
      unobserved,
    ),
  ).rejects.toThrow('worker gone');
});
