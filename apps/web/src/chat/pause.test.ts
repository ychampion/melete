import { expect, test } from 'bun:test';
import { pauseOrStop } from './pause.ts';

type Outcome = { data: unknown; error: string | null; unavailable: string | null };
const ok: Outcome = { data: { conversation: {} }, error: null, unavailable: null };
const failed = (error: string): Outcome => ({ data: null, error, unavailable: null });
const cannot = (unavailable: string): Outcome => ({ data: null, error: null, unavailable });

function controls(pause: Outcome, stop: Outcome = ok) {
  const calls: string[] = [];
  return {
    calls,
    pause: async () => {
      calls.push('pause');
      return pause;
    },
    stop: async () => {
      calls.push('stop');
      return stop;
    },
  };
}

test('a pause that takes is left alone', async () => {
  const turn = controls(ok);
  expect(await pauseOrStop(turn)).toEqual({ outcome: 'paused' });
  expect(turn.calls).toEqual(['pause']);
});

test('an assistant that cannot pause is stopped instead', async () => {
  const turn = controls(cannot('This assistant cannot pause and keep its place yet.'));
  expect(await pauseOrStop(turn)).toEqual({ outcome: 'stopped' });
  expect(turn.calls).toEqual(['pause', 'stop']);
});

test('a pause that failed stops nothing and says why', async () => {
  const turn = controls(failed('This turn has changed. Refresh it.'));
  expect(await pauseOrStop(turn)).toEqual({
    outcome: 'failed',
    reason: 'This turn has changed. Refresh it.',
  });
  expect(turn.calls).toEqual(['pause']);
});

test('when stopping fails too, the reason is given', async () => {
  const turn = controls(cannot('This assistant cannot pause.'), failed('Couldn’t reach Melete.'));
  expect(await pauseOrStop(turn)).toEqual({ outcome: 'failed', reason: 'Couldn’t reach Melete.' });
});
