import { expect, test } from 'bun:test';
import { DEFAULT_STARTERS } from '@melete/contracts';
import { loadEnv, readEnv } from '../env.ts';
import { startersFromSetting } from './starters.ts';

const weather = {
  id: 'weather',
  label: 'Weekend weather',
  text: 'What will the weather be like in {city} this weekend?',
  icon: 'sparkles',
  capability: 'research',
} as const;

test('unset, the built-in list; set, the operator’s own', () => {
  expect(startersFromSetting(undefined)).toBe(DEFAULT_STARTERS);
  expect(startersFromSetting('  ')).toBe(DEFAULT_STARTERS);
  expect(startersFromSetting(JSON.stringify([weather]))).toEqual([weather]);
});

test('a list that does not parse or fit says why', () => {
  expect(() => startersFromSetting('[{')).toThrow('MELETE_STARTERS must be a JSON array');
  expect(() => startersFromSetting('{}')).toThrow('MELETE_STARTERS is not a valid list');
  expect(() => startersFromSetting(JSON.stringify([{ ...weather, icon: 'rocket' }]))).toThrow(
    'at 0.icon',
  );
  expect(() => startersFromSetting(JSON.stringify([weather, weather]))).toThrow(
    'Each starter needs its own id.',
  );
});

test('the service will not start on a broken list', () => {
  expect(readEnv({ MELETE_STARTERS: 'not json' }).ok).toBe(false);
  expect(readEnv({ MELETE_STARTERS: JSON.stringify([{ ...weather, label: '' }]) }).ok).toBe(false);
  expect(loadEnv({ MELETE_STARTERS: JSON.stringify([weather]) }).MELETE_STARTERS).toBe(
    JSON.stringify([weather]),
  );
  expect(loadEnv({ MELETE_STARTERS: '' }).MELETE_STARTERS).toBeUndefined();
});
