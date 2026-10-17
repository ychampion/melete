import { expect, test } from 'bun:test';
import { DEFAULT_STARTERS } from '@melete/contracts';
import type { Sql } from 'postgres';
import { loadEnv, readEnv } from '../env.ts';
import { StarterService, startersFromSetting } from './starters.ts';

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

/** A stand-in for postgres: answers each query by what it reads, and keeps what was asked. */
function fakeSql(rows: { profile?: object; dismissed?: boolean; chats?: number }) {
  const asked: string[] = [];
  const sql = (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    asked.push(text);
    if (text.includes('from experience_profile'))
      return Promise.resolve(rows.profile ? [rows.profile] : []);
    if (text.includes('from starter_dismissal'))
      return Promise.resolve(rows.dismissed ? [{ '?column?': 1 }] : []);
    if (text.includes('from job'))
      return Promise.resolve(Array.from({ length: rows.chats ?? 0 }, () => ({})));
    throw new Error(`unexpected query: ${text}`);
  };
  return { sql: sql as unknown as Sql, asked };
}

test('a space set up before setup was recorded is offered starters, by Home’s own rule', async () => {
  const { sql } = fakeSql({ profile: { time_zone: 'Europe/Lisbon', onboarded_at: null } });
  const checked: [string, boolean][] = [];
  const legacy = new StarterService(sql, DEFAULT_STARTERS, async (spaceId, recorded) => {
    checked.push([spaceId, recorded]);
    return true; // It has an agent the person made.
  });
  const view = await legacy.view('space-1', 'person-1');
  expect(checked).toEqual([['space-1', false]]);
  expect(view.show).toBe(true);
  expect(view.starters.length).toBe(DEFAULT_STARTERS.length);
  // Without that rule the same space would be told setup is not done.
  const bare = await new StarterService(fakeSql({ profile: { onboarded_at: null } }).sql).view(
    'space-1',
    'person-1',
  );
  expect(bare.reason).toBe('not_onboarded');
});

test('starters put away, or setup not done, count no chats', async () => {
  const away = fakeSql({ profile: { onboarded_at: new Date() }, dismissed: true });
  expect(await new StarterService(away.sql).view('s', 'p')).toEqual({
    show: false,
    reason: 'dismissed',
    starters: [],
  });
  expect(away.asked.some((text) => text.includes('from job'))).toBe(false);
  const early = fakeSql({ profile: { onboarded_at: null } });
  expect((await new StarterService(early.sql).view('s', 'p')).reason).toBe('not_onboarded');
  expect(early.asked.some((text) => text.includes('from job'))).toBe(false);
  // Shown or not by the chats, they are counted then.
  const busy = fakeSql({ profile: { onboarded_at: new Date() }, chats: 3 });
  expect((await new StarterService(busy.sql).view('s', 'p')).reason).toBe('has_chats');
  expect(busy.asked.some((text) => text.includes('from job'))).toBe(true);
});
