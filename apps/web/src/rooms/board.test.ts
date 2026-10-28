import { describe, expect, test } from 'bun:test';
import { weekOf } from '../screens/Household.tsx';
import { canClaim, detailParts, metaWords, shortName, visibilityWords } from './Board.tsx';
import { type BoardItem, itemWhen, mergeItems } from './board-api.ts';

const item = (over: Partial<BoardItem>): BoardItem =>
  ({
    id: 'rbi_1',
    room_id: 'sp_1',
    room_name: 'Home',
    kind: 'task',
    title: 'Walk the dog',
    detail: null,
    starts_at: null,
    ends_at: null,
    due_at: null,
    assignee: null,
    visibility: 'everyone',
    state: 'open',
    claimed_by: null,
    choices: null,
    answer: null,
    answered_at: null,
    thread_id: null,
    created_by: { principal_id: 'own_1', display_name: 'Melete' },
    created_at: '2026-11-01T10:00:00.000Z',
    updated_at: '2026-11-01T10:00:00.000Z',
    seq: 1,
    can: { claim: true, done: true, answer: false },
    ...over,
  }) as BoardItem;

describe('the board on the web', () => {
  test('says who sees an item in plain words', () => {
    expect(visibilityWords(item({}))).toBe('Everyone in the room');
    expect(visibilityWords(item({ visibility: 'owners' }))).toBe('Owners only');
    expect(
      visibilityWords(
        item({
          visibility: 'assignee',
          assignee: { principal_id: 'own_2', display_name: 'Bob <K3F9Q>' },
        }),
      ),
    ).toBe('Bob and the owners');
    expect(shortName('Bob <K3F9Q>')).toBe('Bob');
  });

  test('says the reader once when the item is theirs', () => {
    const bob = { principal_id: 'own_2', display_name: 'Bob <K3F9Q>' };
    const theirs = item({ visibility: 'assignee', assignee: bob });
    expect(metaWords(theirs, 'own_2')).toBe('For you · The owners see it too');
    expect(visibilityWords(theirs, 'own_2')).toBe('You and the owners');
    expect(metaWords(theirs, 'own_1')).toBe('For Bob · Bob and the owners');
    expect(metaWords(item({ assignee: bob }), 'own_2')).toBe('For you · Everyone in the room');
    expect(metaWords(item({}), 'own_2')).toBe('Everyone in the room');
  });

  test('never offers to claim a task the reader already has', () => {
    const bob = { principal_id: 'own_2', display_name: 'Bob <K3F9Q>' };
    expect(canClaim(item({ assignee: bob }), 'own_2')).toBe(false);
    expect(canClaim(item({ assignee: bob }), 'own_3')).toBe(true);
    expect(canClaim(item({}), 'own_2')).toBe(true);
    expect(canClaim(item({ state: 'claimed', claimed_by: bob }), 'own_2')).toBe(false);
    // While the reader is being read, Claim waits; if they cannot be read, the service decides.
    expect(canClaim(item({ assignee: bob }), undefined)).toBe(false);
    expect(canClaim(item({}), undefined)).toBe(false);
    expect(canClaim(item({ assignee: bob }), null)).toBe(true);
    expect(canClaim(item({ can: { claim: false, done: true, answer: false } }), 'own_3')).toBe(
      false,
    );
  });

  test('a web address in a detail becomes a short link to its site', () => {
    expect(detailParts('Notes: https://www.docs.example.com/d/abc?x=1, then call.')).toEqual([
      { text: 'Notes: ' },
      { href: 'https://www.docs.example.com/d/abc?x=1', label: 'docs.example.com' },
      { text: ', then call.' },
    ]);
    expect(detailParts('(see http://example.org/a_(b))')).toEqual([
      { text: '(see ' },
      { href: 'http://example.org/a_(b)', label: 'example.org' },
      { text: ')' },
    ]);
    // Only http and https: anything else stays text.
    expect(detailParts('javascript:alert(1) and ftp://example.org/x')).toEqual([
      { text: 'javascript:alert(1) and ftp://example.org/x' },
    ]);
    expect(detailParts('No links here.')).toEqual([{ text: 'No links here.' }]);
  });

  test('keeps the newest version of each item as changes arrive', () => {
    const first = item({ seq: 4 });
    const older = item({ seq: 2, state: 'claimed' });
    const newer = item({ seq: 6, state: 'done' });
    expect(mergeItems([first], [older])).toEqual([first]);
    expect(mergeItems([first], [newer, item({ id: 'rbi_2', seq: 7 })]).map((x) => x.state)).toEqual(
      ['done', 'open'],
    );
  });

  test('places an item on its start, else its due time', () => {
    expect(itemWhen(item({ due_at: '2026-11-03T09:00:00.000Z' }))).toBe('2026-11-03T09:00:00.000Z');
    expect(
      itemWhen(item({ starts_at: '2026-11-02T09:00:00.000Z', due_at: '2026-11-03T09:00:00.000Z' })),
    ).toBe('2026-11-02T09:00:00.000Z');
  });

  test('a week starts on Monday and its window covers every day of it', () => {
    const week = weekOf(new Date('2026-10-28T12:00:00Z'), 'UTC', 0);
    expect(week.days.map((day) => day.key)).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ]);
    expect(week.from.toISOString() <= '2026-10-26T00:00:00.000Z').toBe(true);
    expect(week.to.toISOString() >= '2026-11-02T00:00:00.000Z').toBe(true);
    expect(weekOf(new Date('2026-10-28T12:00:00Z'), 'UTC', 1).days[0]?.key).toBe('2026-11-02');
  });
});
