/**
 * "Forget and don't learn again" offers how far it reaches in plain words,
 * anything about the subject preselected, and its toast says what was chosen.
 * Each block listed says the day it was made.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  allowedToast,
  BlockChoice,
  blockChoices,
  blockedToast,
  NotLearningAgain,
} from './Beliefs.tsx';

test('the choice names the subject, anything about it first and preselected', () => {
  expect(blockChoices('Travel seat').map((choice) => [choice.scope, choice.title])).toEqual([
    ['topic', 'Forget this and anything about Travel seat'],
    ['detail', 'Forget just this detail'],
  ]);
  const html = renderToStaticMarkup(
    <BlockChoice
      belief={{ id: 'k1', topic: 'Travel seat' }}
      onBlock={async () => {}}
      onBack={() => {}}
      onCancel={() => {}}
    />,
  );
  const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map(([tag]) => tag);
  expect(radios).toHaveLength(2);
  expect(radios[0]).toContain('value="topic"');
  expect(radios[0]).toContain('checked');
  expect(radios[1]).toContain('value="detail"');
  expect(radios[1]).not.toContain('checked');
  expect(html).toContain('Forget this and anything about Travel seat');
  expect(html).toContain('Other details about Travel seat can still be learned.');
});

test('the toast says how far the block reached', () => {
  expect(blockedToast('Prefers aisle seats', 'Travel seat', 'topic')).toEqual({
    title: 'Forgot “Prefers aisle seats”',
    sub: 'I won’t learn anything about Travel seat again.',
  });
  const detail = blockedToast('Prefers aisle seats', 'Travel seat', 'detail');
  expect(detail.sub).toBe(
    'I won’t learn this detail again. Other details about Travel seat can still be learned.',
  );
  // Never the old wording that read as the whole subject for a detail.
  expect(`${detail.title} ${detail.sub}`).not.toContain('won’t learn it again');
});

test('allowed again, the toast says it plainly for either reach', () => {
  expect(allowedToast({ label: 'Anything about Travel seat', scope: 'topic' })).toBe(
    'I can learn about Travel seat again',
  );
  expect(allowedToast({ label: 'Home city, the detail you forgot', scope: 'detail' })).toBe(
    'I can learn that detail again',
  );
});

test('two details not learned again under one subject are told apart by the day each was forgotten', () => {
  const first = '2026-10-02T10:00:00.000Z';
  const second = '2026-10-09T10:00:00.000Z';
  const day = (at: string) =>
    new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const label = 'Health allergy, the detail you forgot';
  const html = renderToStaticMarkup(
    <NotLearningAgain
      blocks={[
        { id: 'blk_2', label, scope: 'detail', created_at: second },
        { id: 'blk_1', label, scope: 'detail', created_at: first },
      ]}
      onAllowed={() => {}}
    />,
  );
  expect(day(first)).not.toBe(day(second));
  const rows = html.split('class="belief-row"').slice(1);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain(label);
  expect(rows[0]).toContain(day(second));
  expect(rows[1]).toContain(day(first));
  expect(html).toContain('Allow again');
});
