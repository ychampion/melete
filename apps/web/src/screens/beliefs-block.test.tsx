/**
 * "Forget and don't learn again" offers how far it reaches in plain words,
 * anything about the subject preselected, and its toast says what was chosen.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockChoice, blockChoices, blockedToast } from './Beliefs.tsx';

test('the choice names the subject, anything about it first and preselected', () => {
  expect(blockChoices('Travel seat').map((choice) => [choice.scope, choice.title])).toEqual([
    ['topic', 'Forget this and anything about Travel seat'],
    ['detail', 'Forget just this detail'],
  ]);
  const html = renderToStaticMarkup(
    <BlockChoice
      belief={{ id: 'k1', topic: 'Travel seat' }}
      onBlock={() => {}}
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
