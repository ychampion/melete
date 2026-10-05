import { describe, expect, test } from 'bun:test';
import { type IntentEffectRow, type IntentRow, undoThrough } from './service.ts';

const effect = (actionId: string) => ({ intentId: 'int_1', actionId }) as IntentEffectRow;
const kept = { spaceId: 'sp_1' } as IntentRow;

describe('cancelling through Undo', () => {
  test('newest first, in Undo’s own words, and nothing from inside is shown', async () => {
    const asked: string[] = [];
    const reverse = undoThrough(async (_space, actionId) => {
      asked.push(actionId);
      if (actionId === 'act_2') throw new Error('relation "calendar_tokens" does not exist');
      if (actionId === 'act_3')
        return { status: 'not_available', reason: 'A sent message cannot be recalled.' };
      return { receipt: null };
    });
    const steps = await reverse([effect('act_1'), effect('act_2'), effect('act_3')], kept);
    expect(asked).toEqual(['act_3', 'act_2', 'act_1']);
    expect(steps.map((step) => [step.effect.actionId, step.ok, step.reason ?? null])).toEqual([
      ['act_3', false, 'A sent message cannot be recalled.'],
      ['act_2', false, 'It could not be taken back just now.'],
      ['act_1', true, null],
    ]);
  });
});
